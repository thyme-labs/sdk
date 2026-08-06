import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { z } from 'zod'
import {
	getApiUrl,
	getAuthToken,
	readConfig,
	saveCredential,
	setApiUrl,
	setAuthToken,
} from '../utils/config'
import { loadEnv } from '../utils/env'
import { clack, error, info, intro, outro, pc } from '../utils/ui'

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
	credential: z
		.object({
			id: z.string(),
			keyPrefix: z.string(),
			kind: z.enum(['standard', 'management']),
			workspaceId: z.string().optional(),
			scopes: z.array(z.string()),
			expiresAt: z.number().optional(),
		})
		.optional(),
})

interface LoginOptions {
	browserless?: boolean
	token?: boolean
	management?: boolean
	rewriteApiUrl?: boolean
	apiUrl?: string
}

interface AuthStartBrowserResponse {
	sessionId: string
	sessionSecret: string
	loginUrl: string
}

interface AuthStartBrowserlessResponse {
	sessionId: string
	sessionSecret: string
	pairingCode: string
	verifyUrl: string
}

interface AuthPollPendingResponse {
	status: 'pending'
}

interface AuthPollCompleteResponse {
	status: 'complete'
	token: string
}

interface AuthPollExpiredResponse {
	status: 'expired'
}

type AuthPollResponse =
	| AuthPollPendingResponse
	| AuthPollCompleteResponse
	| AuthPollExpiredResponse

function openBrowser(url: string): void {
	// Only ever launch well-formed http(s) URLs, and normalize through the URL
	// parser so quotes/spaces are percent-encoded. The login URL comes from the
	// API, so passing it to a child process unsanitized would be an injection
	// shape — spawning with an argv array (no shell) closes that off.
	let safeUrl: string
	try {
		const parsed = new URL(url)
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return
		}
		safeUrl = parsed.href
	} catch {
		return
	}

	const os = platform()
	const launch = (
		command: string,
		args: string[],
		options: Record<string, unknown> = {},
	) => {
		try {
			const child = spawn(command, args, {
				stdio: 'ignore',
				detached: true,
				...options,
			})
			child.on('error', () => {})
			child.unref()
		} catch {
			// Non-fatal: the caller also prints the URL for manual opening.
		}
	}

	if (os === 'darwin') {
		launch('open', [safeUrl])
	} else if (os === 'win32') {
		// `start` is a cmd builtin; the empty "" is the (required) window title,
		// so the URL is treated as the target instead of the title. The URL is
		// quoted so a query-string `&` isn't parsed by cmd as a separator.
		launch('cmd', ['/c', 'start', '""', `"${safeUrl}"`], {
			windowsVerbatimArguments: true,
		})
	} else {
		launch('xdg-open', [safeUrl])
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveApiUrl(): string | undefined {
	// Load .env from current project if available
	loadEnv(process.cwd())
	return getApiUrl()
}

function isValidApiUrl(value: string): boolean {
	try {
		const url = new URL(value)
		return url.protocol === 'https:' || url.protocol === 'http:'
	} catch {
		return false
	}
}

async function verifyAndDisplayUser(apiUrl: string, token: string) {
	const spinner = clack.spinner()
	spinner.start('Verifying token...')

	const verifyResponse = await fetch(`${apiUrl}/api/auth/verify`, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${token}`,
		},
	})

	if (!verifyResponse.ok) {
		spinner.stop('Token verification failed')
		const errorText = await verifyResponse.text()
		error(`Invalid token: ${errorText}`)
		process.exit(1)
	}

	const rawData = await verifyResponse.json()
	const parseResult = verifyResponseSchema.safeParse(rawData)
	if (!parseResult.success) {
		spinner.stop('Invalid API response')
		error(`API returned unexpected data format: ${parseResult.error.message}`)
		process.exit(1)
	}

	const verifyData = parseResult.data
	spinner.stop('Token verified!')

	clack.log.message('')
	clack.log.success('Authenticated as:')
	clack.log.message(
		`  ${pc.cyan('User:')} ${verifyData.user.name || verifyData.user.email}`,
	)
	clack.log.message(`  ${pc.cyan('Email:')} ${verifyData.user.email}`)

	if (verifyData.workspaces && verifyData.workspaces.length > 0) {
		clack.log.message('')
		clack.log.message(`${pc.cyan('Workspaces:')}`)
		for (const ws of verifyData.workspaces) {
			clack.log.message(`  • ${ws.name} ${pc.dim(`(${ws.role})`)}`)
			for (const proj of ws.projects) {
				clack.log.message(`    └ ${proj.name}`)
			}
		}
	}

	return verifyData
}

async function browserLogin(apiUrl: string, mode: 'standard' | 'management') {
	const spinner = clack.spinner()
	spinner.start('Starting authentication...')

	const startResponse = await fetch(`${apiUrl}/api/cli/auth/start`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ browserless: false, mode }),
	})

	if (!startResponse.ok) {
		spinner.stop('Failed to start authentication')
		error(await startResponse.text())
		process.exit(1)
	}

	const { sessionId, sessionSecret, loginUrl } =
		(await startResponse.json()) as AuthStartBrowserResponse
	spinner.stop('Opening browser...')

	openBrowser(loginUrl)

	clack.log.message('')
	info(`If the browser didn't open, visit:\n  ${pc.cyan(loginUrl)}`)
	clack.log.message('')

	return pollForToken(apiUrl, sessionId, sessionSecret)
}

async function browserlessLogin(
	apiUrl: string,
	mode: 'standard' | 'management',
) {
	const spinner = clack.spinner()
	spinner.start('Starting authentication...')

	const startResponse = await fetch(`${apiUrl}/api/cli/auth/start`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ browserless: true, mode }),
	})

	if (!startResponse.ok) {
		spinner.stop('Failed to start authentication')
		error(await startResponse.text())
		process.exit(1)
	}

	const { sessionId, sessionSecret, pairingCode, verifyUrl } =
		(await startResponse.json()) as AuthStartBrowserlessResponse
	spinner.stop('Ready')

	clack.log.message('')
	clack.log.message(`  Go to:     ${pc.cyan(verifyUrl)}`)
	clack.log.message(`  Enter code: ${pc.bold(pc.cyan(pairingCode))}`)
	clack.log.message('')

	return pollForToken(apiUrl, sessionId, sessionSecret)
}

async function pollForToken(
	apiUrl: string,
	sessionId: string,
	sessionSecret: string,
): Promise<string> {
	const spinner = clack.spinner()
	spinner.start('Waiting for approval...')

	const timeout = 5 * 60 * 1000 // 5 minutes
	const start = Date.now()

	while (Date.now() - start < timeout) {
		await sleep(2000)

		const pollResponse = await fetch(
			`${apiUrl}/api/cli/auth/poll?sessionId=${encodeURIComponent(sessionId)}&secret=${encodeURIComponent(sessionSecret)}`,
		)

		if (!pollResponse.ok) {
			const errorText = await pollResponse.text()
			spinner.stop('Authentication failed')
			error(errorText)
			process.exit(1)
		}

		const data = (await pollResponse.json()) as AuthPollResponse

		if (data.status === 'complete') {
			spinner.stop('Approved!')
			return data.token
		}

		if (data.status === 'expired') {
			spinner.stop('Session expired')
			error('Authentication session expired. Please try again.')
			process.exit(1)
		}
	}

	spinner.stop('Timed out')
	error('Authentication timed out after 5 minutes. Please try again.')
	process.exit(1)
}

async function tokenLogin(_apiUrl: string) {
	info('To authenticate with Thyme Cloud:')
	clack.log.message(`  1. Visit portal`)
	clack.log.message('  2. Generate a new API token')
	clack.log.message('  3. Copy the token and paste it below')
	clack.log.message('')

	const token = await clack.password({
		message: 'Paste your API token:',
		validate: (value) => {
			if (!value) return 'Token is required'
			if (value.length < 10) return 'Token seems too short'
		},
	})

	if (clack.isCancel(token)) {
		clack.cancel('Operation cancelled')
		process.exit(0)
	}

	return token as string
}

export async function loginCommand(options: LoginOptions = {}) {
	intro('Thyme CLI - Login')
	if (options.management && options.token) {
		error(
			'--management starts a browser consent flow and cannot be combined with --token',
		)
		process.exit(2)
	}

	// Check if already authenticated
	const existingToken = getAuthToken()
	if (existingToken && !options.token && !options.management) {
		const shouldContinue = await clack.confirm({
			message: 'You are already logged in. Do you want to re-authenticate?',
		})
		if (clack.isCancel(shouldContinue) || !shouldContinue) {
			clack.cancel('Operation cancelled')
			process.exit(0)
		}
	}

	let apiUrl = resolveApiUrl()
	if (!apiUrl) {
		error(
			'THYME_API_URL is not set. Please set it to your Thyme Cloud API URL (e.g., https://functions.thymelabs.io/http)',
		)
		process.exit(1)
	}

	// Persist API URL in global config and allow opt-in rewrite
	const configuredApiUrl = readConfig().apiUrl
	if (options.apiUrl) {
		if (!isValidApiUrl(options.apiUrl)) {
			error('Invalid API URL. Expected http(s)://...')
			process.exit(1)
		}
		setApiUrl(options.apiUrl)
		apiUrl = options.apiUrl
		clack.log.step(
			`API URL updated in ~/.thyme/config.json: ${pc.cyan(apiUrl)}`,
		)
	} else if (!configuredApiUrl) {
		setApiUrl(apiUrl)
		clack.log.step(`API URL saved to ~/.thyme/config.json: ${pc.cyan(apiUrl)}`)
	} else if (options.rewriteApiUrl) {
		const nextApiUrl = await clack.text({
			message: 'Enter Thyme API URL:',
			placeholder: configuredApiUrl,
			defaultValue: configuredApiUrl,
			validate: (value) => {
				if (!value) return 'API URL is required'
				if (!isValidApiUrl(value)) return 'Expected a valid http(s) URL'
			},
		})

		if (clack.isCancel(nextApiUrl)) {
			clack.cancel('Operation cancelled')
			process.exit(0)
		}

		apiUrl = nextApiUrl as string
		setApiUrl(apiUrl)
		clack.log.step(
			`API URL updated in ~/.thyme/config.json: ${pc.cyan(apiUrl)}`,
		)
	}

	try {
		let token: string
		const mode = options.management ? 'management' : 'standard'

		if (options.token) {
			token = await tokenLogin(apiUrl)
		} else if (options.browserless) {
			token = await browserlessLogin(apiUrl, mode)
		} else {
			token = await browserLogin(apiUrl, mode)
		}

		// Verify and display user info
		const verifyData = await verifyAndDisplayUser(apiUrl, token)
		const credential = verifyData.credential
		if (options.management && credential?.kind !== 'management') {
			throw new Error(
				'The approved credential is not workspace-bound management access',
			)
		}

		if (credential?.kind === 'management') {
			const workspace = verifyData.workspaces.find(
				(item) => item.id === credential.workspaceId,
			)
			saveCredential({
				...credential,
				token,
				workspaceName: workspace?.name,
				userId: verifyData.user.id,
				userEmail: verifyData.user.email,
			})
		}

		if (credential?.kind !== 'management') {
			setAuthToken(token)
		}
		clack.log.step(
			credential?.kind === 'management'
				? 'Workspace credential saved to ~/.thyme/config.json'
				: 'Token saved to ~/.thyme/config.json',
		)

		outro(
			options.management
				? `\nManagement access is ready for ${pc.cyan(verifyData.workspaces[0]?.name ?? 'the selected workspace')}`
				: `\nYou can now upload tasks with ${pc.cyan('thyme upload')}`,
		)
	} catch (err) {
		error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}
}
