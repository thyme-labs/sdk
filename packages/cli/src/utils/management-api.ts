import { randomUUID } from 'node:crypto'
import type { StoredCredential } from './config'
import { getApiUrl, getAuthToken, getStoredCredentials } from './config'

export type ManagementMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface ManagementApiResult {
	status: number
	requestId?: string
	replayed: boolean
	data: unknown
}

export class ManagementApiError extends Error {
	readonly status: number
	readonly code?: string
	readonly requestId?: string
	readonly response: unknown

	constructor(result: ManagementApiResult) {
		const payload =
			result.data && typeof result.data === 'object'
				? (result.data as Record<string, unknown>)
				: undefined
		const message =
			typeof payload?.error === 'string'
				? payload.error
				: `Management API request failed with status ${result.status}`
		super(message)
		this.name = 'ManagementApiError'
		this.status = result.status
		this.code = typeof payload?.code === 'string' ? payload.code : undefined
		this.requestId =
			result.requestId ??
			(typeof payload?.requestId === 'string' ? payload.requestId : undefined)
		this.response = result.data
	}
}

export function selectManagementCredential(
	credentials: StoredCredential[],
	workspaceId?: string,
): StoredCredential | undefined {
	const valid = credentials.filter(
		(credential) =>
			credential.kind === 'management' &&
			(credential.expiresAt === undefined || credential.expiresAt > Date.now()),
	)
	if (workspaceId) {
		return valid.find((credential) => credential.workspaceId === workspaceId)
	}
	if (valid.length === 1) return valid[0]
	if (
		valid.length > 1 &&
		new Set(valid.map((credential) => credential.workspaceId)).size === 1
	) {
		return valid.at(-1)
	}
	if (valid.length > 1) {
		throw new Error(
			'Multiple management workspaces are configured; pass --workspace <id>',
		)
	}
	return undefined
}

export function buildManagementApiUrl(apiUrl: string, path: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
		throw new Error('API path must be relative to the configured Thyme API URL')
	}
	const normalizedBase = apiUrl.replace(/\/+$/, '')
	const normalizedPath = path.startsWith('/') ? path : `/${path}`
	const parsedPath = new URL(normalizedPath, 'https://management.invalid')
	if (!parsedPath.pathname.startsWith('/api/v1/')) {
		throw new Error('API path must target a versioned management route')
	}
	return `${normalizedBase}${parsedPath.pathname}${parsedPath.search}`
}

async function parseResponse(response: Response): Promise<unknown> {
	const text = await response.text()
	if (!text) return null
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

export async function managementApiRequest(options: {
	method?: ManagementMethod
	path: string
	workspaceId?: string
	body?: unknown
	idempotencyKey?: string
	headers?: Record<string, string>
}): Promise<ManagementApiResult> {
	const method = options.method ?? 'GET'
	const credential = selectManagementCredential(
		getStoredCredentials(),
		options.workspaceId,
	)
	const token = credential?.token ?? getAuthToken()
	if (!token) {
		throw new Error(
			'No API credential found. Run `thyme login --management` first.',
		)
	}
	const workspaceId = options.workspaceId ?? credential?.workspaceId
	const headers = new Headers(options.headers)
	if (headers.has('authorization') || headers.has('apikey')) {
		throw new Error('Authorization headers are managed by the CLI')
	}
	if (headers.has('x-workspace-id')) {
		throw new Error('Use --workspace instead of setting x-workspace-id')
	}
	headers.set('Authorization', `Bearer ${token}`)
	if (workspaceId) headers.set('x-workspace-id', workspaceId)
	if (options.body !== undefined) {
		headers.set('Content-Type', 'application/json')
	}
	if (method !== 'GET') {
		headers.set('Idempotency-Key', options.idempotencyKey ?? randomUUID())
	}

	const url = buildManagementApiUrl(getApiUrl(), options.path)
	const init: RequestInit = {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	}
	let response: Response | undefined
	let networkError: unknown
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			response = await fetch(url, init)
			break
		} catch (error) {
			networkError = error
		}
	}
	if (!response) {
		throw new Error(
			`Management API request failed: ${networkError instanceof Error ? networkError.message : String(networkError)}`,
		)
	}

	const result: ManagementApiResult = {
		status: response.status,
		requestId: response.headers.get('x-request-id') ?? undefined,
		replayed: response.headers.get('idempotency-replayed') === 'true',
		data: await parseResponse(response),
	}
	if (!response.ok) throw new ManagementApiError(result)
	return result
}

export function printManagementResult(result: ManagementApiResult): void {
	process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`)
}

export function formatManagementError(error: unknown): string {
	if (!(error instanceof ManagementApiError)) {
		return error instanceof Error ? error.message : String(error)
	}
	const context = [
		`HTTP ${error.status}`,
		error.code,
		error.requestId ? `request ${error.requestId}` : undefined,
	]
		.filter(Boolean)
		.join(', ')
	return `${error.message} (${context})`
}
