import { basename, dirname, resolve } from 'node:path'
import { PinnedDirectory } from './confined-files'

export interface TaskInputs {
	args: unknown
	storage: unknown
}

function parseOptionalJson(
	contents: string | undefined,
	label: string,
): unknown {
	if (contents === undefined) return {}
	try {
		return JSON.parse(contents)
	} catch (err) {
		throw new Error(
			`${label} contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
}

export function parseTaskInputs(
	args: string | undefined,
	storage: string | undefined,
): TaskInputs {
	return {
		args: parseOptionalJson(args, 'args.json'),
		storage: parseOptionalJson(storage, 'storage.json'),
	}
}

/** For callers explicitly authorizing file paths. The CLI instead retains its
 * selected task directory and passes descriptor-read contents to parseTaskInputs.
 * Missing files default to {}; unsafe/unreadable/malformed inputs are fatal.
 */
export async function loadTaskInputs(
	argsPath: string,
	storagePath: string,
): Promise<TaskInputs> {
	const read = async (path: string) => {
		const absolute = resolve(path)
		const directory = await PinnedDirectory.open(dirname(absolute))
		try {
			return await directory.read(basename(absolute))
		} finally {
			await directory.close()
		}
	}
	const [args, storage] = await Promise.all([read(argsPath), read(storagePath)])
	return parseTaskInputs(args, storage)
}
