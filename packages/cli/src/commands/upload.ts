import { existsSync } from 'node:fs'
import { z } from 'zod'
import { bundleTask } from '../utils/bundler'
import { compressTask } from '../utils/compress'
import { getApiUrl, getAuthToken } from '../utils/config'
import { loadEnv } from '../utils/env'
import { extractSchemaFromTask } from '../utils/schema-extractor'
import {
	discoverTasks,
	getTaskPath,
	isThymeProject,
	validateTaskName,
} from '../utils/tasks'
import { clack, error, intro, outro, pc } from '../utils/ui'

// Zod schemas for API response validation
const projectSchema = z.object({
	id: z.string(),
	name: z.string(),
})

const workspaceSchema = z.object({
	id: z.string(),
	name: z.string(),
	role: z.string(),
	projects: z.array(projectSchema).optional().default([]),
})

const verifyResponseSchema = z.object({
	user: z.object({
		id: z.string(),
		name: z.string().optional().default(''),
		email: z.string(),
	}),
	workspaces: z.array(workspaceSchema).optional().default([]),
})

const uploadResponseSchema = z.object({
	taskId: z.string().optional(),
})

export async function uploadCommand(
	taskName?: string,
	workspaceId?: string,
	projectId?: string,
) {
	intro('Thyme CLI - Upload Task')

	const projectRoot = process.cwd()

	// Load environment variables
	loadEnv(projectRoot)

	// Check if we're in a Thyme project
	if (!isThymeProject(projectRoot)) {
		error('Not in a Thyme project')
		process.exit(1)
	}

	// Check for auth token
	const authToken = getAuthToken()
	if (!authToken) {
		error('Not authenticated. Run `thyme login` first.')
		process.exit(1)
	}

	// Get API URL (Thyme Cloud API URL)
	const apiUrl = getApiUrl()
	if (!apiUrl) {
		error(
			'THYME_API_URL is not set. Please set it to your Thyme Cloud API URL in .env',
		)
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
			message: 'Select a task to upload:',
			options: tasks.map((task) => ({ value: task, label: task })),
		})

		if (clack.isCancel(selected)) {
			clack.cancel('Operation cancelled')
			process.exit(0)
		}

		finalTaskName = selected as string
	}

	// Fetch user's workspaces and projects
	const wsSpinner = clack.spinner()
	wsSpinner.start('Fetching workspaces...')

	let workspaces: z.infer<typeof workspaceSchema>[] = []
	try {
		const verifyResponse = await fetch(`${apiUrl}/api/auth/verify`, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${authToken}`,
			},
		})

		if (!verifyResponse.ok) {
			wsSpinner.stop('Failed to fetch workspaces')
			error('Failed to authenticate. Please run `thyme login` again.')
			process.exit(1)
		}

		const rawData = await verifyResponse.json()

		// Validate response with Zod
		const parseResult = verifyResponseSchema.safeParse(rawData)
		if (!parseResult.success) {
			wsSpinner.stop('Invalid API response')
			error(`API returned unexpected data format: ${parseResult.error.message}`)
			process.exit(1)
		}

		workspaces = parseResult.data.workspaces
		wsSpinner.stop('Workspaces loaded')
	} catch (err) {
		wsSpinner.stop('Failed to fetch workspaces')
		error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}

	if (workspaces.length === 0) {
		error(
			'You are not a member of any workspaces. Please create or join a workspace first.',
		)
		process.exit(1)
	}

	// Step 1: Select workspace
	let selectedWsId = workspaceId

	if (selectedWsId) {
		const wsExists = workspaces.find((ws) => ws.id === selectedWsId)
		if (!wsExists) {
			error(
				`Workspace with ID "${selectedWsId}" not found or you don't have access to it.`,
			)
			process.exit(1)
		}
	} else if (workspaces.length === 1) {
		selectedWsId = workspaces?.[0]?.id
		clack.log.info(`Using workspace: ${pc.cyan(workspaces?.[0]?.name)}`)
	} else {
		const selected = await clack.select({
			message: 'Select a workspace:',
			options: workspaces.map((ws) => ({
				value: ws.id,
				label: `${ws.name} ${pc.dim(`(${ws.role})`)}`,
			})),
		})

		if (clack.isCancel(selected)) {
			clack.cancel('Operation cancelled')
			process.exit(0)
		}

		selectedWsId = selected as string
	}

	const selectedWs = workspaces.find((ws) => ws.id === selectedWsId)!
	const projects = selectedWs.projects

	if (projects.length === 0) {
		error(
			`Workspace "${selectedWs.name}" has no projects. Create a project first.`,
		)
		process.exit(1)
	}

	// Step 2: Select project
	let selectedProjId = projectId

	if (selectedProjId) {
		const projExists = projects.find((p) => p.id === selectedProjId)
		if (!projExists) {
			error(
				`Project with ID "${selectedProjId}" not found in workspace "${selectedWs.name}".`,
			)
			process.exit(1)
		}
	} else {
		clack.log.message('')
		clack.log.info(`Available projects in ${pc.cyan(selectedWs.name)}:`)
		for (const p of projects) {
			clack.log.message(`  • ${p.name} ${pc.dim(`(${p.id})`)}`)
		}
		clack.log.message('')

		const selected = await clack.select({
			message: 'Select a project:',
			options: projects.map((p) => ({
				value: p.id,
				label: `${p.name} ${pc.dim(`(${p.id})`)}`,
			})),
		})

		if (clack.isCancel(selected)) {
			clack.cancel('Operation cancelled')
			process.exit(0)
		}

		selectedProjId = selected as string
	}

	const selectedProj = projects.find((p) => p.id === selectedProjId)!

	let taskPath: string
	try {
		taskPath = getTaskPath(projectRoot, finalTaskName)
	} catch (err) {
		error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}

	// Check if task exists
	if (!existsSync(taskPath)) {
		error(`Task "${finalTaskName}" not found`)
		process.exit(1)
	}

	const spinner = clack.spinner()
	spinner.start('Bundling task...')

	try {
		// Bundle task code with all dependencies
		const { source, bundle } = await bundleTask(taskPath)

		spinner.message('Extracting schema...')

		// Extract schema from source code
		const schema = extractSchemaFromTask(source)
		// Surface a silent extraction failure: the task declares a `schema:` but we
		// couldn't parse it, so the dashboard won't be able to build an args form.
		const schemaDeclared = /\bschema\s*:/.test(source)
		const schemaExtractionFailed = schemaDeclared && !schema

		spinner.message('Compressing files...')

		// Compress source and bundle into ZIP
		const { zipBuffer, checksum } = compressTask(source, bundle)

		spinner.stop('Bundle ready')

		if (schemaExtractionFailed) {
			clack.log.warn(
				pc.yellow(
					'Could not extract an argument schema from this task. The dashboard ' +
						'will not be able to generate an input form. If your schema is defined ' +
						'inline as `schema: z.object({ ... })` (or a `const` referencing one), ' +
						'check it parses; otherwise this is expected.',
				),
			)
		}

		// Summary before upload
		clack.log.message('')
		clack.log.info('Upload summary:')
		clack.log.message(`  ${pc.dim('Workspace:')} ${pc.cyan(selectedWs.name)}`)
		clack.log.message(`  ${pc.dim('Project:')}   ${pc.cyan(selectedProj.name)}`)
		clack.log.message(`  ${pc.dim('Task:')}      ${pc.cyan(finalTaskName)}`)
		clack.log.message(
			`  ${pc.dim('Size:')}      ${(zipBuffer.length / 1024).toFixed(2)} KB`,
		)
		clack.log.message(`  ${pc.dim('Checksum:')}  ${checksum.slice(0, 16)}...`)
		clack.log.message('')

		const confirm = await clack.confirm({
			message: 'Proceed with upload?',
		})

		if (clack.isCancel(confirm) || !confirm) {
			clack.cancel('Upload cancelled')
			process.exit(0)
		}

		const uploadSpinner = clack.spinner()
		uploadSpinner.start('Uploading to cloud...')

		// Create form data
		const formData = new FormData()

		// Add metadata
		formData.append(
			'data',
			JSON.stringify({
				workspaceId: selectedWsId as string,
				projectId: selectedProjId as string,
				taskName: finalTaskName,
				checkSum: checksum,
				schema: schema || undefined,
			}),
		)

		// Add ZIP blob
		formData.append('blob', new Blob([zipBuffer]), 'task.zip')

		// Upload to API
		const response = await fetch(`${apiUrl}/api/task/upload`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${authToken}`,
			},
			body: formData,
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Upload failed: ${errorText}`)
		}

		const rawResult = await response.json()

		// Validate response with Zod
		const resultParseResult = uploadResponseSchema.safeParse(rawResult)
		if (!resultParseResult.success) {
			throw new Error(
				`Invalid upload response: ${resultParseResult.error.message}`,
			)
		}

		const result = resultParseResult.data

		uploadSpinner.stop('Task uploaded successfully!')

		clack.log.message('')
		clack.log.success('Upload details:')
		clack.log.message(`  ${pc.dim('Task:')} ${pc.cyan(finalTaskName)}`)
		clack.log.message(`  ${pc.dim('Workspace:')} ${pc.cyan(selectedWs.name)}`)
		clack.log.message(`  ${pc.dim('Project:')} ${pc.cyan(selectedProj.name)}`)
		clack.log.message(
			`  ${pc.dim('Size:')} ${(zipBuffer.length / 1024).toFixed(2)} KB`,
		)
		clack.log.message(`  ${pc.dim('Checksum:')} ${checksum.slice(0, 16)}...`)
		if (result.taskId) {
			clack.log.message(`  ${pc.dim('Task ID:')} ${pc.green(result.taskId)}`)
		}

		outro(
			`${pc.green('✓')} Task uploaded!\n\n` +
				`Configure triggers in the dashboard`,
		)
	} catch (err) {
		spinner.stop('Upload failed')
		error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}
}
