import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import {
	formatManagementError,
	type ManagementMethod,
	managementApiRequest,
	printManagementResult,
} from '../utils/management-api'

function parseHeaders(values: string[] | undefined): Record<string, string> {
	const headers: Record<string, string> = {}
	for (const value of values ?? []) {
		const separator = value.indexOf(':')
		if (separator <= 0) throw new Error(`Invalid header: ${value}`)
		headers[value.slice(0, separator).trim()] = value
			.slice(separator + 1)
			.trim()
	}
	return headers
}

function parseBody(options: { data?: string; dataFile?: string }): unknown {
	if (options.data !== undefined && options.dataFile !== undefined) {
		throw new Error('Use only one of --data or --data-file')
	}
	const source =
		options.data ??
		(options.dataFile ? readFileSync(options.dataFile, 'utf-8') : undefined)
	if (source === undefined) return undefined
	try {
		return JSON.parse(source)
	} catch (error) {
		throw new Error(
			`Invalid JSON request body: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

function parseMethod(method: string): ManagementMethod {
	const normalized = method.toUpperCase()
	if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(normalized)) {
		throw new Error('Method must be GET, POST, PATCH, PUT, or DELETE')
	}
	return normalized as ManagementMethod
}

export function registerApiCommand(program: Command): void {
	program
		.command('api')
		.description('Call any Thyme management API route')
		.argument('<method>', 'GET, POST, PATCH, PUT, or DELETE')
		.argument('<path>', 'Versioned API path, for example /api/v1/projects')
		.option('-w, --workspace <id>', 'Workspace ID')
		.option('--data <json>', 'JSON request body')
		.option('--data-file <path>', 'Read JSON request body from a file')
		.option('--header <header...>', 'Additional Name: Value headers')
		.option('--idempotency-key <key>', 'Stable retry key for a mutation')
		.action(async (method, path, options) => {
			try {
				const result = await managementApiRequest({
					method: parseMethod(method),
					path,
					workspaceId: options.workspace,
					body: parseBody(options),
					idempotencyKey: options.idempotencyKey,
					headers: parseHeaders(options.header),
				})
				printManagementResult(result)
			} catch (requestError) {
				process.stderr.write(`${formatManagementError(requestError)}\n`)
				process.exitCode = 1
			}
		})
}
