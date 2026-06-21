import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import type { TaskResult } from '@thyme-labs/sdk'

export interface TaskConfig {
	memory: number // MB
	timeout: number // seconds
	network: boolean
	rpcUrl?: string // RPC URL for public client
	env?: Record<string, string> // runtime env loaded from root/task .env files
}

export interface RunResult {
	success: boolean
	result?: TaskResult
	logs: string[]
	error?: string
	executionTime?: number // milliseconds
	memoryUsed?: number // bytes
	rpcRequestCount?: number // number of RPC requests made
}

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

const RESERVED_SECRET_KEYS = new Set([
	'THYME_API_URL',
	'THYME_AUTH_TOKEN',
	'RPC_URL',
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

/**
 * Run a task in Deno sandbox - similar to Gelato's w3f test and @deno/sandbox
 * Creates an isolated Deno process with controlled permissions
 *
 * Deno 2 defaults `nodeModulesDir` to "manual" when a package.json exists; we pass
 * `--node-modules-dir=auto` and allow read on the Thyme project root so tasks can
 * resolve `viem` / `@thyme-labs/sdk` from the repo `node_modules`.
 */
export async function runInDeno(
	taskPath: string,
	args: unknown,
	config: TaskConfig,
	projectRoot: string,
): Promise<RunResult> {
	const taskDir = dirname(resolve(taskPath))
	const absoluteTaskPath = resolve(taskPath)
	const absoluteProjectRoot = resolve(projectRoot)

	// Escape path for safe JavaScript string interpolation
	const safeTaskPath = escapeJsString(absoluteTaskPath)

	// Sanitize args to prevent prototype pollution
	const safeArgs = sanitizeArgs(args)

	const runtimeEnv = config.env ?? {}
	const safeSecrets = JSON.stringify(buildSecrets(runtimeEnv))

	// Safely serialize RPC URL
	const rpcUrl = config.rpcUrl ?? runtimeEnv.RPC_URL
	const safeRpcUrl = rpcUrl ? JSON.stringify(rpcUrl) : 'undefined'

	// Node.js built-in modules that need to be mapped to node: prefix for Deno
	const nodeBuiltins = [
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

	// Create import map to redirect bare Node.js imports to node: prefix
	const importMap: Record<string, string> = {}
	for (const name of nodeBuiltins) {
		importMap[name] = `node:${name}`
	}
	const importMapJson = JSON.stringify({ imports: importMap })
	const importMapDataUrl = `data:application/json,${encodeURIComponent(importMapJson)}`

	const denoFlags = ['run', '--no-prompt']

	// Add import map to redirect bare Node.js imports to node: prefix
	denoFlags.push(`--import-map=${importMapDataUrl}`)

	// Deno 2: restore npm auto behavior (vs default "manual" with package.json)
	denoFlags.push('--node-modules-dir=auto')

	// Read task sources + repo root (node_modules, package.json live here; cwd is taskDir)
	denoFlags.push(`--allow-read=${taskDir}`)
	denoFlags.push(`--allow-read=${absoluteProjectRoot}`)

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

	// Execution wrapper that loads and runs the task
	// Similar to how Gelato's w3f test executes functions
	const execScript = `
import task from '${safeTaskPath}';
import { createPublicClient, http } from 'npm:viem@2.21.54';

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

// Create public client for blockchain reads
const client = createPublicClient({
	transport: countingHttp(${safeRpcUrl}),
});

const context = {
	args: ${JSON.stringify(safeArgs)},
	client,
	logger: new Logger(),
	secrets: ${safeSecrets},
};

try {
	// Track execution time and memory
	const startTime = performance.now();
	const startMemory = Deno.memoryUsage().heapUsed;
	
	const result = await task.run(context);
	
	const endTime = performance.now();
	const endMemory = Deno.memoryUsage().heapUsed;
	
	const executionTime = endTime - startTime;
	// Ensure memory measurement is non-negative (GC can cause negative values)
	const memoryUsed = Math.max(0, endMemory - startMemory);
	
	console.log('__THYME_RESULT__' + JSON.stringify(result));
	console.log('__THYME_STATS__' + JSON.stringify({ executionTime, memoryUsed, rpcRequestCount }));
} catch (error) {
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
				let statsLine: string | undefined

				for (const line of lines) {
					if (line.startsWith('__THYME_RESULT__')) {
						resultLine = line.substring('__THYME_RESULT__'.length)
					} else if (line.startsWith('__THYME_STATS__')) {
						statsLine = line.substring('__THYME_STATS__'.length)
					} else if (line.trim()) {
						logs.push(line.trim())
					}
				}

				if (!resultLine) {
					throw new Error('No result found in output')
				}

				const result = JSON.parse(resultLine) as TaskResult
				const stats = statsLine
					? JSON.parse(statsLine)
					: {
							executionTime: undefined,
							memoryUsed: undefined,
							rpcRequestCount: undefined,
						}

				resolve({
					success: true,
					result,
					logs,
					executionTime: stats.executionTime,
					memoryUsed: stats.memoryUsed,
					rpcRequestCount: stats.rpcRequestCount,
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
 * Check if Deno is installed
 */
export async function checkDeno(): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawn('deno', ['--version'], { stdio: 'ignore' })
		proc.on('close', (code) => resolve(code === 0))
		proc.on('error', () => resolve(false))
	})
}
