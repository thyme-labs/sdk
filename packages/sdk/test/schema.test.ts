import { describe, expect, test } from 'bun:test'
import { zodExtended as z } from '../src/schema'

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

describe('z.address()', () => {
	test('accepts a checksummed address and returns it unchanged', () => {
		expect(z.address().parse(VITALIK)).toBe(VITALIK)
	})

	test('accepts a lowercase address and returns the checksummed form', () => {
		expect(z.address().parse(VITALIK.toLowerCase())).toBe(VITALIK)
	})

	test('rejects an all-uppercase-hex address (fails EIP-55 checksum)', () => {
		// viem's isAddress does strict checksum validation by default, so a fully
		// uppercased address is treated as a mis-checksummed (invalid) address.
		// Only all-lowercase or correctly-checksummed addresses are accepted.
		const upper = `0x${VITALIK.slice(2).toUpperCase()}`
		expect(z.address().safeParse(upper).success).toBe(false)
	})

	test('rejects an address without the 0x prefix', () => {
		const result = z.address().safeParse(VITALIK.slice(2))
		expect(result.success).toBe(false)
	})

	test('rejects an address of the wrong length', () => {
		expect(z.address().safeParse('0x1234').success).toBe(false)
	})

	test('rejects a non-hex string', () => {
		const result = z.address().safeParse(`0x${'z'.repeat(40)}`)
		expect(result.success).toBe(false)
	})

	test('rejects a non-string value', () => {
		expect(z.address().safeParse(12345).success).toBe(false)
	})

	test('surfaces the custom error message on failure', () => {
		const result = z.address().safeParse('not-an-address')
		expect(result.success).toBe(false)
		if (!result.success) {
			expect(result.error.issues[0]?.message).toBe('Invalid Ethereum address')
		}
	})

	test('composes inside z.object like a normal field', () => {
		const schema = z.object({ target: z.address() })
		const parsed = schema.parse({ target: VITALIK.toLowerCase() })
		expect(parsed.target).toBe(VITALIK)
	})
})

describe('zodExtended spreads the base zod API', () => {
	test('still exposes z.string / z.number / z.object', () => {
		expect(z.string().parse('hi')).toBe('hi')
		expect(z.number().parse(3)).toBe(3)
		expect(z.object({ a: z.string() }).parse({ a: 'b' })).toEqual({ a: 'b' })
	})
})
