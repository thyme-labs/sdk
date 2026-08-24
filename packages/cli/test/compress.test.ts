import { describe, expect, test } from 'bun:test'
import { decompressTask } from '@thyme-labs/sdk'
import { compressTask } from '../src/utils/compress'

describe('compressTask (CLI wrapper over the SDK)', () => {
	test('returns a Node Buffer for the archive', () => {
		const { zipBuffer } = compressTask('src', 'bundle')
		expect(Buffer.isBuffer(zipBuffer)).toBe(true)
	})

	test('returns a 64-char sha256 checksum', () => {
		const { checksum } = compressTask('src', 'bundle')
		expect(checksum).toMatch(/^[0-9a-f]{64}$/)
	})

	test('is deterministic when the wall clock changes', () => {
		const originalNow = Date.now
		try {
			Date.now = () => Date.UTC(2020, 0, 1)
			const first = compressTask('src', 'bundle')
			Date.now = () => Date.UTC(2030, 0, 1)
			const second = compressTask('src', 'bundle')

			expect(second.checksum).toBe(first.checksum)
			expect(second.zipBuffer.equals(first.zipBuffer)).toBe(true)
		} finally {
			Date.now = originalNow
		}
	})

	test('archive decompresses back to the original source and bundle', () => {
		const { zipBuffer } = compressTask('the-source', 'the-bundle')
		const result = decompressTask(zipBuffer)
		expect(result.source).toBe('the-source')
		expect(result.bundle).toBe('the-bundle')
	})
})
