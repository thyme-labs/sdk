import { createHash } from 'node:crypto'
import { buildTaskArchive } from '@thyme-labs/sdk/archive-writer'

export interface CompressResult {
	zipBuffer: Buffer
	checksum: string
}

/**
 * Compress a task into a deterministic ZIP archive. ZIP timestamps default to
 * the current time, which makes an unchanged function produce a new checksum
 * every two seconds and defeats the upload endpoint's idempotency.
 *
 * `permissions` is the raw text of the task's permissions.json, already
 * validated by the caller. It is omitted from the ZIP when undefined, so an
 * archive without a manifest is byte-identical to one built before manifests
 * existed.
 */
export function compressTask(
	source: string,
	bundle: string,
	permissions?: string,
): CompressResult {
	const zipBuffer = Buffer.from(
		buildTaskArchive({ source, bundle, permissions }),
	)

	const checksum = createHash('sha256').update(zipBuffer).digest('hex')

	return {
		zipBuffer,
		checksum,
	}
}
