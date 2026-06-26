import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import type { Address } from 'viem'
import { createPublicClient, formatEther, http, isAddress } from 'viem'
import { checkDeno, runInDeno, type TaskConfig } from '../deno/runner'
import {
	type EnvMap,
	getEnv,
	loadEnv,
	loadEnvFile,
	resolveLoadedEnv,
} from '../utils/env'
import {
	discoverTasks,
	getTaskArgsPath,
	getTaskEnvPath,
	getTaskPath,
	getTaskStoragePath,
	isThymeProject,
	validateTaskName,
} from '../utils/tasks'
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
}

export async function runCommand(taskName?: string, options: RunOptions = {}) {
	intro('Thyme CLI - Run Task')

	const projectRoot = process.cwd()

	// Load environment variables
	const rootEnv = loadEnv(projectRoot)

	// Check if we're in a Thyme project
	if (!isThymeProject(projectRoot)) {
		error('Not in a Thyme project')
		process.exit(1)
	}

	// Check if Deno is installed
	const hasDeno = await checkDeno()
	if (!hasDeno) {
		error('Deno is not installed. Please install Deno: https://deno.land/')
		process.exit(1)
	}

	// Discover tasks if no task name provided
	let finalTaskName = taskName

	// Validate task name if provided via CLI argument
	if (finalTaskName) {
		try {
			validateTaskName(finalTaskName)
		} catch (err) {
			error(err instanceof Error ? err.message : String(err))
			process.exit(1)
		}
	} else {
		const tasks = await discoverTasks(projectRoot)

		if (tasks.length === 0) {
			error('No tasks found. Create one with `thyme new`')
			process.exit(1)
		}

		const selected = await clack.select({
			message: 'Select a task to run:',
			options: tasks.map((task) => ({ value: task, label: task })),
		})

		if (clack.isCancel(selected)) {
			clack.cancel('Operation cancelled')
			process.exit(0)
		}

		finalTaskName = selected as string
	}

	let taskPath: string
	let argsPath: string
	let storagePath: string
	let taskEnvPath: string
	try {
		taskPath = getTaskPath(projectRoot, finalTaskName)
		argsPath = getTaskArgsPath(projectRoot, finalTaskName)
		storagePath = getTaskStoragePath(projectRoot, finalTaskName)
		taskEnvPath = getTaskEnvPath(projectRoot, finalTaskName)
	} catch (err) {
		error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}

	// Check if task exists
	if (!existsSync(taskPath)) {
		error(`Task "${finalTaskName}" not found`)
		process.exit(1)
	}

	// Load task-local env after task selection; these values override root .env.
	const taskEnv = loadEnvFile(taskEnvPath, { override: true })
	const runtimeEnv = resolveLoadedEnv(rootEnv, taskEnv)

	// Use default config
	const config: TaskConfig = {
		memory: 128,
		network: true,
		rpcUrl: runtimeEnv.RPC_URL ?? getEnv('RPC_URL'),
		env: runtimeEnv,
	}

	// Load args
	let args: unknown = {}
	if (existsSync(argsPath)) {
		try {
			const argsData = await readFile(argsPath, 'utf-8')
			args = JSON.parse(argsData)
		} catch (err) {
			warn(
				`Failed to load args.json: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	let storage: unknown = {}
	if (existsSync(storagePath)) {
		try {
			const storageData = await readFile(storagePath, 'utf-8')
			storage = JSON.parse(storageData)
		} catch (err) {
			warn(
				`Failed to load storage.json: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	const spinner = clack.spinner()
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
		process.exit(1)
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
		process.exit(1)
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
			await writeFile(
				storagePath,
				`${JSON.stringify(producedStorage, null, 2)}\n`,
			)
			info(`Storage persisted to ${storagePath}`)
		} catch (err) {
			error(
				`Failed to persist storage.json: ${err instanceof Error ? err.message : String(err)}`,
			)
			process.exit(1)
		}
	} else {
		step('Produced storage (not persisted):')
		const storageJson = JSON.stringify(producedStorage, null, 2)
		for (const line of storageJson.split('\n')) {
			log(`  ${line}`)
		}
		info('Use --persist to write this output to storage.json')
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

	const spinner = clack.spinner()
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
		const simulationSpinner = clack.spinner()
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
		} catch {
			// eth_simulateV1 not supported, fall back to individual eth_call
			simulationSpinner.stop('Batch simulation not supported')
			log('')
			warn(
				'RPC does not support eth_simulateV1 (batch simulation). Falling back to individual calls.',
			)
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
			const fallbackSpinner = clack.spinner()
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
