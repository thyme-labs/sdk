import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spinner as createSpinner, promptText } from '../utils/interactive'
import { getScaffoldDependencyVersions } from '../utils/package-info'
import { error, intro, outro, pc } from '../utils/ui'

export async function initCommand(projectName?: string) {
	intro('Thyme CLI - Initialize Project')

	// Prompt for project name if not provided
	let finalProjectName = projectName
	if (!finalProjectName) {
		finalProjectName = await promptText(
			{
				message: 'What is your project name?',
				placeholder: 'my-thyme-project',
				validate: (value) => {
					if (!value) return 'Project name is required'
					if (!/^[a-z0-9-]+$/.test(value))
						return 'Project name must be lowercase alphanumeric with hyphens'
				},
			},
			{
				what: 'A project name',
				hint: 'Pass it as an argument: `thyme init <name>`',
			},
		)
	}

	if (!/^[a-z0-9-]+$/.test(finalProjectName)) {
		error('Project name must be lowercase alphanumeric with hyphens')
		process.exit(1)
	}

	const projectPath = join(process.cwd(), finalProjectName)

	// Check if directory exists
	if (existsSync(projectPath)) {
		error(`Directory "${finalProjectName}" already exists`)
		process.exit(1)
	}

	const spinner = createSpinner()
	spinner.start('Creating project structure...')

	try {
		const versions = getScaffoldDependencyVersions()

		// Create directories
		await mkdir(projectPath, { recursive: true })
		await mkdir(join(projectPath, 'functions'), { recursive: true })

		// Create package.json
		const packageJson = {
			name: finalProjectName,
			version: '0.1.0',
			type: 'module',
			private: true,
			scripts: {
				dev: 'thyme run',
			},
			dependencies: {
				'@thyme-labs/sdk': versions.sdk,
				viem: versions.viem,
				zod: versions.zod,
			},
			devDependencies: {
				'@thyme-labs/cli': versions.cli,
				typescript: versions.typescript,
			},
		}

		await writeFile(
			join(projectPath, 'package.json'),
			JSON.stringify(packageJson, null, 2),
		)

		// Create tsconfig.json
		const tsconfig = {
			compilerOptions: {
				target: 'ES2022',
				module: 'ESNext',
				moduleResolution: 'bundler',
				lib: ['ES2022', 'DOM'],
				strict: true,
				esModuleInterop: true,
				skipLibCheck: true,
				forceConsistentCasingInFileNames: true,
				resolveJsonModule: true,
			},
			include: ['functions/**/*'],
		}

		await writeFile(
			join(projectPath, 'tsconfig.json'),
			JSON.stringify(tsconfig, null, 2),
		)

		// Create .env.example
		const envExample = `# Project-wide defaults for local task execution
# Task-local values can be set in functions/<task>/.env and override these.

# Local execution account (also used for --simulate) and RPC
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/your-key
SIMULATE_ACCOUNT=0x742d35Cc6634C0532925a3b844Bc454e4438f44e

# Cloud authentication (set by \`thyme login\`)
THYME_AUTH_TOKEN=

# Cloud API URL (optional - defaults to https://functions.thymelabs.io/http)
# Set this only to target a different Thyme deployment.
THYME_API_URL=
`

		await writeFile(join(projectPath, '.env.example'), envExample)

		// Create .gitignore
		const gitignore = `node_modules/
dist/
.env
.env.local
functions/**/.env
functions/**/.env.local
*.log
`

		await writeFile(join(projectPath, '.gitignore'), gitignore)

		// Create README
		const readme = `# ${finalProjectName}

A Thyme project for Web3 automation tasks.

## Getting Started

\`\`\`bash
# Install dependencies
npm install

# Configure the local execution account and RPC
cp .env.example .env
# Edit .env before running a task

# Create a new task
thyme new my-task

# Run a task locally
thyme run my-task

# Simulate on-chain
thyme run my-task --simulate

# Deploy to cloud
thyme login
thyme upload my-task
\`\`\`

## Project Structure

\`\`\`
functions/
  my-task/
    index.ts      # Task definition
    args.json     # Test arguments
    .env.example  # Task-local secret template
\`\`\`

Root \`.env\` values configure CLI/project defaults. For task-specific runtime
secrets, copy \`functions/my-task/.env.example\` to \`functions/my-task/.env\`;
those values are available as \`ctx.secrets\` during \`thyme run\` and override
root \`.env\` values for that task.
`

		await writeFile(join(projectPath, 'README.md'), readme)

		spinner.stop('Project created successfully!')

		outro(
			`${pc.green('✓')} Project initialized!\n\nNext steps:\n  ${pc.cyan('cd')} ${finalProjectName}\n  ${pc.cyan('npm install')}\n  ${pc.cyan('cp .env.example .env')} ${pc.dim('# then set SIMULATE_ACCOUNT and RPC_URL')}\n  ${pc.cyan('thyme new')} my-task\n  ${pc.cyan('thyme run')} my-task`,
		)
	} catch (err) {
		spinner.stop('Failed to create project')
		error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}
}
