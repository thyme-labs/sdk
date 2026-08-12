import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spinner as createSpinner, promptText } from '../utils/interactive'
import { isThymeProject, validateTaskName } from '../utils/tasks'
import { error, intro, outro, pc } from '../utils/ui'

export async function newCommand(taskName?: string) {
	intro('Thyme CLI - Create New Task')

	const projectRoot = process.cwd()

	// Check if we're in a Thyme project
	if (!isThymeProject(projectRoot)) {
		error('Not in a Thyme project. Run `thyme init` first.')
		process.exit(1)
	}

	// Prompt for task name if not provided
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
		finalTaskName = await promptText(
			{
				message: 'What is your task name?',
				placeholder: 'my-task',
				validate: (value) => {
					try {
						validateTaskName(value)
					} catch (err) {
						return err instanceof Error ? err.message : String(err)
					}
				},
			},
			{
				what: 'A task name',
				hint: 'Pass it as an argument: `thyme new <name>`',
			},
		)
	}

	const taskPath = join(projectRoot, 'functions', finalTaskName)

	// Check if task already exists
	if (existsSync(taskPath)) {
		error(`Task "${finalTaskName}" already exists`)
		process.exit(1)
	}

	const spinner = createSpinner()
	spinner.start('Creating task...')

	try {
		// Create task directory
		await mkdir(taskPath, { recursive: true })

		// Create index.ts
		const indexTs = `import { defineTask, z } from '@thyme-labs/sdk'
import { encodeFunctionData } from 'viem'

export default defineTask({
	schema: z.object({
		targetAddress: z.address(),
	}),

	async run(ctx) {
		const { targetAddress } = ctx.args
		const { logger } = ctx

		// Use the logger to output messages to the Thyme dashboard
		logger.info('Starting task execution')
		logger.info(\`Processing address: \${targetAddress}\`)

		// Example: Read from blockchain using the public client
		// const balance = await ctx.client.getBalance({ address: targetAddress })
		// logger.info(\`Balance: \${balance}\`)
		//
		// const blockNumber = await ctx.client.getBlockNumber()
		// logger.info(\`Current block: \${blockNumber}\`)
		//
		// const value = await ctx.client.readContract({
		//   address: targetAddress,
		//   abi: [...],
		//   functionName: 'balanceOf',
		//   args: [someAddress],
		// })

		// Example: Log warnings and errors
		// logger.warn('Low balance detected')
		// logger.error('Failed to fetch data')
		//
		// Example: Read task-local secrets from functions/${finalTaskName}/.env
		// const apiKey = ctx.secrets.MY_API_KEY

		// Example: Return calls to execute
		logger.info('Task completed successfully')
		return {
			canExec: true,
			calls: [
				{
					to: targetAddress,
					data: '0x' as const,
				},
			],
		}

		// Example with encodeFunctionData:
		// const abi = [...] as const
		// return {
		//   canExec: true,
		//   calls: [
		//     {
		//       to: targetAddress,
		//       data: encodeFunctionData({
		//         abi,
		//         functionName: 'transfer',
		//         args: [recipientAddress, 1000n],
		//       }),
		//     },
		//   ],
		// }

		// Or return false if conditions not met
		// return {
		//   canExec: false,
		//   message: 'Conditions not met'
		// }
	},
})
`

		await writeFile(join(taskPath, 'index.ts'), indexTs)

		// Create args.json
		const args = {
			targetAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
		}

		await writeFile(join(taskPath, 'args.json'), JSON.stringify(args, null, 2))
		await writeFile(
			join(taskPath, 'storage.json'),
			`${JSON.stringify({}, null, 2)}\n`,
		)

		// Create task-local env example
		const envExample = `# Task-local secrets for ctx.secrets during \`thyme run\`
# Copy this file to .env. The .env file is gitignored.
# Values here override project root .env for this task.
MY_API_KEY=

# Optional: override the project-wide ctx.account for this task.
# SIMULATE_ACCOUNT=0x742d35Cc6634C0532925a3b844Bc454e4438f44e
`

		await writeFile(join(taskPath, '.env.example'), envExample)

		spinner.stop('Task created successfully!')

		outro(
			`${pc.green('✓')} Task "${finalTaskName}" created!\n\nNext steps:\n  ${pc.cyan('Edit')} functions/${finalTaskName}/index.ts\n  ${pc.cyan('Update')} functions/${finalTaskName}/args.json\n  ${pc.cyan('thyme run')} ${finalTaskName}`,
		)
	} catch (err) {
		spinner.stop('Failed to create task')
		error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}
}
