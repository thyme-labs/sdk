import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clack, error, intro, outro, pc } from '../utils/ui'

export async function initCommand(projectName?: string) {
	intro('Thyme CLI - Initialize Project')

	// Prompt for project name if not provided
	let finalProjectName = projectName
	if (!finalProjectName) {
		const name = await clack.text({
			message: 'What is your project name?',
			placeholder: 'my-thyme-project',
			validate: (value) => {
				if (!value) return 'Project name is required'
				if (!/^[a-z0-9-]+$/.test(value))
					return 'Project name must be lowercase alphanumeric with hyphens'
			},
		})

		if (clack.isCancel(name)) {
			clack.cancel('Operation cancelled')
			process.exit(0)
		}

		finalProjectName = name as string
	}

	const projectPath = join(process.cwd(), finalProjectName)

	// Check if directory exists
	if (existsSync(projectPath)) {
		error(`Directory "${finalProjectName}" already exists`)
		process.exit(1)
	}

	const spinner = clack.spinner()
	spinner.start('Creating project structure...')

	try {
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
				'@thyme-labs/sdk': '^0.3.2',
				viem: '^2.21.54',
				zod: '^3.24.1',
			},
			devDependencies: {
				'@thyme-labs/cli': '^0.3.2',
				typescript: '^5.7.2',
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

# Simulation settings (for --simulate flag)
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/your-key
SIMULATE_ACCOUNT=0x742d35Cc6634C0532925a3b844Bc454e4438f44e

# Cloud authentication (set by \`thyme login\`)
THYME_AUTH_TOKEN=

# Cloud API URL (required - your Convex deployment URL)
# Example: https://your-deployment.convex.cloud
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
			`${pc.green('✓')} Project initialized!\n\nNext steps:\n  ${pc.cyan('cd')} ${finalProjectName}\n  ${pc.cyan('npm install')}\n  ${pc.cyan('thyme new')} my-task\n  ${pc.cyan('thyme run')} my-task`,
		)
	} catch (err) {
		spinner.stop('Failed to create project')
		error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}
}
