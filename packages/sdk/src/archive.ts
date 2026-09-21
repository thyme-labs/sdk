import { createHash } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'

export type { DecompressResult } from './archive-reader'
export { decompressTask } from './archive-reader'

export interface CompressResult {
	zipBuffer: Uint8Array
	checksum: string
}

/**
 * Calculate SHA-256 checksum of data
 */
function calculateSha256(data: Uint8Array): string {
	return createHash('sha256').update(data).digest('hex')
}

/**
 * Compress source and bundle into a ZIP archive
 * Uses fflate for fast, modern compression
 * Uses SHA-256 for cryptographically secure checksum
 *
 * When `permissions` is given, the raw text of the task's `permissions.json`
 * is added as a third entry. The checksum covers the whole ZIP, so it covers
 * the manifest too. Without it the archive is exactly what it was before.
 */
export function compressTask(
	source: string,
	bundle: string,
	permissions?: string,
): CompressResult {
	const files: Record<string, Uint8Array> = {
		'source.ts': strToU8(source),
		'bundle.js': strToU8(bundle),
	}
	if (typeof permissions === 'string') {
		files['permissions.json'] = strToU8(permissions)
	}

	const compressed = zipSync(files, {
		level: 6, // Balanced compression
	})

	// Calculate SHA-256 checksum
	const checksum = calculateSha256(compressed)

	return {
		zipBuffer: compressed,
		checksum,
	}
}
