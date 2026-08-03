import { describe, expect, test } from 'bun:test'
import {
	isLifecycleCallbackName,
	LIFECYCLE_CALLBACK_NAMES,
	normalizeLifecycleCallbackNames,
} from '../src/lifecycle'

describe('lifecycle callback contracts', () => {
	test('exposes the canonical callback order', () => {
		expect(LIFECYCLE_CALLBACK_NAMES).toEqual([
			'onSuccess',
			'onSkip',
			'onError',
			'onFail',
		])
	})

	test('recognizes and normalizes callback metadata', () => {
		expect(isLifecycleCallbackName('onSuccess')).toBe(true)
		expect(isLifecycleCallbackName('unknown')).toBe(false)
		expect(
			normalizeLifecycleCallbackNames(['onFail', 'unknown', 'onSkip']),
		).toEqual(['onFail', 'onSkip'])
	})
})
