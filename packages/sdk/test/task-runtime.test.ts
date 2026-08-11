import { describe, expect, test } from 'bun:test'
import {
	CLOUD_TASK_RUNNER_SOURCE,
	TASK_RUNTIME_OUTPUT_PREFIXES,
} from '../src/task-runtime'

describe('task runtime contract', () => {
	test('defines distinct reserved output markers', () => {
		const markers = Object.values(TASK_RUNTIME_OUTPUT_PREFIXES)
		expect(new Set(markers).size).toBe(markers.length)
		expect(markers.every((marker) => marker.startsWith('__THYME_'))).toBe(true)
	})

	test('cloud runner uses the shared protocol and lifecycle contract', () => {
		for (const marker of [
			TASK_RUNTIME_OUTPUT_PREFIXES.log,
			TASK_RUNTIME_OUTPUT_PREFIXES.result,
			TASK_RUNTIME_OUTPUT_PREFIXES.storage,
			TASK_RUNTIME_OUTPUT_PREFIXES.callbacks,
		]) {
			expect(CLOUD_TASK_RUNNER_SOURCE).toContain(marker)
		}
		for (const callback of ['onSuccess', 'onSkip', 'onError', 'onFail']) {
			expect(CLOUD_TASK_RUNNER_SOURCE).toContain(callback)
		}
		expect(CLOUD_TASK_RUNNER_SOURCE).toContain('await task.run(context)')
		expect(CLOUD_TASK_RUNNER_SOURCE).toContain("phase === 'callback'")
		expect(CLOUD_TASK_RUNNER_SOURCE).toContain("Deno.env.get('THYME_ACCOUNT')")
		expect(CLOUD_TASK_RUNNER_SOURCE).toContain('account,')
	})
})
