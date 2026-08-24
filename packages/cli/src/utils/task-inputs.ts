import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

export interface TaskInputs {
	args: unknown
	storage: unknown
}

async function readOptionalJson(path: string, label: string): Promise<unknown> {
	if (!existsSync(path)) return {}

	let contents: string
	try {
		contents = await readFile(path, 'utf-8')
	} catch (err) {
		throw new Error(
			`Failed to read ${label}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	try {
		return JSON.parse(contents)
	} catch (err) {
		throw new Error(
			`${label} contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
}

/**
 * Load the two local files that form a task run's persisted input. Either file
 * may be absent and defaults to {}, but an existing unreadable or malformed
 * file is fatal so `--persist` can never replace it after a fallback run.
 */
export async function loadTaskInputs(
	argsPath: string,
	storagePath: string,
): Promise<TaskInputs> {
	const [args, storage] = await Promise.all([
		readOptionalJson(argsPath, 'args.json'),
		readOptionalJson(storagePath, 'storage.json'),
	])
	return { args, storage }
}
