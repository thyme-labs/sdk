import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { registerApiCommand } from './commands/api'
import { apiUrlCommand } from './commands/api-url'
import { initCommand } from './commands/init'
import { listCommand } from './commands/list'
import { loginCommand } from './commands/login'
import { logoutCommand } from './commands/logout'
import { registerManagementCommands } from './commands/management'
import { newCommand } from './commands/new'
import { runCommand } from './commands/run'
import { uploadCommand } from './commands/upload'
import { configureInteractivity } from './utils/interactive'

// Read version from package.json dynamically
const __dirname = dirname(fileURLToPath(import.meta.url))
let version = '0.0.0'
try {
	const packageJson = JSON.parse(
		readFileSync(join(__dirname, '../package.json'), 'utf-8'),
	)
	version = packageJson.version || version
} catch {
	// Fallback if package.json can't be read (e.g., in bundled builds)
	// Try one more level up for bundled scenarios
	try {
		const packageJson = JSON.parse(
			readFileSync(join(__dirname, '../../package.json'), 'utf-8'),
		)
		version = packageJson.version || version
	} catch {
		// Use default version
	}
}

const program = new Command()

/**
 * Non-interactive controls are declared on the root command *and* on every
 * command that can prompt, so both `thyme --ci upload` and `thyme upload --ci`
 * work. The `preAction` hook merges the two before any command body runs.
 */
function nonInteractiveOptions(command: Command): Command {
	return command
		.option(
			'--ci',
			'Never prompt: assume yes for confirmations and fail when a required value is missing',
		)
		.option('-y, --yes', 'Assume yes for confirmation prompts')
}

nonInteractiveOptions(
	program
		.name('thyme')
		.description('CLI for developing and deploying Thyme tasks')
		.version(version),
)

program.hook('preAction', (_program, actionCommand) => {
	const options = actionCommand.optsWithGlobals() as {
		ci?: boolean
		yes?: boolean
	}
	configureInteractivity({ ci: options.ci, yes: options.yes })
})

nonInteractiveOptions(
	program
		.command('init')
		.description('Initialize a new Thyme project')
		.argument('[name]', 'Project name'),
).action(initCommand)

nonInteractiveOptions(
	program
		.command('new')
		.description('Create a new task')
		.argument('[name]', 'Task name'),
).action(newCommand)

nonInteractiveOptions(
	program
		.command('run')
		.description('Run a task locally')
		.argument('[task]', 'Task name')
		.option('--simulate', 'Simulate on-chain execution')
		.option('--persist', 'Write produced storage back to storage.json')
		.option(
			'--simulate-callbacks',
			'Fabricate a receipt to exercise onSuccess/onFail locally',
		)
		.option(
			'--callback <outcome>',
			'Callback outcome to simulate: onSuccess, onFail:reverted, onFail:submit, or onFail:timeout (implies --simulate-callbacks)',
		),
).action((task, options) => runCommand(task, options))

program.command('list').description('List all tasks').action(listCommand)

nonInteractiveOptions(
	program
		.command('login')
		.description('Authenticate with Thyme Cloud')
		.option('--browserless', 'Use pairing code instead of browser')
		.option(
			'--token',
			'Provide an API token: prompted on a terminal, read from stdin otherwise',
		)
		.option(
			'--management',
			'Request workspace-bound Functions management access',
		)
		.option('--rewrite-api-url', 'Prompt and rewrite saved API URL')
		.option('--api-url <url>', 'Set and use API URL for this login'),
).action((options) => loginCommand(options))

program
	.command('logout')
	.description('Log out of Thyme Cloud')
	.option('--management', 'Remove a saved management credential')
	.option('-w, --workspace <id>', 'Management workspace to remove')
	.action((options) => logoutCommand(options))

nonInteractiveOptions(
	program
		.command('upload')
		.description('Upload a task to Thyme Cloud')
		.argument('[task]', 'Task name')
		.option('-w, --workspace <id>', 'Workspace ID to upload to')
		.option('-p, --project <id>', 'Project ID to upload to')
		.option('-t, --tag <tag>', 'Immutable function version tag'),
).action((task, options) =>
	uploadCommand(task, options.workspace, options.project, options.tag),
)

program
	.command('api-url')
	.description('Show current Thyme API URL')
	.action(apiUrlCommand)

registerApiCommand(program)
registerManagementCommands(program)

program.parse()
