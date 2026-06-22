import { describe, expect, test } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { compressTask, decompressTask } from '../src/archive'

describe('compressTask', () => {
	test('produces a zip buffer and a checksum', () => {
		const { zipBuffer, checksum } = compressTask('const a = 1', 'var a=1')
		expect(zipBuffer).toBeInstanceOf(Uint8Array)
		expect(zipBuffer.length).toBeGreaterThan(0)
		expect(checksum).toMatch(/^[0-9a-f]{64}$/)
	})

	test('checksum is the sha256 of the produced zip bytes', () => {
		const { zipBuffer, checksum } = compressTask('source', 'bundle')
		// Recompute independently to confirm the checksum covers the archive.
		const hasher = new Bun.CryptoHasher('sha256')
		hasher.update(zipBuffer)
		expect(checksum).toBe(hasher.digest('hex'))
	})

	test('round-trips through decompressTask without loss', () => {
		const source = 'export default defineTask({ /* ... */ })'
		const bundle = 'console.log("bundled")'
		const { zipBuffer } = compressTask(source, bundle)
		const result = decompressTask(zipBuffer)
		expect(result.source).toBe(source)
		expect(result.bundle).toBe(bundle)
	})

	test('preserves unicode content exactly', () => {
		const source = '// emoji ✅ and accents éàü and 日本語'
		const { zipBuffer } = compressTask(source, 'x')
		expect(decompressTask(zipBuffer).source).toBe(source)
	})

	test('handles empty source and bundle', () => {
		const { zipBuffer } = compressTask('', '')
		const result = decompressTask(zipBuffer)
		expect(result.source).toBe('')
		expect(result.bundle).toBe('')
	})
})

describe('decompressTask', () => {
	test('accepts an ArrayBuffer as well as a Uint8Array', () => {
		const { zipBuffer } = compressTask('src', 'bnd')
		const arrayBuffer = zipBuffer.buffer.slice(
			zipBuffer.byteOffset,
			zipBuffer.byteOffset + zipBuffer.byteLength,
		)
		const result = decompressTask(arrayBuffer)
		expect(result.source).toBe('src')
		expect(result.bundle).toBe('bnd')
	})

	test('throws when source.ts is missing', () => {
		const zip = zipSync({ 'bundle.js': strToU8('only bundle') })
		expect(() => decompressTask(zip)).toThrow('source.ts not found')
	})

	test('throws when bundle.js is missing', () => {
		const zip = zipSync({ 'source.ts': strToU8('only source') })
		expect(() => decompressTask(zip)).toThrow('bundle.js not found')
	})

	test('throws on non-zip / corrupt data', () => {
		expect(() => decompressTask(new Uint8Array([1, 2, 3, 4]))).toThrow()
	})

	test('rejects a compressed archive larger than 10MB (zip-bomb guard)', () => {
		// A buffer over MAX_ZIP_SIZE should be rejected before any unzip work.
		const oversized = new Uint8Array(10 * 1024 * 1024 + 1)
		expect(() => decompressTask(oversized)).toThrow('ZIP file too large')
	})

	test('rejects an archive whose decompressed size exceeds 50MB', () => {
		// ~51MB of a single repeated byte compresses to a tiny archive but
		// exceeds MAX_DECOMPRESSED_SIZE once expanded.
		const big = new Uint8Array(51 * 1024 * 1024).fill(65)
		const zip = zipSync({
			'source.ts': big,
			'bundle.js': strToU8('x'),
		})
		expect(() => decompressTask(zip)).toThrow('Decompressed content too large')
	})

	test('rejects an archive with too many entries before inflating', () => {
		const files: Record<string, Uint8Array> = {
			'source.ts': strToU8('s'),
			'bundle.js': strToU8('b'),
		}
		for (let i = 0; i < 20; i++) {
			files[`junk-${i}.txt`] = strToU8('x')
		}
		expect(() => decompressTask(zip(files))).toThrow('Too many files')
	})

	test('ignores extra junk entries instead of inflating them', () => {
		// A 60MB junk entry would blow the decompressed cap if inflated, but it is
		// not one of the two files we extract, so the filter skips it entirely and
		// decompression succeeds.
		const junk = new Uint8Array(60 * 1024 * 1024).fill(65)
		const result = decompressTask(
			zip({
				'source.ts': strToU8('the source'),
				'bundle.js': strToU8('the bundle'),
				'huge.bin': junk,
			}),
		)
		expect(result.source).toBe('the source')
		expect(result.bundle).toBe('the bundle')
	})
})

// Local helper to keep the new tests terse.
function zip(files: Record<string, Uint8Array>): Uint8Array {
	return zipSync(files)
}
