import { strFromU8, unzipSync } from 'fflate'

export interface DecompressResult {
	source: string
	bundle: string
}

// Task archives contain source.ts + bundle.js. The limits are enforced before
// inflation so this reader is safe to use at upload and execution boundaries.
const MAX_ZIP_SIZE = 10 * 1024 * 1024
const MAX_DECOMPRESSED_SIZE = 50 * 1024 * 1024
const MAX_FILE_COUNT = 16

export function decompressTask(
	zipBuffer: Uint8Array | ArrayBuffer,
): DecompressResult {
	const uint8Array =
		zipBuffer instanceof ArrayBuffer ? new Uint8Array(zipBuffer) : zipBuffer

	if (uint8Array.length > MAX_ZIP_SIZE) {
		throw new Error(
			`ZIP file too large: ${uint8Array.length} bytes (max: ${MAX_ZIP_SIZE})`,
		)
	}

	let declaredTotal = 0
	let fileCount = 0
	const decompressed = unzipSync(uint8Array, {
		filter(file) {
			if (++fileCount > MAX_FILE_COUNT) {
				throw new Error(
					`Too many files in ZIP archive (max: ${MAX_FILE_COUNT})`,
				)
			}

			const wanted = file.name === 'source.ts' || file.name === 'bundle.js'
			if (!wanted) return false

			declaredTotal += file.originalSize
			if (declaredTotal > MAX_DECOMPRESSED_SIZE) {
				throw new Error(
					`Decompressed content too large: ${declaredTotal} bytes (max: ${MAX_DECOMPRESSED_SIZE})`,
				)
			}
			return true
		},
	})

	const sourceBytes = decompressed['source.ts']
	const bundleBytes = decompressed['bundle.js']
	if (!sourceBytes) throw new Error('source.ts not found in ZIP archive')
	if (!bundleBytes) throw new Error('bundle.js not found in ZIP archive')

	return {
		source: strFromU8(sourceBytes),
		bundle: strFromU8(bundleBytes),
	}
}
