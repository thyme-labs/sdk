import type { Command } from 'commander'
import {
	formatManagementError,
	type ManagementMethod,
	managementApiRequest,
	printManagementResult,
} from '../utils/management-api'

type RequestOptions = {
	workspace?: string
	idempotencyKey?: string
}

function workspaceOption(command: Command): Command {
	return command.option('-w, --workspace <id>', 'Workspace ID')
}

function mutationOptions(command: Command): Command {
	return workspaceOption(command).option(
		'--idempotency-key <key>',
		'Stable retry key',
	)
}

function parseJson(value: string, label: string): unknown {
	try {
		return JSON.parse(value)
	} catch (parseError) {
		throw new Error(
			`${label} must be valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
		)
	}
}

function queryPath(
	path: string,
	params: Record<string, string | number | undefined>,
): string {
	const query = new URLSearchParams()
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) query.set(key, String(value))
	}
	const suffix = query.toString()
	return suffix ? `${path}?${suffix}` : path
}

async function request(
	method: ManagementMethod,
	path: string,
	options: RequestOptions,
	body?: unknown,
): Promise<void> {
	try {
		printManagementResult(
			await managementApiRequest({
				method,
				path,
				workspaceId: options.workspace,
				idempotencyKey: options.idempotencyKey,
				body,
			}),
		)
	} catch (requestError) {
		process.stderr.write(`${formatManagementError(requestError)}\n`)
		process.exitCode = 1
	}
}

export function registerManagementCommands(program: Command): void {
	registerProjects(program)
	registerChains(program)
	registerFunctions(program)
	registerExecutables(program)
	registerExecutions(program)
	registerProfiles(program)
	registerSecrets(program)
	registerWebhooks(program)
	registerUsage(program)
}

function registerProjects(program: Command): void {
	const projects = program.command('projects').description('Manage projects')
	workspaceOption(projects.command('list').description('List projects')).action(
		(options) => request('GET', '/api/v1/projects', options),
	)
	workspaceOption(
		projects.command('get').description('Get a project').argument('<id>'),
	).action((id, options) =>
		request('GET', `/api/v1/projects/${encodeURIComponent(id)}`, options),
	)
	mutationOptions(
		projects
			.command('create')
			.description('Create a project')
			.requiredOption('--name <name>')
			.requiredOption('--slug <slug>')
			.option('--description <text>')
			.option('--environment <environment>', 'production or development'),
	).action((options) =>
		request('POST', '/api/v1/projects', options, {
			name: options.name,
			slug: options.slug,
			description: options.description,
			environment: options.environment,
		}),
	)
	mutationOptions(
		projects
			.command('update')
			.description('Update project metadata')
			.argument('<id>')
			.option('--name <name>')
			.option('--description <text>'),
	).action((id, options) =>
		request('PATCH', `/api/v1/projects/${encodeURIComponent(id)}`, options, {
			name: options.name,
			description: options.description,
		}),
	)
}

function registerChains(program: Command): void {
	const chains = program.command('chains').description('Inspect enabled chains')
	workspaceOption(
		chains.command('list').description('List enabled chains'),
	).action((options) => request('GET', '/api/v1/chains', options))
}

function registerFunctions(program: Command): void {
	const functions = program
		.command('functions')
		.description('Manage immutable function releases')
	workspaceOption(
		functions
			.command('list')
			.requiredOption('--project <id>')
			.option('--name <name>')
			.option('--limit <count>')
			.option('--cursor <cursor>'),
	).action((options) =>
		request(
			'GET',
			queryPath('/api/v1/functions', {
				projectId: options.project,
				name: options.name,
				limit: options.limit,
				cursor: options.cursor,
			}),
			options,
		),
	)
	workspaceOption(functions.command('get').argument('<id>')).action(
		(id, options) =>
			request('GET', `/api/v1/functions/${encodeURIComponent(id)}`, options),
	)
	workspaceOption(functions.command('source').argument('<id>')).action(
		(id, options) =>
			request(
				'GET',
				`/api/v1/functions/${encodeURIComponent(id)}/source`,
				options,
			),
	)
	mutationOptions(functions.command('delete').argument('<id>')).action(
		(id, options) =>
			request('DELETE', `/api/v1/functions/${encodeURIComponent(id)}`, options),
	)
	mutationOptions(
		functions
			.command('copy')
			.description('Copy code into a target immutable release')
			.argument('<id>', 'Source function ID')
			.requiredOption('--project <id>', 'Target project ID')
			.option('--name <name>', 'Target function name')
			.option('-t, --tag <tag>', 'Target version tag'),
	).action((id, options) =>
		request(
			'POST',
			`/api/v1/functions/${encodeURIComponent(id)}/copy`,
			options,
			{
				targetProjectId: options.project,
				name: options.name,
				versionTag: options.tag,
			},
		),
	)
}

function registerExecutables(program: Command): void {
	const executables = program
		.command('executables')
		.description('Manage executables')
	workspaceOption(
		executables
			.command('list')
			.requiredOption('--project <id>')
			.option('--limit <count>')
			.option('--cursor <cursor>'),
	).action((options) =>
		request(
			'GET',
			queryPath('/api/v1/executables', {
				projectId: options.project,
				limit: options.limit,
				cursor: options.cursor,
			}),
			options,
		),
	)
	workspaceOption(executables.command('get').argument('<id>')).action(
		(id, options) =>
			request('GET', `/api/v1/executables/${encodeURIComponent(id)}`, options),
	)
	mutationOptions(
		executables
			.command('create')
			.description('Create from a complete JSON configuration')
			.requiredOption('--data <json>'),
	).action((options) =>
		request(
			'POST',
			'/api/v1/executables',
			options,
			parseJson(options.data, '--data'),
		),
	)

	for (const action of [
		'pause',
		'resume',
		'run',
		'simulate',
		'reprovision',
		'regenerate',
	] as const) {
		mutationOptions(executables.command(action).argument('<id>')).action(
			(id, options) =>
				request(
					'POST',
					`/api/v1/executables/${encodeURIComponent(id)}/${action}`,
					options,
				),
		)
	}
	mutationOptions(executables.command('delete').argument('<id>')).action(
		(id, options) =>
			request(
				'DELETE',
				`/api/v1/executables/${encodeURIComponent(id)}`,
				options,
			),
	)
	mutationOptions(
		executables
			.command('set-function')
			.description('Start a paused executable atomic function-version switch')
			.argument('<id>')
			.requiredOption('--function <id>')
			.option('--args <json>'),
	).action((id, options) =>
		request(
			'PATCH',
			`/api/v1/executables/${encodeURIComponent(id)}/function`,
			options,
			{ functionId: options.function, args: options.args },
		),
	)
	mutationOptions(
		executables
			.command('update')
			.description(
				'Update args, secrets, gas-mode, profile, provider, pin, or trigger',
			)
			.argument('<id>')
			.argument(
				'<field>',
				'args|secrets|gas-mode|profile|sponsorship-provider|pinned|trigger',
			)
			.requiredOption('--data <json>'),
	).action((id, field, options) => {
		const allowed = new Set([
			'args',
			'secrets',
			'gas-mode',
			'profile',
			'sponsorship-provider',
			'pinned',
			'trigger',
		])
		if (!allowed.has(field))
			throw new Error(`Unsupported executable field: ${field}`)
		return request(
			'PATCH',
			`/api/v1/executables/${encodeURIComponent(id)}/${field}`,
			options,
			parseJson(options.data, '--data'),
		)
	})
	workspaceOption(executables.command('storage-get').argument('<id>')).action(
		(id, options) =>
			request(
				'GET',
				`/api/v1/executables/${encodeURIComponent(id)}/storage`,
				options,
			),
	)
	mutationOptions(
		executables
			.command('storage-set')
			.argument('<id>')
			.requiredOption('--expected-version <version>')
			.requiredOption('--value <json>'),
	).action((id, options) =>
		request(
			'PATCH',
			`/api/v1/executables/${encodeURIComponent(id)}/storage`,
			options,
			{
				expectedVersion: Number(options.expectedVersion),
				value: parseJson(options.value, '--value'),
			},
		),
	)
	workspaceOption(executables.command('webhooks').argument('<id>')).action(
		(id, options) =>
			request(
				'GET',
				`/api/v1/executables/${encodeURIComponent(id)}/webhooks`,
				options,
			),
	)
	mutationOptions(
		executables
			.command('webhook-create')
			.argument('<id>')
			.requiredOption('--name <name>'),
	).action((id, options) =>
		request(
			'POST',
			`/api/v1/executables/${encodeURIComponent(id)}/webhooks`,
			options,
			{ name: options.name },
		),
	)
}

function registerExecutions(program: Command): void {
	const executions = program
		.command('executions')
		.description('Inspect execution history and logs')
	workspaceOption(
		executions
			.command('list')
			.requiredOption('--project <id>')
			.option('--status <status>')
			.option('--limit <count>')
			.option('--cursor <cursor>'),
	).action((options) =>
		request(
			'GET',
			queryPath('/api/v1/executions', {
				projectId: options.project,
				status: options.status,
				limit: options.limit,
				cursor: options.cursor,
			}),
			options,
		),
	)
	workspaceOption(executions.command('get').argument('<id>')).action(
		(id, options) =>
			request('GET', `/api/v1/executions/${encodeURIComponent(id)}`, options),
	)
	workspaceOption(executions.command('logs').argument('<id>')).action(
		(id, options) =>
			request(
				'GET',
				`/api/v1/executions/${encodeURIComponent(id)}/logs`,
				options,
			),
	)
}

function registerProfiles(program: Command): void {
	const profiles = program.command('profiles').description('Manage profiles')
	workspaceOption(
		profiles
			.command('list')
			.requiredOption('--project <id>')
			.option('--limit <count>')
			.option('--cursor <cursor>'),
	).action((options) =>
		request(
			'GET',
			queryPath('/api/v1/profiles', {
				projectId: options.project,
				limit: options.limit,
				cursor: options.cursor,
			}),
			options,
		),
	)
	workspaceOption(profiles.command('get').argument('<id>')).action(
		(id, options) =>
			request('GET', `/api/v1/profiles/${encodeURIComponent(id)}`, options),
	)
	mutationOptions(
		profiles
			.command('create')
			.requiredOption('--project <id>')
			.requiredOption('--alias <alias>')
			.requiredOption('--chain <chainId>'),
	).action((options) =>
		request('POST', '/api/v1/profiles', options, {
			projectId: options.project,
			alias: options.alias,
			chainId: Number(options.chain),
		}),
	)
	mutationOptions(
		profiles.command('rename').argument('<id>').requiredOption('--name <name>'),
	).action((id, options) =>
		request('PATCH', `/api/v1/profiles/${encodeURIComponent(id)}`, options, {
			name: options.name,
		}),
	)
	for (const action of ['archive', 'unarchive', 'retry'] as const) {
		mutationOptions(profiles.command(action).argument('<id>')).action(
			(id, options) =>
				request(
					'POST',
					`/api/v1/profiles/${encodeURIComponent(id)}/${action}`,
					options,
				),
		)
	}
	mutationOptions(
		profiles
			.command('share')
			.argument('<id>')
			.requiredOption('--project <id>', 'Target project ID')
			.option('--alias <alias>', 'Alias for the shared profile'),
	).action((id, options) =>
		request(
			'POST',
			`/api/v1/profiles/${encodeURIComponent(id)}/share`,
			options,
			{ targetProjectId: options.project, alias: options.alias },
		),
	)
}

function registerSecrets(program: Command): void {
	const secrets = program
		.command('secrets')
		.description('Manage write-only project secrets')
	workspaceOption(
		secrets.command('list').requiredOption('--project <id>'),
	).action((options) =>
		request(
			'GET',
			queryPath('/api/v1/secrets', { projectId: options.project }),
			options,
		),
	)
	mutationOptions(
		secrets
			.command('create')
			.requiredOption('--project <id>')
			.requiredOption('--key <key>')
			.requiredOption('--value <value>'),
	).action((options) =>
		request('POST', '/api/v1/secrets', options, {
			projectId: options.project,
			key: options.key,
			value: options.value,
		}),
	)
	mutationOptions(
		secrets
			.command('rotate')
			.argument('<id>')
			.requiredOption('--value <value>'),
	).action((id, options) =>
		request('PATCH', `/api/v1/secrets/${encodeURIComponent(id)}`, options, {
			value: options.value,
		}),
	)
	mutationOptions(secrets.command('delete').argument('<id>')).action(
		(id, options) =>
			request('DELETE', `/api/v1/secrets/${encodeURIComponent(id)}`, options),
	)
}

function registerWebhooks(program: Command): void {
	const webhooks = program
		.command('webhooks')
		.description('Manage executable webhook credentials')
	workspaceOption(webhooks.command('get').argument('<id>')).action(
		(id, options) =>
			request('GET', `/api/v1/webhooks/${encodeURIComponent(id)}`, options),
	)
	mutationOptions(
		webhooks.command('rename').argument('<id>').requiredOption('--name <name>'),
	).action((id, options) =>
		request('PATCH', `/api/v1/webhooks/${encodeURIComponent(id)}`, options, {
			name: options.name,
		}),
	)
	mutationOptions(webhooks.command('rotate').argument('<id>')).action(
		(id, options) =>
			request(
				'POST',
				`/api/v1/webhooks/${encodeURIComponent(id)}/rotate`,
				options,
			),
	)
	mutationOptions(webhooks.command('revoke').argument('<id>')).action(
		(id, options) =>
			request('DELETE', `/api/v1/webhooks/${encodeURIComponent(id)}`, options),
	)
}

function registerUsage(program: Command): void {
	const usage = program.command('usage').description('Inspect Functions usage')
	workspaceOption(usage.command('current')).action((options) =>
		request('GET', '/api/v1/usage', options),
	)
}
