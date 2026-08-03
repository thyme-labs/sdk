import { describe, expect, test } from 'bun:test'
import * as sdk from '../src/index'

describe('public barrel exports', () => {
	test('exposes the documented runtime surface', () => {
		expect(typeof sdk.compressTask).toBe('function')
		expect(typeof sdk.decompressTask).toBe('function')
		expect(typeof sdk.createLogger).toBe('function')
		expect(typeof sdk.Logger).toBe('function')
		expect(typeof sdk.defineTask).toBe('function')
		expect(typeof sdk.extractSchemaFromTask).toBe('function')
		expect(sdk.LIFECYCLE_CALLBACK_NAMES).toEqual([
			'onSuccess',
			'onSkip',
			'onError',
			'onFail',
		])
		expect(typeof sdk.z).toBe('object')
		expect(typeof sdk.z.address).toBe('function')
	})
})
