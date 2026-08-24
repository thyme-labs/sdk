import { createHash } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'

export interface CompressResult {
	zipBuffer: Buffer
	checksum: string
}

/**
 * Compress source and bundle into a deterministic ZIP archive. ZIP timestamps
 * default to the current time, which makes an unchanged function produce a new
 * checksum every two seconds and defeats the upload endpoint's idempotency.
 */
export function compressTask(source: string, bundle: string): CompressResult {
	// ZIP's DOS timestamp starts at 1980. Construct it in local time because
	// fflate serializes local date fields; this yields identical bytes in every
	// timezone.
	const archiveMtime = new Date(1980, 0, 1, 0, 0, 0)
	const zipBuffer = Buffer.from(
		zipSync(
			{
				'source.ts': strToU8(source),
				'bundle.js': strToU8(bundle),
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
