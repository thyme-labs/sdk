import { existsSync } from 'node:fs'
import { z } from 'zod'
import { bundleTask } from '../utils/bundler'
import { compressTask } from '../utils/compress'
import { getApiUrl, getAuthToken, getStoredCredentials } from '../utils/config'
import { loadEnv } from '../utils/env'
import {
	formatUploadError,
	formatUploadSuccess,
	resolveUploadVersionTag,
	validateVersionTag,
} from '../utils/function-versioning'
import { selectManagementCredential } from '../utils/management-api'
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
	taskId: z.string(),
	versionTag: z.string(),
	created: z.boolean(),
})

const functionsResponseSchema = z.object({
	data: z.array(
		z.object({
			_id: z.string(),
			versionTag: z.string().nullable().optional(),
		}),
	),
	versioning: z.object({
		functionName: z.string(),
		reservedVersionTags: z.array(z.string()),
		suggestedVersionTag: z.string(),
	}),
})

const apiErrorSchema = z.object({
	error: z.string().optional(),
	code: z.string().optional(),
	suggestedVersionTag: z.string().optional(),
})

export async function uploadCommand(
	taskName?: string,
	workspaceId?: string,
	projectId?: string,
	providedTag?: string,
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

	// Prefer the management credential bound to an explicitly selected
	// workspace (or the sole saved management workspace). Standard login tokens
	// remain a backwards-compatible fallback for the interactive upload flow.
	const standardAuthToken = getAuthToken()
	let managementCredential: ReturnType<typeof selectManagementCredential>
	try {
		managementCredential = selectManagementCredential(
			getStoredCredentials(),
			workspaceId,
		)
	} catch (credentialError) {
		if (!standardAuthToken) {
			error(
				credentialError instanceof Error
					? credentialError.message
					: String(credentialError),
			)
			process.exit(1)
		}
	}
	const authToken = managementCredential?.token ?? standardAuthToken
	if (!authToken) {
		error('Not authenticated. Run `thyme login --management` or `thyme login`.')
		process.exit(1)
	}
	workspaceId ??= managementCredential?.workspaceId

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

	const versionSpinner = clack.spinner()
	versionSpinner.start('Checking function versions...')
	let versionTag: string
	try {
		const params = new URLSearchParams({
			projectId: selectedProjId as string,
			name: finalTaskName,
		})
		const response = await fetch(`${apiUrl}/api/v1/functions?${params}`, {
			headers: {
				Authorization: `Bearer ${authToken}`,
				'x-workspace-id': selectedWsId as string,
			},
		})
		const raw = await response.json().catch(() => null)
		if (!response.ok) {
			const parsedError = apiErrorSchema.safeParse(raw)
			throw new Error(
				formatUploadError(
					response.status,
					parsedError.success ? parsedError.data : null,
				),
			)
		}
		const parsed = functionsResponseSchema.safeParse(raw)
		if (!parsed.success) {
			throw new Error(
				`Invalid function discovery response: ${parsed.error.message}`,
			)
		}
		versionSpinner.stop('Function versions loaded')
		const familyExists =
			parsed.data.data.length > 0 ||
			parsed.data.versioning.reservedVersionTags.length > 0
		versionTag = await resolveUploadVersionTag({
			providedTag,
			familyExists,
			suggestedVersionTag: parsed.data.versioning.suggestedVersionTag,
			isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
			prompt: async (suggestedVersionTag) => {
				const selected = await clack.text({
					message: 'Version tag',
					initialValue: suggestedVersionTag,
					validate(value) {
						const validation = validateVersionTag(value ?? '')
						return validation.ok ? undefined : validation.message
					},
				})
				if (clack.isCancel(selected)) return null
				return selected as string
			},
		})
	} catch (err) {
		versionSpinner.stop('Could not select a function version')
		if (
			err instanceof Error &&
			err.message === 'VERSION_TAG_PROMPT_CANCELLED'
		) {
			clack.cancel('Operation cancelled')
			process.exit(0)
		}
		error(err instanceof Error ? err.message : String(err))
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
		clack.log.message(`  ${pc.dim('Version:')}   ${pc.cyan(versionTag)}`)
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
				versionTag,
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
			const rawError = await response.json().catch(() => null)
			const parsedError = apiErrorSchema.safeParse(rawError)
			throw new Error(
				formatUploadError(
					response.status,
					parsedError.success ? parsedError.data : null,
				),
			)
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

		uploadSpinner.stop(formatUploadSuccess(result.created))

		clack.log.message('')
		clack.log.success('Upload details:')
		clack.log.message(`  ${pc.dim('Task:')} ${pc.cyan(finalTaskName)}`)
		clack.log.message(`  ${pc.dim('Version:')} ${pc.cyan(result.versionTag)}`)
		clack.log.message(`  ${pc.dim('Workspace:')} ${pc.cyan(selectedWs.name)}`)
		clack.log.message(`  ${pc.dim('Project:')} ${pc.cyan(selectedProj.name)}`)
		clack.log.message(
			`  ${pc.dim('Size:')} ${(zipBuffer.length / 1024).toFixed(2)} KB`,
		)
		clack.log.message(`  ${pc.dim('Checksum:')} ${checksum.slice(0, 16)}...`)
		clack.log.message(`  ${pc.dim('Task ID:')} ${pc.green(result.taskId)}`)

		outro(
			`${pc.green('✓')} ${formatUploadSuccess(result.created)}\n\n` +
				`Configure triggers in the dashboard`,
		)
	} catch (err) {
		spinner.stop('Upload failed')
		error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}
}
