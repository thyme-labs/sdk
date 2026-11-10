import { join } from 'node:path'
import { parse as parseEnv } from 'dotenv'
import type { Address } from 'viem'
import {
	BaseError,
	createPublicClient,
	formatEther,
	http,
	isAddress,
	MethodNotFoundRpcError,
	MethodNotSupportedRpcError,
} from 'viem'
import {
	type CallbackInvocation,
	type CallbackName,
	checkDeno,
	runCallbackInDeno,
	runInDeno,
	type TaskConfig,
} from '../deno/runner'
import { PinnedDirectory } from '../utils/confined-files'
import { type EnvMap, getEnv } from '../utils/env'
import { spinner as createSpinner, promptSelect } from '../utils/interactive'
import {
	callPairKey,
	PERMISSIONS_FILE_NAME,
	type PermissionsManifest,
	parsePermissionsManifest,
	resolvePermissions,
} from '../utils/permissions'
import { parseTaskInputs } from '../utils/task-inputs'
import { validateTaskName } from '../utils/tasks'
import {
	clack,
	error,
	info,
	intro,
	log,
	outro,
	pc,
	step,
	warn,
} from '../utils/ui'

interface RunOptions {
	simulate?: boolean
	persist?: boolean
	simulateCallbacks?: boolean
	callback?: string
}

class RunCommandExit extends Error {
	constructor(readonly code: number) {
		super('Run command stopped')
	}
}

export async function runCommand(taskName?: string, options: RunOptions = {}) {
	intro('Thyme CLI - Run Task')
	let project: PinnedDirectory | undefined
	let functionsDirectory: PinnedDirectory | undefined
	try {
		project = await PinnedDirectory.open(process.cwd())
		functionsDirectory = await project.directory('functions')
		await runProjectCommand(taskName, options, project, functionsDirectory)
	} catch (err) {
		if (!(err instanceof RunCommandExit))
			error(err instanceof Error ? err.message : String(err))
		process.exitCode = err instanceof RunCommandExit ? err.code : 1
	} finally {
		await functionsDirectory?.close()
		await project?.close()
	}
}

async function runProjectCommand(
	taskName: string | undefined,
	options: RunOptions,
	project: PinnedDirectory,
	functionsDirectory: PinnedDirectory,
) {
	const rootEnv = parseEnv(
		(await project.read('.env', true, 1024 * 1024)) ?? '',
	)
	const manifestText = await project.read('package.json', true, 1024 * 1024)
	if (manifestText !== undefined) {
		const manifest = JSON.parse(manifestText)
		const dependencies = {
			...manifest?.dependencies,
			...manifest?.devDependencies,
		}
		if (
			!('@thyme-labs/sdk' in dependencies || '@thyme-labs/cli' in dependencies)
		) {
			throw new Error('Not in a Thyme project')
		}
	}

	// Discover tasks if no task name provided
	let finalTaskName = taskName

	// Validate task name if provided via CLI argument
	if (finalTaskName) {
		try {
			validateTaskName(finalTaskName)
		} catch (err) {
			error(err instanceof Error ? err.message : String(err))
			throw new RunCommandExit(1)
		}
	} else {
		const tasks: string[] = []
		for (const name of await functionsDirectory.entries()) {
			let candidate: PinnedDirectory | undefined
			try {
				validateTaskName(name)
				candidate = await functionsDirectory.directory(name)
				const source = await candidate.file('index.ts')
				await source?.close()
				tasks.push(name)
			} catch {
				// Unsafe links and incomplete tasks are not discovery candidates.
			} finally {
				await candidate?.close()
			}
		}

		if (tasks.length === 0) {
			error('No tasks found. Create one with `thyme new`')
			throw new RunCommandExit(1)
		}

		finalTaskName = await promptSelect(
			{
				message: 'Select a task to run:',
				options: tasks.map((task) => ({ value: task, label: task })),
			},
			{
				what: 'A task name',
				hint: `Pass it as an argument: \`thyme run <task>\`. Available: ${tasks.join(', ')}`,
			},
		)
	}

	const taskDirectory = await functionsDirectory.directory(finalTaskName)
	try {
		await runSelectedTask(
			finalTaskName,
			options,
			project,
			taskDirectory,
			rootEnv,
		)
	} finally {
		await taskDirectory.close()
	}
}

async function runSelectedTask(
	finalTaskName: string,
	options: RunOptions,
	project: PinnedDirectory,
	taskDirectory: PinnedDirectory,
	rootEnv: EnvMap,
) {
	const projectRoot = project.path
	const taskPath = join(taskDirectory.path, 'index.ts')
	const storagePath = join(taskDirectory.path, 'storage.json')
	const source = await taskDirectory.file('index.ts')
	await source?.close()

	// Root defaults yield to explicitly supplied process env; task-local values
	// override both. Parsing never changes launcher/host process environment.
	const taskEnv = parseEnv(
		(await taskDirectory.read('.env', true, 1024 * 1024)) ?? '',
	)
	const runtimeEnv = {
		...Object.fromEntries(
			Object.entries(rootEnv).map(([key, value]) => [
				key,
				process.env[key] ?? value,
			]),
		),
		...taskEnv,
	}
	const config: TaskConfig = {
		memory: 128,
		network: true,
		rpcUrl: runtimeEnv.RPC_URL ?? getEnv('RPC_URL'),
		env: runtimeEnv,
		files: { project, task: taskDirectory },
	}
	const { args, storage } = parseTaskInputs(
		await taskDirectory.read('args.json'),
		await taskDirectory.read('storage.json'),
	)

	// Validate all local inputs before checking the runtime dependency, so a
	// malformed file is reported consistently even on a machine without Deno.
	const hasDeno = await checkDeno()
	if (!hasDeno) {
		error(
			'Local runs require Linux, Deno 2.9.6, and Landlock-enabled util-linux setpriv 2.41+. See the CLI README for platform setup.',
		)
		throw new RunCommandExit(1)
	}

	// Validate the optional manifest up front: `thyme upload` refuses an invalid
	// one, so a local run should not pretend it is fine.
	const permissions = await loadRunPermissions(
		await taskDirectory.read(PERMISSIONS_FILE_NAME, true, 16 * 1024),
		finalTaskName,
	)

	const spinner = createSpinner()
	spinner.start('Executing task in Deno sandbox...')

	// Run task
	const result = await runInDeno(taskPath, args, config, projectRoot, storage)

	if (!result.success) {
		spinner.stop('Task execution failed')
		error(result.error ?? 'Unknown error')
		if (result.logs.length > 0) {
			step('Task output:')
			for (const taskLog of result.logs) {
				log(`  ${taskLog}`)
			}
		}
		throw new RunCommandExit(1)
	}

	spinner.stop('Task executed successfully')

	// Show logs
	if (result.logs.length > 0) {
		log('')
		step('Task output:')
		for (const taskLog of result.logs) {
			log(`  ${taskLog}`)
		}
	}

	// Show result
	if (!result.result) {
		error('No result returned from task')
		throw new RunCommandExit(1)
	}

	log('')
	if (result.result.canExec) {
		info(
			`${pc.green('✓')} Result: canExec = true (${result.result.calls.length} call(s))`,
		)

		// Show calls
		log('')
		step('Calls to execute:')
		for (const call of result.result.calls) {
			log(`  ${pc.cyan('→')} to: ${call.to}`)
			log(`     data: ${call.data}`)
		}

		if (permissions) {
			log('')
			await checkCallsAgainstPermissions(
				result.result.calls,
				permissions,
				args,
				config.rpcUrl,
			)
		}

		// Simulate if requested
		if (options.simulate) {
			log('')
			await simulateCalls(result.result.calls, runtimeEnv)
		}
	} else {
		warn('Result: canExec = false')
		info(`Message: ${result.result.message}`)
	}

	// Show execution stats
	log('')
	if (
		result.executionTime !== undefined ||
		result.memoryUsed !== undefined ||
		result.rpcRequestCount !== undefined
	) {
		step('Execution stats:')
		if (result.executionTime !== undefined) {
			log(`  Duration: ${result.executionTime.toFixed(2)}ms`)
		}
		if (result.memoryUsed !== undefined) {
			const memoryMB = (result.memoryUsed / 1024 / 1024).toFixed(2)
			log(`  Memory: ${memoryMB}MB`)
		}
		if (result.rpcRequestCount !== undefined) {
			log(`  RPC Requests: ${result.rpcRequestCount}`)
		}
	}

	const producedStorage = result.storage ?? {}
	log('')
	if (options.persist) {
		try {
			await taskDirectory.writeAtomic(
				'storage.json',
				`${JSON.stringify(producedStorage, null, 2)}\n`,
			)
			info(`Storage persisted to ${storagePath}`)
		} catch (err) {
			error(
				`Failed to persist storage.json: ${err instanceof Error ? err.message : String(err)}`,
			)
			throw new RunCommandExit(1)
		}
	} else {
		step('Produced storage (not persisted):')
		const storageJson = JSON.stringify(producedStorage, null, 2)
		for (const line of storageJson.split('\n')) {
			log(`  ${line}`)
		}
		info('Use --persist to write this output to storage.json')
	}

	// Simulate onSuccess/onFail with a fabricated receipt, since `thyme run`
	// never actually submits a call and there is no real outcome to react to.
	// `--callback <outcome>` names the outcome up front, which is what makes the
	// flow usable without a picker.
	if (options.simulateCallbacks || options.callback) {
		if (!result.result?.canExec) {
			log('')
			info(
				'--simulate-callbacks skipped: onSuccess/onFail react to a submitted call, and this run had canExec: false.',
			)
		} else {
			await simulateCallbacksFlow({
				taskPath,
				args,
				config,
				projectRoot,
				storagePath,
				taskDirectory,
				preRunStorage: storage,
				postRunStorage: producedStorage,
				definedCallbacks: result.definedCallbacks ?? [],
				persist: options.persist,
				requestedOutcome: options.callback,
			})
		}
	}

	// Show simulation tip if task can execute and simulation wasn't run
	if (result.result?.canExec && !options.simulate) {
		log('')
		info(
			`${pc.dim('💡 Tip: Test calls on-chain with:')} ${pc.cyan(`thyme run ${finalTaskName} --simulate`)}`,
		)
		outro('')
	} else {
		outro('')
	}
}

async function loadRunPermissions(
	text: string | undefined,
	taskName: string,
): Promise<PermissionsManifest | undefined> {
	if (text === undefined) return undefined

	const parsed = parsePermissionsManifest(text)
	if (!parsed.ok) {
		error(
			`functions/${taskName}/${PERMISSIONS_FILE_NAME} is invalid and \`thyme upload\` will refuse it:\n${parsed.errors
				.map((message) => `  - ${message}`)
				.join('\n')}`,
		)
		throw new RunCommandExit(1)
	}
	return parsed.manifest
}

/**
 * Warn about returned calls the task's permissions.json does not declare.
 * In the cloud such a call fails the execution before anything is submitted.
 * Arg targets resolve from args.json; fixed targets use the RPC's chain id.
 */
async function checkCallsAgainstPermissions(
	calls: Array<{ to: Address; data: `0x${string}` }>,
	manifest: PermissionsManifest,
	args: unknown,
	rpcUrl: string | undefined,
) {
	let chainId: number | undefined
	const needsChain = manifest.calls.some((call) => call.target.kind === 'fixed')
	if (needsChain && rpcUrl) {
		try {
			chainId = await createPublicClient({
				transport: http(rpcUrl),
			}).getChainId()
		} catch (err) {
			warn(
				`Could not read the chain id from RPC_URL: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	const resolved = resolvePermissions(manifest, chainId, args)
	if (!resolved.ok) {
		warn(
			`${PERMISSIONS_FILE_NAME} could not be fully resolved, so no call counts as declared:`,
		)
		for (const reason of resolved.reasons) {
			warn(`  - ${reason}`)
		}
	}
	const allowed = resolved.ok ? resolved.allowed : new Set<string>()

	const undeclared = calls.filter((call) => {
		const key = callPairKey(call)
		return key === null || !allowed.has(key)
	})

	if (undeclared.length === 0) {
		info(
			`${pc.green('✓')} Every returned call is declared in ${PERMISSIONS_FILE_NAME}${chainId === undefined ? '' : ` (chain ${chainId})`}`,
		)
		return
	}

	warn(
		`${undeclared.length} returned call(s) are not declared in ${PERMISSIONS_FILE_NAME}. In the cloud this execution would fail before anything is submitted:`,
	)
	for (const call of undeclared) {
		const selector =
			callPairKey(call) === null ? 'no selector' : call.data.slice(0, 10)
		warn(`  - to ${call.to} (${selector})`)
	}
}

async function simulateCalls(
	calls: Array<{ to: Address; data: `0x${string}` }>,
	runtimeEnv: EnvMap,
) {
	const rpcUrl = runtimeEnv.RPC_URL ?? getEnv('RPC_URL')
	const account = runtimeEnv.SIMULATE_ACCOUNT ?? getEnv('SIMULATE_ACCOUNT')

	if (!rpcUrl || !account) {
		warn(
			'Simulation requires RPC_URL and SIMULATE_ACCOUNT in root .env or functions/<task>/.env',
		)
		return
	}

	const spinner = createSpinner()
	spinner.start('Simulating on-chain...')

	try {
		const client = createPublicClient({
			transport: http(rpcUrl),
		})

		// Get chain info
		const chainId = await client.getChainId()
		const blockNumber = await client.getBlockNumber()

		spinner.stop('Simulating on-chain...')

		log('')
		info(`Chain ID: ${chainId}`)
		info(`Block: ${blockNumber}`)
		info(`Account: ${account}`)

		// Validate account address
		if (!isAddress(account)) {
			spinner.stop('Invalid account address')
			log('')
			error(`SIMULATE_ACCOUNT is not a valid Ethereum address: ${account}`)
			return
		}

		// Local simulation is a best-effort preview, NOT a faithful replay of the
		// cloud run. Production submits these calls as a single atomic ERC-4337 /
		// EIP-7702 batch from the profile's smart-account address (sponsored or
		// self-paid gas); here they are simulated from SIMULATE_ACCOUNT. So
		// msg.sender, atomicity, and the gas/payer context all differ.
		warn(
			'Note: simulation runs from SIMULATE_ACCOUNT and does not reproduce production execution — ' +
				'in the cloud the calls run atomically from your profile smart-account (different msg.sender, ' +
				'atomicity, and gas/sponsorship). Access-controlled or inter-dependent calls may behave differently on-chain.',
		)

		// Simulate all calls at once using viem's simulateCalls
		const simulationSpinner = createSpinner()
		simulationSpinner.start('Running simulation...')

		let usedFallback = false
		let results: Array<{
			status: 'success' | 'failure'
			gasUsed?: bigint
			error?: { message?: string }
		}> = []

		try {
			const batchResult = await client.simulateCalls({
				account: account as Address,
				calls: calls.map((call) => ({
					to: call.to,
					data: call.data,
				})),
			})
			results = batchResult.results
		} catch (batchError) {
			// Only downgrade to the weaker per-call path when the RPC genuinely
			// lacks eth_simulateV1. Any other error — a reverted call surfaced as an
			// exception, invalid params (e.g. a strict fee check), or a transient
			// node failure — must not be silently relabeled "unsupported": doing so
			// hid real problems behind a misleading message and produced a
			// false-green preview.
			if (isMethodUnsupportedError(batchError)) {
				simulationSpinner.stop('Batch simulation not supported')
				log('')
				warn(
					'RPC does not support eth_simulateV1 (batch simulation). Falling back to individual calls.',
				)
			} else {
				simulationSpinner.stop('Batch simulation failed')
				log('')
				warn(
					`eth_simulateV1 failed: ${
						batchError instanceof Error
							? batchError.message
							: String(batchError)
					}`,
				)
				warn('Falling back to individual calls (best-effort preview).')
			}
			warn(
				pc.yellow(
					'⚠️  Note: Individual simulation cannot detect failures in dependent transactions.',
				),
			)
			warn(
				pc.yellow(
					'   If your calls depend on each other (e.g., approve then swap), simulation may pass but execution could fail.',
				),
			)
			log('')

			usedFallback = true
			const fallbackSpinner = createSpinner()
			fallbackSpinner.start('Running individual simulations...')

			// Simulate each call individually using eth_call
			for (let i = 0; i < calls.length; i++) {
				const call = calls[i]
				if (!call) continue

				try {
					// Use eth_call to simulate
					await client.call({
						account: account as Address,
						to: call.to,
						data: call.data,
					})

					// Estimate gas for successful call
					let gasUsed: bigint | undefined
					try {
						gasUsed = await client.estimateGas({
							account: account as Address,
							to: call.to,
							data: call.data,
						})
					} catch {
						// Gas estimation failed, continue without gas info
					}

					results.push({
						status: 'success',
						gasUsed,
					})
				} catch (callError) {
					results.push({
						status: 'failure',
						error: {
							message:
								callError instanceof Error
									? callError.message
									: String(callError),
						},
					})
				}
			}

			fallbackSpinner.stop('Individual simulations complete')
		}

		if (!usedFallback) {
			simulationSpinner.stop('Simulation complete')
		}

		// Check results for failures
		const failedCalls: Array<{
			index: number
			call: { to: Address; data: `0x${string}` }
			error?: string
		}> = []
		for (let i = 0; i < results.length; i++) {
			const result = results[i]
			const call = calls[i]
			if (!result || !call) continue

			if (result.status === 'failure') {
				failedCalls.push({
					index: i,
					call,
					error: result.error?.message || 'Unknown error',
				})
			}
		}

		if (failedCalls.length > 0) {
			log('')
			error('Some calls would revert:')
			for (const failed of failedCalls) {
				error(
					`  Call ${failed.index + 1} to ${failed.call.to}: ${failed.error}`,
				)
			}
			return
		}

		// Get gas price
		const gasPrice = await client.getGasPrice()

		clack.log.step('Simulation results:')
		clack.log.success('All calls would succeed')

		// Show warning again if fallback was used
		if (usedFallback && calls.length > 1) {
			clack.log.warn(
				pc.yellow(
					'Results may not reflect actual execution if calls are dependent on each other.',
				),
			)
		}

		// Show gas usage if available
		const totalGas = results.reduce((sum, r) => sum + (r.gasUsed || 0n), 0n)
		if (totalGas > 0n) {
			clack.log.message(`  Total gas: ${totalGas.toString()}`)
		}

		clack.log.message(`  Gas price: ${formatEther(gasPrice)} ETH`)
	} catch (err) {
		spinner.stop('Simulation failed')
		log('')
		error(err instanceof Error ? err.message : String(err))
	}
}

/**
 * Distinguish "the RPC lacks eth_simulateV1" from every other simulation error.
 *
 * The batch path should fall back to per-call eth_call ONLY when the method is
 * genuinely unavailable on the node. Bor/Geth return JSON-RPC -32601
 * ("method not found") in that case, which viem surfaces as
 * MethodNotFoundRpcError; some nodes use MethodNotSupportedRpcError instead.
 * Everything else — a revert raised as an exception, invalid params (e.g. a
 * strict fee validation), or a transient node error — is a real signal that
 * must be surfaced, not masked behind "unsupported".
 */
export function isMethodUnsupportedError(err: unknown): boolean {
	if (err instanceof BaseError) {
		const match = err.walk(
			(e) =>
				e instanceof MethodNotFoundRpcError ||
				e instanceof MethodNotSupportedRpcError ||
				(e as { code?: number }).code === -32601,
		)
		if (match) return true
	}

	const message = (
		err instanceof Error ? err.message : String(err ?? '')
	).toLowerCase()
	return (
		message.includes('method not found') ||
		message.includes('method not supported') ||
		message.includes('method not available') ||
		message.includes('method does not exist') ||
		message.includes('unsupported method') ||
		(message.includes('eth_simulatev1') &&
			(message.includes('not exist') ||
				message.includes('not available') ||
				message.includes('not support') ||
				message.includes('unsupported') ||
				message.includes('unknown')))
	)
}

interface SimulatedOutcome {
	value: string
	label: string
	name: CallbackName
	payload: unknown
	/**
	 * Which storage snapshot this outcome's callback should start from — mirrors
	 * the SDK's storage rules: `onSuccess` sees post-run committed storage,
	 * `onFail` sees pre-run committed storage (the failed run's writes dropped).
	 */
	storage: unknown
}

/**
 * Fabricate a receipt and invoke `onSuccess`/`onFail` for `--simulate-callbacks`.
 * `thyme run` never submits a real call, so there is no on-chain outcome to
 * react to — this lets a task author exercise those two hooks locally anyway.
 */
async function simulateCallbacksFlow(params: {
	taskPath: string
	args: unknown
	config: TaskConfig
	projectRoot: string
	storagePath: string
	taskDirectory: PinnedDirectory
	preRunStorage: unknown
	postRunStorage: unknown
	definedCallbacks: string[]
	persist?: boolean
	requestedOutcome?: string
}) {
	const {
		taskPath,
		args,
		config,
		projectRoot,
		storagePath,
		taskDirectory,
		preRunStorage,
		postRunStorage,
		definedCallbacks,
		persist,
		requestedOutcome,
	} = params

	const hasOnSuccess = definedCallbacks.includes('onSuccess')
	const hasOnFail = definedCallbacks.includes('onFail')

	if (!hasOnSuccess && !hasOnFail) {
		log('')
		info('Task defines no onSuccess/onFail callback — nothing to simulate.')
		return
	}

	const fakeTxHash = `0x${'ab'.repeat(32)}`
	const outcomes: SimulatedOutcome[] = []

	if (hasOnSuccess) {
		outcomes.push({
			value: 'onSuccess',
			label: 'onSuccess — simulate a confirmed tx',
			name: 'onSuccess',
			payload: {
				txHash: fakeTxHash,
				blockNumber: 1,
				gasUsed: '100000',
				gasCostWei: '1000000000000000',
			},
			storage: postRunStorage,
		})
	}
	if (hasOnFail) {
		outcomes.push(
			{
				value: 'onFail:reverted',
				label: "onFail — stage: 'reverted'",
				name: 'onFail',
				payload: {
					stage: 'reverted',
					reason: 'Simulated revert (thyme run --simulate-callbacks)',
					txHash: fakeTxHash,
				},
				storage: preRunStorage,
			},
			{
				value: 'onFail:submit',
				label: "onFail — stage: 'submit'",
				name: 'onFail',
				payload: {
					stage: 'submit',
					reason: 'Simulated submit rejection (thyme run --simulate-callbacks)',
				},
				storage: preRunStorage,
			},
			{
				value: 'onFail:timeout',
				label: "onFail — stage: 'timeout'",
				name: 'onFail',
				payload: {
					stage: 'timeout',
					reason: 'Simulated receipt timeout (thyme run --simulate-callbacks)',
					txHash: fakeTxHash,
				},
				storage: preRunStorage,
			},
		)
	}

	log('')
	const SKIP = 'skip'
	const available = outcomes.map((outcome) => outcome.value)

	let selected: string
	if (requestedOutcome !== undefined) {
		const normalized = requestedOutcome.trim()
		if (normalized === SKIP) return
		if (!available.includes(normalized)) {
			error(
				`Unknown --callback value "${requestedOutcome}". This task supports: ${available.join(', ')}`,
			)
			throw new RunCommandExit(2)
		}
		selected = normalized
		info(`Simulating callback outcome: ${pc.cyan(selected)}`)
	} else {
		selected = await promptSelect(
			{
				message: 'Simulate a callback outcome?',
				options: [
					...outcomes.map((o) => ({ value: o.value, label: o.label })),
					{ value: SKIP, label: 'Skip' },
				],
			},
			{
				what: 'A callback outcome',
				hint: `Pass \`--callback <outcome>\` with one of: ${available.join(', ')}`,
			},
		)
		if (selected === SKIP) return
	}

	const chosen = outcomes.find((o) => o.value === selected)
	if (!chosen) return

	const spinner = createSpinner()
	spinner.start(`Running ${chosen.name} in Deno sandbox...`)

	const invocation: CallbackInvocation = {
		name: chosen.name,
		payload: chosen.payload,
	}
	const callbackResult = await runCallbackInDeno(
		taskPath,
		args,
		config,
		projectRoot,
		chosen.storage,
		invocation,
	)

	if (!callbackResult.success) {
		spinner.stop(`${chosen.name} failed`)
		error(callbackResult.error ?? 'Unknown error')
		if (callbackResult.logs.length > 0) {
			step('Callback output:')
			for (const callbackLog of callbackResult.logs) {
				log(`  ${callbackLog}`)
			}
		}
		return
	}

	spinner.stop(`${chosen.name} executed successfully`)

	if (callbackResult.logs.length > 0) {
		log('')
		step('Callback output:')
		for (const callbackLog of callbackResult.logs) {
			log(`  ${callbackLog}`)
		}
	}

	const callbackStorage = callbackResult.storage ?? {}
	log('')
	if (persist) {
		try {
			await taskDirectory.writeAtomic(
				'storage.json',
				`${JSON.stringify(callbackStorage, null, 2)}\n`,
			)
			info(`Storage persisted to ${storagePath}`)
		} catch (err) {
			error(
				`Failed to persist storage.json: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	} else {
		step(`Storage produced by ${chosen.name} (not persisted):`)
		const storageJson = JSON.stringify(callbackStorage, null, 2)
		for (const line of storageJson.split('\n')) {
			log(`  ${line}`)
		}
	}
}
