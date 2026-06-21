import { createHash } from 'node:crypto'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

export interface CompressResult {
	zipBuffer: Uint8Array
	checksum: string
}

export interface DecompressResult {
	source: string
	bundle: string
}

// Maximum sizes for ZIP bomb protection
const MAX_ZIP_SIZE = 10 * 1024 * 1024 // 10MB compressed
const MAX_DECOMPRESSED_SIZE = 50 * 1024 * 1024 // 50MB decompressed
const MAX_FILE_COUNT = 16 // task archives only ever hold source.ts + bundle.js

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

/**
 * Decompress ZIP archive and extract source and bundle files
 * Uses fflate for fast decompression
 * Includes ZIP bomb protection
 */
export function decompressTask(
	zipBuffer: Uint8Array | ArrayBuffer,
): DecompressResult {
	// Convert ArrayBuffer to Uint8Array if needed
	const uint8Array =
		zipBuffer instanceof ArrayBuffer ? new Uint8Array(zipBuffer) : zipBuffer

	// ZIP bomb protection: check compressed size
	if (uint8Array.length > MAX_ZIP_SIZE) {
		throw new Error(
			`ZIP file too large: ${uint8Array.length} bytes (max: ${MAX_ZIP_SIZE})`,
		)
	}

	// ZIP bomb protection: bound memory BEFORE inflating. fflate's `filter`
	// runs per entry with the declared uncompressed size (`originalSize`) and
	// never inflates an entry beyond it, so skipping unwanted entries and
	// rejecting on the declared total caps real memory use and defeats zip
	// bombs without ever materialising them.
	let declaredTotal = 0
	let fileCount = 0
	const decompressed = unzipSync(uint8Array, {
		filter(file) {
			if (++fileCount > MAX_FILE_COUNT) {
				throw new Error(
					`Too many files in ZIP archive (max: ${MAX_FILE_COUNT})`,
				)
			}
			// Only inflate the two files we need; everything else is skipped and
			// therefore can never expand in memory.
			const wanted = file.name === 'source.ts' || file.name === 'bundle.js'
			if (!wanted) {
				return false
			}
			declaredTotal += file.originalSize
			if (declaredTotal > MAX_DECOMPRESSED_SIZE) {
				throw new Error(
					`Decompressed content too large: ${declaredTotal} bytes (max: ${MAX_DECOMPRESSED_SIZE})`,
				)
			}
			return true
		},
	})

	// Extract files
	const sourceBytes = decompressed['source.ts']
	const bundleBytes = decompressed['bundle.js']

	if (!sourceBytes) {
		throw new Error('source.ts not found in ZIP archive')
	}

	if (!bundleBytes) {
		throw new Error('bundle.js not found in ZIP archive')
	}

	// Convert bytes to strings
	const source = strFromU8(sourceBytes)
	const bundle = strFromU8(bundleBytes)

	return {
		source,
		bundle,
	}
}
