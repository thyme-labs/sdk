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
 */
export function compressTask(source: string, bundle: string): CompressResult {
	// Create ZIP archive with both files
	const files = {
		'source.ts': strToU8(source),
		'bundle.js': strToU8(bundle),
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
