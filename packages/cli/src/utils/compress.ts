import { createHash } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'

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
	// ZIP's DOS timestamp starts at 1980. Construct it in local time because
	// fflate serializes local date fields; this yields identical bytes in every
	// timezone.
	const archiveMtime = new Date(1980, 0, 1, 0, 0, 0)
	const zipBuffer = Buffer.from(
		zipSync(
			{
				'source.ts': strToU8(source),
				'bundle.js': strToU8(bundle),
				...(permissions === undefined
					? {}
					: { 'permissions.json': strToU8(permissions) }),
			},
			{
				level: 6,
				mtime: archiveMtime,
			},
		),
	)
	const checksum = createHash('sha256').update(zipBuffer).digest('hex')

	return {
		zipBuffer,
		checksum,
	}
}
