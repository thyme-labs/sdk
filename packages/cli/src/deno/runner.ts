import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { TaskResult } from '@thyme-labs/sdk'
import {
	LIFECYCLE_CALLBACK_NAMES,
	type LifecycleCallbackName,
} from '@thyme-labs/sdk/lifecycle'
import { TASK_RUNTIME_OUTPUT_PREFIXES } from '@thyme-labs/sdk/task-runtime'
import type { Address } from 'viem'
import { getAddress, isAddress } from 'viem'

type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue }

type JsonObject = { [key: string]: JsonValue }

export interface TaskConfig {
	memory: number // MB
	network: boolean
	rpcUrl?: string // RPC URL for public client
	account?: Address // address that will execute returned calls
	env?: Record<string, string> // runtime env loaded from root/task .env files
}

export interface RunResult {
	success: boolean
	result?: TaskResult
	storage?: JsonObject
	logs: string[]
	error?: string
	executionTime?: number // milliseconds
	memoryUsed?: number // bytes
	rpcRequestCount?: number // number of RPC requests made
	/** Names of lifecycle callbacks (`onSuccess`/`onSkip`/`onError`/`onFail`) the task defines. */
	definedCallbacks?: string[]
}

/** The four optional lifecycle callback names a task definition may export. */
export type CallbackName = LifecycleCallbackName

export interface CallbackInvocation {
	name: CallbackName
	payload: unknown
}

// Match the production executable-storage limit (backend lib/executableStorage.ts)
// so storage that the cloud accepts is also accepted by `thyme run` (dev/prod parity).
const STORAGE_MAX_BYTES = 100 * 1024 * 1024
const FORBIDDEN_STORAGE_KEYS = new Set([
	'__proto__',
	'constructor',
	'prototype',
])

/**
 * Escape a string for safe use in JavaScript string literals
 * Prevents command injection attacks
 */
function escapeJsString(str: string): string {
	return str
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t')
		.replace(/\0/g, '\\0')
}

/**
 * Sanitize args to prevent prototype pollution and injection
 * Deep clones the object to remove any prototype chain issues
 */
function sanitizeArgs(args: unknown): unknown {
	if (args === null || args === undefined) return args
	if (typeof args !== 'object') return args

	// Deep clone via JSON to strip prototypes and non-serializable values
	try {
		return JSON.parse(JSON.stringify(args))
	} catch {
		return {}
	}
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).length
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return false
	}
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function validateJsonStorageValue(value: unknown, path: string): void {
	if (value === null) return

	const type = typeof value
	if (type === 'string' || type === 'boolean') return

	if (type === 'number') {
		if (!Number.isFinite(value) || Object.is(value, -0)) {
			throw new Error(`Storage contains an invalid number at ${path}`)
		}
		return
	}

	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			if (value[index] === undefined) {
				throw new Error(`Storage contains undefined at ${path}[${index}]`)
			}
			validateJsonStorageValue(value[index], `${path}[${index}]`)
		}
		return
	}

	if (isPlainObject(value)) {
		for (const [key, item] of Object.entries(value)) {
			if (FORBIDDEN_STORAGE_KEYS.has(key)) {
				throw new Error(`Storage contains forbidden key "${key}" at ${path}`)
			}
			if (item === undefined) {
				throw new Error(`Storage contains undefined at ${path}.${key}`)
			}
			validateJsonStorageValue(item, `${path}.${key}`)
		}
		return
	}

	throw new Error(`Storage contains unsupported value at ${path}`)
}

function normalizeStorage(storage: unknown): JsonObject {
	if (!isPlainObject(storage)) {
		throw new Error('Storage must be a JSON object')
	}
	validateJsonStorageValue(storage, '$')
	const json = JSON.stringify(storage)
	if (byteLength(json) > STORAGE_MAX_BYTES) {
		throw new Error(
			`Storage is too large (${byteLength(json)} bytes, max ${STORAGE_MAX_BYTES})`,
		)
	}
	return JSON.parse(json) as JsonObject
}

const RESERVED_SECRET_KEYS = new Set([
	'THYME_API_URL',
	'THYME_AUTH_TOKEN',
	'RPC_URL',
	'SIMULATE_ACCOUNT',
])
const UNSAFE_SECRET_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function buildSecrets(
	env: Record<string, string> = {},
): Record<string, string> {
	const secrets: Record<string, string> = {}

	for (const [key, value] of Object.entries(env)) {
		if (RESERVED_SECRET_KEYS.has(key) || UNSAFE_SECRET_KEYS.has(key)) {
			continue
		}
		secrets[key] = value
	}

	return secrets
}

function resolveTaskAccount(config: TaskConfig): Address {
	const rawAccount =
		config.account ??
		config.env?.SIMULATE_ACCOUNT ??
		process.env.SIMULATE_ACCOUNT
	if (!rawAccount) {
		throw new Error(
			'SIMULATE_ACCOUNT is required for local task execution (it becomes ctx.account)',
		)
	}
	if (!isAddress(rawAccount)) {
		throw new Error(
			`SIMULATE_ACCOUNT is not a valid Ethereum address: ${rawAccount}`,
		)
	}
	return getAddress(rawAccount)
}

/**
 * Sanitize error messages to prevent information disclosure
 * Removes sensitive paths and internal details
 */
function sanitizeErrorMessage(error: string): string {
	// Remove absolute paths (keep only filename)
	let sanitized = error.replace(/\/[^\s:]+\//g, '.../')

	// Remove stack traces
	sanitized = sanitized.replace(/\s+at\s+.+/g, '')

	// Limit length
	if (sanitized.length > 500) {
		sanitized = `${sanitized.substring(0, 500)}...`
	}

	return sanitized.trim()
}

// Node.js built-in modules that need to be mapped to node: prefix for Deno
const NODE_BUILTINS = [
	'assert',
	'buffer',
	'child_process',
	'cluster',
	'crypto',
	'dgram',
	'dns',
	'events',
	'fs',
	'http',
	'http2',
	'https',
	'net',
	'os',
	'path',
	'perf_hooks',
	'process',
	'querystring',
	'readline',
	'stream',
	'string_decoder',
	'timers',
	'tls',
	'tty',
	'url',
	'util',
	'v8',
	'vm',
	'zlib',
]

/**
 * Build the Deno permission/launch flags shared by every local execution
 * (`run` and callback re-entries alike) — kept in one place so the two paths
 * can never drift apart on what they're allowed to touch.
 *
 * Runs read-only with `--node-modules-dir=manual` so Deno resolves `viem` /
 * `@thyme-labs/sdk` from the project's existing `node_modules` without trying to
 * write a local `node_modules/.deno` (which `auto` does, and which fails under our
 * read-only grant). Read access is scoped to the task folder + `node_modules` +
 * config files — NOT the whole project — so a task can't read sibling secrets.
 */
function buildDenoFlags(
	taskDir: string,
	absoluteProjectRoot: string,
	config: TaskConfig,
): string[] {
	// Create import map to redirect bare Node.js imports to node: prefix
	const importMap: Record<string, string> = {}
	for (const name of NODE_BUILTINS) {
		importMap[name] = `node:${name}`
	}
	const importMapJson = JSON.stringify({ imports: importMap })
	const importMapDataUrl = `data:application/json,${encodeURIComponent(importMapJson)}`

	const denoFlags = ['run', '--no-prompt']
	denoFlags.push(`--import-map=${importMapDataUrl}`)
	denoFlags.push('--node-modules-dir=manual')

	// Grant read ONLY to what module resolution needs — the task's own folder, the
	// project's node_modules, and its package.json / Deno config — NOT the whole
	// project root. This keeps an untrusted or copy-pasted task from reading sibling
	// tasks' .env, the repo .git, or other credentials and exfiltrating them over the
	// network. (Production is tighter still: the sandbox only holds wrapper.js + the
	// bundled task.)
	denoFlags.push(`--allow-read=${taskDir}`)
	denoFlags.push(`--allow-read=${join(absoluteProjectRoot, 'node_modules')}`)
	for (const name of [
		'package.json',
		'deno.json',
		'deno.jsonc',
		'tsconfig.json',
	]) {
		const configPath = join(absoluteProjectRoot, name)
		if (existsSync(configPath)) {
			denoFlags.push(`--allow-read=${configPath}`)
		}
	}

	// Add memory limit if specified
	if (config.memory) {
		denoFlags.push(`--v8-flags=--max-old-space-size=${config.memory}`)
	}

	// Conditionally allow network (similar to allowNet in @deno/sandbox)
	if (config.network) {
		denoFlags.push('--allow-net')
	}

	// Execute inline wrapper via stdin (similar to Gelato's approach)
	denoFlags.push('-')

	return denoFlags
}

/**
 * Build the JS preamble shared by every local execution: imports the task,
 * patches `JSON.stringify` to be BigInt-safe, defines the local `Logger` /
 * storage-validation helpers, and constructs `context` (the `ctx` a task's
 * `run` and every callback receive). Factored out so the run phase and the
 * callback-simulation phase can never build `ctx` differently by accident.
 */
function buildContextPreamble(
	safeTaskPath: string,
	safeAccount: string,
	safeArgsJson: string,
	safeSecretsJson: string,
	safeStorageJson: string,
	safeRpcUrl: string,
): string {
	return `
import task from '${safeTaskPath}';
// Resolve viem from the project's own node_modules (same instance the task uses),
// so ctx.client never skews from the task's viem version. Production parity is
// driven by the version the project pins (see \`thyme init\` scaffold).
import { createPublicClient, http } from 'viem';

// Match the production wrapper: make JSON.stringify BigInt-safe so a task that
// serializes viem bigints behaves identically locally and in the cloud, instead
// of throwing "Do not know how to serialize a BigInt" only under \`thyme run\`.
const originalStringify = JSON.stringify;
JSON.stringify = (value, replacer, space) => {
	const toStr = (val) => typeof val === 'bigint' ? val.toString() : val;
	// Array replacer = a key allowlist; it has no value transform, so preserve it
	// verbatim (turning it into a function would silently drop its key filtering).
	if (Array.isArray(replacer)) {
		return originalStringify(value, replacer, space);
	}
	// Function replacer: run the user's replacer first, then make bigints safe.
	if (typeof replacer === 'function') {
		return originalStringify(value, (key, val) => toStr(replacer(key, val)), space);
	}
	return originalStringify(value, (key, val) => toStr(val), space);
};

// Logger for local development - prints directly to console
// (In production, the logger outputs with __THYME_LOG__ prefix for capture)
class Logger {
	info(message) {
		console.log('[INFO]', message);
	}

	warn(message) {
		console.log('[WARN]', message);
	}

	error(message) {
		console.log('[ERROR]', message);
	}
}

// Create RPC request counter
let rpcRequestCount = 0;

// Wrap the http transport to count requests
const countingHttp = (url) => {
	const baseTransport = http(url);
	return (config) => {
		const transport = baseTransport(config);
		return {
			...transport,
			request: async (params) => {
				rpcRequestCount++;
				return transport.request(params);
			},
		};
	};
};

// Lazily create the public client on first access. With viem 2.46+, http()
// throws at construction when no RPC URL is set, so eager creation would break a
// task that never touches ctx.client whenever RPC_URL is unset. A getter defers
// that: client-less tasks always run; tasks that use ctx.client without RPC_URL
// get viem's clear "No URL provided" error. (Production always sets RPC_URL.)
let _client;
function getClient() {
	if (!_client) {
		_client = createPublicClient({ transport: countingHttp(${safeRpcUrl}) });
	}
	return _client;
}

function isPlainObject(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

const forbiddenStorageKeys = new Set(['__proto__', 'constructor', 'prototype']);

function assertJsonStorage(value, path = '$') {
	if (value === null) return;
	const type = typeof value;
	if (type === 'string' || type === 'boolean') return;
	if (type === 'number') {
		if (!Number.isFinite(value) || Object.is(value, -0)) {
			throw new Error('Storage contains an invalid number at ' + path);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			if (value[index] === undefined) {
				throw new Error('Storage contains undefined at ' + path + '[' + index + ']');
			}
			assertJsonStorage(value[index], path + '[' + index + ']');
		}
		return;
	}
	if (isPlainObject(value)) {
		for (const [key, item] of Object.entries(value)) {
			if (forbiddenStorageKeys.has(key)) {
				throw new Error('Storage contains forbidden key "' + key + '" at ' + path);
			}
			if (item === undefined) {
				throw new Error('Storage contains undefined at ' + path + '.' + key);
			}
			assertJsonStorage(item, path + '.' + key);
		}
		return;
	}
	throw new Error('Storage contains unsupported value at ' + path);
}

const context = {
	account: ${safeAccount},
	args: ${safeArgsJson},
	get client() {
		return getClient();
	},
	logger: new Logger(),
	secrets: ${safeSecretsJson},
	storage: ${safeStorageJson},
};
`
}

/**
 * Run a task in Deno sandbox - similar to Gelato's w3f test and @deno/sandbox
 * Creates an isolated Deno process with controlled permissions.
 *
 * Also runs the task's `onSkip`/`onError` callbacks inline when defined, exactly
 * as the production wrapper does (they're known synchronously — no on-chain
 * result needed). `onSuccess`/`onFail` need a real submission outcome, which
 * `thyme run` never produces; use `runCallbackInDeno` with a fabricated payload
 * (`--simulate-callbacks`) to exercise those locally.
 */
export async function runInDeno(
	taskPath: string,
	args: unknown,
	config: TaskConfig,
	projectRoot: string,
	storage: unknown = {},
): Promise<RunResult> {
	const taskDir = dirname(resolve(taskPath))
	const absoluteTaskPath = resolve(taskPath)
	const absoluteProjectRoot = resolve(projectRoot)

	// Escape path for safe JavaScript string interpolation
	const safeTaskPath = escapeJsString(absoluteTaskPath)

	// Sanitize args to prevent prototype pollution
	const safeArgs = sanitizeArgs(args)
	let safeStorage: JsonObject
	try {
		safeStorage = normalizeStorage(storage)
	} catch (err) {
		return {
			success: false,
			logs: [],
			error: sanitizeErrorMessage(
				err instanceof Error ? err.message : String(err),
			),
		}
	}

	const runtimeEnv = config.env ?? {}
	let account: Address
	try {
		account = resolveTaskAccount(config)
	} catch (err) {
		return {
			success: false,
			logs: [],
			error: sanitizeErrorMessage(
				err instanceof Error ? err.message : String(err),
			),
		}
	}
	const safeSecrets = JSON.stringify(buildSecrets(runtimeEnv))
	const safeStorageJson = JSON.stringify(safeStorage)

	// Safely serialize RPC URL
	const rpcUrl = config.rpcUrl ?? runtimeEnv.RPC_URL
	const safeRpcUrl = rpcUrl ? JSON.stringify(rpcUrl) : 'undefined'

	const denoFlags = buildDenoFlags(taskDir, absoluteProjectRoot, config)

	const execScript = `${buildContextPreamble(
		safeTaskPath,
		JSON.stringify(account),
		JSON.stringify(safeArgs),
		safeSecrets,
		safeStorageJson,
		safeRpcUrl,
	)}
// Runtime probe of which lifecycle callbacks this task defines. Emitted before
// \`run\` so it survives the error path too — matches the production wrapper.
const definedCallbacks = ${JSON.stringify(LIFECYCLE_CALLBACK_NAMES)}.filter(
	(name) => typeof task[name] === 'function',
);
console.log(${JSON.stringify(TASK_RUNTIME_OUTPUT_PREFIXES.callbacks)} + JSON.stringify(definedCallbacks));

try {
	// Track execution time and memory
	const startTime = performance.now();
	const startMemory = Deno.memoryUsage().heapUsed;

	const result = await task.run(context);
	if (!isPlainObject(context.storage)) {
		throw new Error('Storage must be a JSON object');
	}
	assertJsonStorage(context.storage);

	if (!result.canExec && typeof task.onSkip === 'function') {
		try {
			await task.onSkip(context, { message: result.message ?? '' });
		} catch (callbackError) {
			console.log(
				'[ERROR]',
				'onSkip callback threw:',
				callbackError instanceof Error ? callbackError.message : String(callbackError),
			);
		}
		if (!isPlainObject(context.storage)) {
			throw new Error('Storage must be a JSON object');
		}
		assertJsonStorage(context.storage);
	}

	const endTime = performance.now();
	const endMemory = Deno.memoryUsage().heapUsed;

	const executionTime = endTime - startTime;
	// Ensure memory measurement is non-negative (GC can cause negative values)
	const memoryUsed = Math.max(0, endMemory - startMemory);

	console.log(${JSON.stringify(TASK_RUNTIME_OUTPUT_PREFIXES.result)} + JSON.stringify(result));
	console.log(${JSON.stringify(TASK_RUNTIME_OUTPUT_PREFIXES.storage)} + JSON.stringify(context.storage));
	console.log(${JSON.stringify(TASK_RUNTIME_OUTPUT_PREFIXES.stats)} + JSON.stringify({ executionTime, memoryUsed, rpcRequestCount }));
} catch (error) {
	if (typeof task.onError === 'function') {
		try {
			await task.onError(context, {
				error: error instanceof Error ? error.message : String(error),
			});
		} catch (callbackError) {
			console.log(
				'[ERROR]',
				'onError callback threw:',
				callbackError instanceof Error ? callbackError.message : String(callbackError),
			);
		}
	}
	console.error('Task execution error:', error instanceof Error ? error.message : String(error));
	Deno.exit(1);
}
`

	return new Promise((resolve) => {
		const proc = spawn('deno', denoFlags, {
			stdio: ['pipe', 'pipe', 'pipe'],
			cwd: taskDir,
			env: {
				...process.env,
				...runtimeEnv,
			},
		})

		let stdout = ''
		let stderr = ''
		const logs: string[] = []

		// Write the execution script to stdin
		proc.stdin?.write(execScript)
		proc.stdin?.end()

		proc.stdout?.on('data', (data) => {
			stdout += data.toString()
		})

		proc.stderr?.on('data', (data) => {
			stderr += data.toString()
		})

		proc.on('close', (code) => {
			if (code !== 0) {
				// Still surface any stdout logging that happened before the throw —
				// most importantly `onError`'s own logging (e.g. "sent the alert"),
				// which otherwise silently vanishes even though it ran.
				for (const line of stdout.trim().split('\n')) {
					if (
						line.trim() &&
						!line.startsWith(TASK_RUNTIME_OUTPUT_PREFIXES.namespace)
					) {
						logs.push(line.trim())
					}
				}
				resolve({
					success: false,
					logs,
					error: sanitizeErrorMessage(
						stderr || `Process exited with code ${code}`,
					),
				})
				return
			}

			try {
				// Extract logs, result, and stats from stdout
				const lines = stdout.trim().split('\n')
				let resultLine: string | undefined
				let storageLine: string | undefined
				let statsLine: string | undefined
				let callbacksLine: string | undefined

				for (const line of lines) {
					if (line.startsWith(TASK_RUNTIME_OUTPUT_PREFIXES.result)) {
						resultLine = line.substring(
							TASK_RUNTIME_OUTPUT_PREFIXES.result.length,
						)
					} else if (line.startsWith(TASK_RUNTIME_OUTPUT_PREFIXES.storage)) {
						storageLine = line.substring(
							TASK_RUNTIME_OUTPUT_PREFIXES.storage.length,
						)
					} else if (line.startsWith(TASK_RUNTIME_OUTPUT_PREFIXES.stats)) {
						statsLine = line.substring(
							TASK_RUNTIME_OUTPUT_PREFIXES.stats.length,
						)
					} else if (line.startsWith(TASK_RUNTIME_OUTPUT_PREFIXES.callbacks)) {
						callbacksLine = line.substring(
							TASK_RUNTIME_OUTPUT_PREFIXES.callbacks.length,
						)
					} else if (line.trim()) {
						logs.push(line.trim())
					}
				}

				if (!resultLine) {
					throw new Error('No result found in output')
				}

				const result = JSON.parse(resultLine) as TaskResult
				const storage = storageLine
					? normalizeStorage(JSON.parse(storageLine))
					: safeStorage
				const stats = statsLine
					? JSON.parse(statsLine)
					: {
							executionTime: undefined,
							memoryUsed: undefined,
							rpcRequestCount: undefined,
						}
				const definedCallbacks = callbacksLine
					? (JSON.parse(callbacksLine) as string[])
					: []

				resolve({
					success: true,
					result,
					storage,
					logs,
					executionTime: stats.executionTime,
					memoryUsed: stats.memoryUsed,
					rpcRequestCount: stats.rpcRequestCount,
					definedCallbacks,
				})
			} catch (error) {
				resolve({
					success: false,
					logs,
					error: sanitizeErrorMessage(
						`Failed to parse result: ${error instanceof Error ? error.message : String(error)}`,
					),
				})
			}
		})

		proc.on('error', (error) => {
			resolve({
				success: false,
				logs,
				error: sanitizeErrorMessage(`Failed to spawn Deno: ${error.message}`),
			})
		})
	})
}

/**
 * Re-enter a task module and invoke a single post-submit lifecycle callback
 * (`onSuccess` or `onFail`) with a caller-supplied payload. `thyme run` never
 * submits a real call, so there is no receipt to react to — this exists solely
 * for `--simulate-callbacks`, which fabricates one to exercise the callback.
 *
 * Mirrors production's phase-2 sandbox re-entry: a fresh process, the same
 * `ctx` shape `run` gets (rebuilt from `args`/`secrets`/`storage`, not carried
 * over from any prior process), and no `__THYME_RESULT__`/stats output — the
 * caller already knows the outcome; there's nothing for the callback to return.
 */
export async function runCallbackInDeno(
	taskPath: string,
	args: unknown,
	config: TaskConfig,
	projectRoot: string,
	storage: unknown,
	callback: CallbackInvocation,
): Promise<RunResult> {
	const taskDir = dirname(resolve(taskPath))
	const absoluteTaskPath = resolve(taskPath)
	const absoluteProjectRoot = resolve(projectRoot)
	const safeTaskPath = escapeJsString(absoluteTaskPath)
	const safeArgs = sanitizeArgs(args)

	let safeStorage: JsonObject
	try {
		safeStorage = normalizeStorage(storage)
	} catch (err) {
		return {
			success: false,
			logs: [],
			error: sanitizeErrorMessage(
				err instanceof Error ? err.message : String(err),
			),
		}
	}

	const runtimeEnv = config.env ?? {}
	let account: Address
	try {
		account = resolveTaskAccount(config)
	} catch (err) {
		return {
			success: false,
			logs: [],
			error: sanitizeErrorMessage(
				err instanceof Error ? err.message : String(err),
			),
		}
	}
	const safeSecrets = JSON.stringify(buildSecrets(runtimeEnv))
	const safeStorageJson = JSON.stringify(safeStorage)
	const rpcUrl = config.rpcUrl ?? runtimeEnv.RPC_URL
	const safeRpcUrl = rpcUrl ? JSON.stringify(rpcUrl) : 'undefined'

	const denoFlags = buildDenoFlags(taskDir, absoluteProjectRoot, config)

	const execScript = `${buildContextPreamble(
		safeTaskPath,
		JSON.stringify(account),
		JSON.stringify(safeArgs),
		safeSecrets,
		safeStorageJson,
		safeRpcUrl,
	)}
try {
	const callbackName = ${JSON.stringify(callback.name)};
	if (typeof task[callbackName] !== 'function') {
		throw new Error('Task does not define ' + callbackName);
	}
	await task[callbackName](context, ${JSON.stringify(callback.payload)});
	if (!isPlainObject(context.storage)) {
		throw new Error('Storage must be a JSON object');
	}
	assertJsonStorage(context.storage);
	console.log(${JSON.stringify(TASK_RUNTIME_OUTPUT_PREFIXES.storage)} + JSON.stringify(context.storage));
} catch (error) {
	console.error('Callback execution error:', error instanceof Error ? error.message : String(error));
	Deno.exit(1);
}
`

	return new Promise((resolve) => {
		const proc = spawn('deno', denoFlags, {
			stdio: ['pipe', 'pipe', 'pipe'],
			cwd: taskDir,
			env: {
				...process.env,
				...runtimeEnv,
			},
		})

		let stdout = ''
		let stderr = ''
		const logs: string[] = []

		proc.stdin?.write(execScript)
		proc.stdin?.end()

		proc.stdout?.on('data', (data) => {
			stdout += data.toString()
		})

		proc.stderr?.on('data', (data) => {
			stderr += data.toString()
		})

		proc.on('close', (code) => {
			if (code !== 0) {
				// Surface any stdout logging the callback did before it threw.
				for (const line of stdout.trim().split('\n')) {
					if (
						line.trim() &&
						!line.startsWith(TASK_RUNTIME_OUTPUT_PREFIXES.namespace)
					) {
						logs.push(line.trim())
					}
				}
				resolve({
					success: false,
					logs,
					error: sanitizeErrorMessage(
						stderr || `Process exited with code ${code}`,
					),
				})
				return
			}

			try {
				const lines = stdout.trim().split('\n')
				let storageLine: string | undefined

				for (const line of lines) {
					if (line.startsWith(TASK_RUNTIME_OUTPUT_PREFIXES.storage)) {
						storageLine = line.substring(
							TASK_RUNTIME_OUTPUT_PREFIXES.storage.length,
						)
					} else if (line.trim()) {
						logs.push(line.trim())
					}
				}

				const storage = storageLine
					? normalizeStorage(JSON.parse(storageLine))
					: safeStorage

				resolve({ success: true, storage, logs })
			} catch (error) {
				resolve({
					success: false,
					logs,
					error: sanitizeErrorMessage(
						`Failed to parse result: ${error instanceof Error ? error.message : String(error)}`,
					),
				})
			}
		})

		proc.on('error', (error) => {
			resolve({
				success: false,
				logs,
				error: sanitizeErrorMessage(`Failed to spawn Deno: ${error.message}`),
			})
		})
	})
}

/**
 * Check if Deno is installed
 */
export async function checkDeno(): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn('deno', ['--version'], { stdio: 'ignore' })
		proc.on('close', (code) => resolve(code === 0))
		proc.on('error', () => resolve(false))
	})
}
