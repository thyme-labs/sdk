import { describe, expect, test } from 'bun:test'
import {
	BaseError,
	InvalidParamsRpcError,
	MethodNotFoundRpcError,
	MethodNotSupportedRpcError,
} from 'viem'
import { isMethodUnsupportedError } from '../src/commands/run'

describe('isMethodUnsupportedError', () => {
	test('treats MethodNotFoundRpcError (-32601) as unsupported', () => {
		expect(
			isMethodUnsupportedError(new MethodNotFoundRpcError(new Error('x'))),
		).toBe(true)
	})

	test('treats MethodNotSupportedRpcError as unsupported', () => {
		expect(
			isMethodUnsupportedError(new MethodNotSupportedRpcError(new Error('x'))),
		).toBe(true)
	})

	test('treats geth-style "does not exist / is not available" text as unsupported', () => {
		expect(
			isMethodUnsupportedError(
				new Error('the method eth_simulateV1 does not exist/is not available'),
			),
		).toBe(true)
		expect(isMethodUnsupportedError(new Error('Method not found'))).toBe(true)
	})

	// The Polygon regression: eth_simulateV1 IS supported but a strict fee check
	// (validation) returns -32602 InvalidParams. This must NOT be downgraded to
	// "unsupported" — otherwise the CLI silently falls back to the weaker path.
	test('does NOT treat -32602 fee-validation errors as unsupported', () => {
		expect(
			isMethodUnsupportedError(
				new InvalidParamsRpcError(
					new Error('max fee per gas less than block base fee'),
				),
			),
		).toBe(false)
	})

	test('does NOT treat contract reverts as unsupported', () => {
		expect(isMethodUnsupportedError(new BaseError('execution reverted'))).toBe(
			false,
		)
		expect(isMethodUnsupportedError(new Error('execution reverted'))).toBe(
			false,
		)
	})

	test('handles non-error values without throwing', () => {
		expect(isMethodUnsupportedError(undefined)).toBe(false)
		expect(isMethodUnsupportedError('some string')).toBe(false)
		expect(isMethodUnsupportedError(null)).toBe(false)
	})
})
