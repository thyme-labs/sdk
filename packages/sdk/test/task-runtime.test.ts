import { describe, expect, test } from 'bun:test'
import {
	decodeEventLog,
	encodeAbiParameters,
	encodeEventTopics,
	parseAbiItem,
} from 'viem'
import {
	CLOUD_TASK_RUNNER_SOURCE,
	TASK_RUNTIME_OUTPUT_PREFIXES,
	TRIGGER_CONTEXT_SOURCE,
} from '../src/task-runtime'

// The runtime source is plain JS that expects viem's helpers in scope, the way
// the Deno wrappers import them.
const readTriggerContext = new Function(
	'decodeEventLog',
	'parseAbiItem',
	`${TRIGGER_CONTEXT_SOURCE}\nreturn readTriggerContext`,
)(decodeEventLog, parseAbiItem) as (raw: unknown) => unknown

const SIGNATURE =
	'event Transfer(address indexed from, address indexed to, uint256 value)'
const FROM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const TO = '0x000000000000000000000000000000000000dEaD'

// `THYME_TRIGGER_JSON` as the backend sets it for a matched log.
const eventPayload = {
	type: 'event',
	chainId: 11155111,
	eventName: 'Transfer',
	eventSignature: SIGNATURE,
	log: {
		address: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
		topics: encodeEventTopics({
			abi: [parseAbiItem(SIGNATURE)],
			eventName: 'Transfer',
			args: { from: FROM, to: TO },
		}),
		data: encodeAbiParameters([{ type: 'uint256' }], [1000n]),
		blockNumber: 7_000_000,
		blockHash: `0x${'ab'.repeat(32)}`,
		transactionHash: `0x${'cd'.repeat(32)}`,
		transactionIndex: 3,
		logIndex: 12,
	},
	blockTimestamp: 1_760_000_000,
}

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

describe('trigger context', () => {
	test('cloud runner builds ctx.trigger from THYME_TRIGGER_JSON', () => {
		expect(CLOUD_TASK_RUNNER_SOURCE).toContain(TRIGGER_CONTEXT_SOURCE)
		expect(CLOUD_TASK_RUNNER_SOURCE).toContain(
			"Deno.env.get('THYME_TRIGGER_JSON')",
		)
		expect(CLOUD_TASK_RUNNER_SOURCE).toContain(
			'const trigger = readTriggerContext(readTriggerEnv())',
		)
		expect(CLOUD_TASK_RUNNER_SOURCE).toContain('trigger,')
	})

	test('passes through schedule, manual and webhook triggers', () => {
		for (const type of ['cron', 'interval', 'manual']) {
			expect(readTriggerContext(JSON.stringify({ type, extra: 1 }))).toEqual({
				type,
			})
		}
		expect(
			readTriggerContext(JSON.stringify({ type: 'webhook', name: 'deploy' })),
		).toEqual({ type: 'webhook', name: 'deploy' })
		expect(readTriggerContext(JSON.stringify({ type: 'webhook' }))).toEqual({
			type: 'webhook',
		})
	})

	test('builds an event trigger with decoded arguments', () => {
		const trigger = readTriggerContext(JSON.stringify(eventPayload))
		expect(trigger).toEqual({
			type: 'event',
			chainId: 11155111,
			log: { ...eventPayload.log, blockNumber: 7_000_000n },
			blockTimestamp: 1_760_000_000,
			event: {
				name: 'Transfer',
				signature: SIGNATURE,
				args: { from: FROM, to: TO, value: 1000n },
			},
		})
	})

	test('keeps the raw log when the signature does not decode it', () => {
		for (const eventSignature of [
			'event Approval(address indexed owner, address indexed spender, uint256 value)',
			'not a signature',
			undefined,
		]) {
			const trigger = readTriggerContext(
				JSON.stringify({ ...eventPayload, eventSignature }),
			) as { log: unknown; event: Record<string, unknown> }
			expect(trigger.log).toEqual({
				...eventPayload.log,
				blockNumber: 7_000_000n,
			})
			expect(trigger.event.signature).toBe(eventSignature ?? '')
			expect(trigger.event.args).toBeUndefined()
		}
		const unnamed = readTriggerContext(
			JSON.stringify({ ...eventPayload, eventName: 42 }),
		) as { event: { name: string } }
		expect(unnamed.event.name).toBe('')
	})

	test('ignores missing, malformed and unknown payloads', () => {
		for (const raw of [
			undefined,
			'',
			42,
			'{not json',
			'null',
			'[]',
			'"event"',
			JSON.stringify({ type: 'block' }),
			JSON.stringify({ ...eventPayload, chainId: '11155111' }),
			JSON.stringify({ ...eventPayload, blockTimestamp: undefined }),
			JSON.stringify({ ...eventPayload, log: null }),
			JSON.stringify({ ...eventPayload, log: 'log' }),
			JSON.stringify({
				...eventPayload,
				log: { ...eventPayload.log, topics: 'x' },
			}),
			JSON.stringify({
				...eventPayload,
				log: { ...eventPayload.log, blockNumber: 'x' },
			}),
		]) {
			expect(readTriggerContext(raw)).toBeUndefined()
		}
	})
})
