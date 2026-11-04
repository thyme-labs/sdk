import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'
import { decodeTriggerEvent, isEventTrigger } from '../src/trigger'
import type { EventTriggerContext, TriggerContext } from '../src/types'

const transfer = parseAbiItem(
	'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const FROM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const TO = '0x000000000000000000000000000000000000dEaD'

const eventTrigger: EventTriggerContext = {
	type: 'event',
	chainId: 11155111,
	log: {
		address: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
		topics: encodeEventTopics({
			abi: [transfer],
			eventName: 'Transfer',
			args: { from: FROM, to: TO },
		}),
		data: encodeAbiParameters([{ type: 'uint256' }], [1000n]),
		blockNumber: 7_000_000n,
		blockHash: `0x${'ab'.repeat(32)}`,
		transactionHash: `0x${'cd'.repeat(32)}`,
		transactionIndex: 3,
		logIndex: 12,
	},
	blockTimestamp: 1_760_000_000,
	event: {
		name: 'Transfer',
		signature:
			'event Transfer(address indexed from, address indexed to, uint256 value)',
	},
}

describe('isEventTrigger', () => {
	test('is true only for event runs', () => {
		expect(isEventTrigger({ trigger: eventTrigger })).toBe(true)
		expect(isEventTrigger({ trigger: { type: 'cron' } })).toBe(false)
		expect(isEventTrigger({ trigger: { type: 'webhook', name: 'hook' } })).toBe(
			false,
		)
		expect(isEventTrigger({})).toBe(false)
	})
})

describe('decodeTriggerEvent', () => {
	test('decodes the triggering log with typed arguments', () => {
		const decoded = decodeTriggerEvent({ trigger: eventTrigger }, transfer)
		expect(decoded?.eventName).toBe('Transfer')
		expect(decoded?.args).toEqual({ from: FROM, to: TO, value: 1000n })
	})

	test('returns null when the run was not started by an event', () => {
		const trigger: TriggerContext = { type: 'manual' }
		expect(decodeTriggerEvent({ trigger }, transfer)).toBeNull()
		expect(decodeTriggerEvent({}, transfer)).toBeNull()
	})

	test('returns null when the log does not match the event', () => {
		const approval = parseAbiItem(
			'event Approval(address indexed owner, address indexed spender, uint256 value)',
		)
		expect(decodeTriggerEvent({ trigger: eventTrigger }, approval)).toBeNull()

		// Same topic0, but `value` declared indexed: the log has no fourth topic.
		const indexedValue = parseAbiItem(
			'event Transfer(address indexed from, address indexed to, uint256 indexed value)',
		)
		expect(
			decodeTriggerEvent({ trigger: eventTrigger }, indexedValue),
		).toBeNull()
	})
})
