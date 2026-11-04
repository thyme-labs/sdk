import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	encodeAbiParameters,
	encodeEventTopics,
	type Hex,
	parseAbiItem,
	toHex,
} from 'viem'
import {
	eventDecodeProblem,
	fetchEventTrigger,
	loadEventTriggerFile,
	normalizeEventSignature,
	parseEventSignature,
	selectTriggerLog,
} from '../src/utils/trigger'

const SIGNATURE =
	'event Transfer(address indexed from, address indexed to, uint256 value)'
const transfer = parseAbiItem(SIGNATURE)
const approval = parseAbiItem(
	'event Approval(address indexed owner, address indexed spender, uint256 value)',
)
const FROM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const TO = '0x000000000000000000000000000000000000dEaD'
const TOKEN = '0xFFF9976782d46CC05630D1f6eBAb18b2324d6B14'
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as const
const TX_HASH = `0x${'cd'.repeat(32)}` as const

const transferTopics = encodeEventTopics({
	abi: [transfer],
	eventName: 'Transfer',
	args: { from: FROM, to: TO },
})
const approvalTopics = encodeEventTopics({
	abi: [approval],
	eventName: 'Approval',
	args: { owner: FROM, spender: TO },
})
const amount = encodeAbiParameters([{ type: 'uint256' }], [1000n])

const receiptLog = (logIndex: number, topics: Hex[]) => ({
	address: TOKEN,
	topics,
	data: amount,
	blockNumber: 7_000_000n,
	blockHash: BLOCK_HASH,
	transactionHash: TX_HASH,
	transactionIndex: 3,
	logIndex,
})

const validPayload = {
	type: 'event',
	chainId: 11155111,
	eventName: 'Transfer',
	eventSignature: SIGNATURE,
	log: {
		address: TOKEN.toLowerCase(),
		topics: transferTopics,
		data: amount,
		blockNumber: 7_000_000,
		blockHash: BLOCK_HASH,
		transactionHash: TX_HASH,
		transactionIndex: 3,
		logIndex: 12,
	},
	blockTimestamp: 1_760_000_000,
}

let dir = ''

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'thyme-trigger-'))
})

afterAll(() => {
	rmSync(dir, { recursive: true, force: true })
})

describe('event signatures', () => {
	test('normalizes to the stored `event Name(...)` form', () => {
		expect(normalizeEventSignature('  Transfer(uint256 a) ')).toBe(
			'event Transfer(uint256 a)',
		)
		expect(normalizeEventSignature(SIGNATURE)).toBe(SIGNATURE)
	})

	test('parses with or without the event keyword', () => {
		expect(parseEventSignature(SIGNATURE)).toEqual(transfer)
		expect(
			parseEventSignature(
				'Transfer(address indexed from, address indexed to, uint256 value)',
			),
		).toEqual(transfer)
	})

	test('rejects invalid and non-event signatures', () => {
		expect(() => parseEventSignature('Transfer(')).toThrow(
			'Invalid event signature "Transfer("',
		)
		expect(() =>
			parseEventSignature('function transfer(address to, uint256 value)'),
		).toThrow('Invalid event signature')
	})
})

describe('loadEventTriggerFile', () => {
	test('reads a payload in the THYME_TRIGGER_JSON shape', async () => {
		const path = join(dir, 'valid.json')
		writeFileSync(path, JSON.stringify(validPayload))
		expect(await loadEventTriggerFile(path)).toEqual(
			validPayload as Awaited<ReturnType<typeof loadEventTriggerFile>>,
		)
	})

	test('reports unreadable and malformed files', async () => {
		await expect(
			loadEventTriggerFile(join(dir, 'missing.json')),
		).rejects.toThrow('Failed to read event file')
		const path = join(dir, 'garbage.json')
		writeFileSync(path, '{not json')
		await expect(loadEventTriggerFile(path)).rejects.toThrow(
			`Failed to read event file ${path}`,
		)
	})

	test('names each invalid field', async () => {
		const path = join(dir, 'invalid.json')
		writeFileSync(
			path,
			JSON.stringify({
				...validPayload,
				log: { ...validPayload.log, address: '0x1234', logIndex: -1 },
			}),
		)
		await expect(loadEventTriggerFile(path)).rejects.toThrow(
			`Event file ${path} is invalid: log.address: must be a 20-byte 0x-prefixed address`,
		)
		await expect(loadEventTriggerFile(path)).rejects.toThrow('log.logIndex')

		writeFileSync(path, JSON.stringify([]))
		await expect(loadEventTriggerFile(path)).rejects.toThrow(
			`Event file ${path} is invalid: `,
		)
	})
})

describe('selectTriggerLog', () => {
	const logs = [receiptLog(11, approvalTopics), receiptLog(12, transferTopics)]

	test('picks by logIndex, then by event, then the first log', () => {
		expect(selectTriggerLog(logs, { logIndex: 12 }).logIndex).toBe(12)
		expect(
			selectTriggerLog(logs, { logIndex: 11, abiEvent: transfer }).logIndex,
		).toBe(11)
		expect(selectTriggerLog(logs, { abiEvent: transfer }).logIndex).toBe(12)
		expect(selectTriggerLog(logs, {}).logIndex).toBe(11)
	})

	test('explains when no log fits', () => {
		expect(() => selectTriggerLog([], {})).toThrow(
			'The transaction emitted no logs',
		)
		expect(() => selectTriggerLog(logs, { logIndex: 0 })).toThrow(
			'Its logs: 11, 12',
		)
		expect(() => selectTriggerLog([logs[0]!], { abiEvent: transfer })).toThrow(
			'pass --log-index to pick one',
		)
	})
})

describe('eventDecodeProblem', () => {
	type Payload = Parameters<typeof eventDecodeProblem>[0]
	const payload = validPayload as Payload

	test('is undefined when the signature decodes the log', () => {
		expect(eventDecodeProblem(payload)).toBeUndefined()
	})

	test('explains why args will be undefined', () => {
		expect(eventDecodeProblem({ ...payload, eventSignature: '' })).toBe(
			'no event signature was given',
		)
		expect(
			eventDecodeProblem({
				...payload,
				eventSignature:
					'event Approval(address indexed owner, address indexed spender, uint256 value)',
			}),
		).toContain('not found on ABI')
	})
})

describe('fetchEventTrigger', () => {
	const methods: string[] = []
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const { id, method } = (await request.json()) as {
				id: number
				method: string
			}
			methods.push(method)
			const results: Record<string, unknown> = {
				eth_chainId: toHex(11155111),
				eth_getTransactionReceipt: {
					blockHash: BLOCK_HASH,
					blockNumber: toHex(7_000_000),
					from: FROM,
					to: TOKEN,
					status: '0x1',
					transactionHash: TX_HASH,
					transactionIndex: '0x3',
					logs: [11, 12].map((logIndex) => ({
						address: TOKEN,
						topics: logIndex === 11 ? approvalTopics : transferTopics,
						data: amount,
						blockNumber: toHex(7_000_000),
						blockHash: BLOCK_HASH,
						transactionHash: TX_HASH,
						transactionIndex: '0x3',
						logIndex: toHex(logIndex),
						removed: false,
					})),
				},
				eth_getBlockByHash: {
					hash: BLOCK_HASH,
					number: toHex(7_000_000),
					timestamp: toHex(1_760_000_000),
					transactions: [],
				},
			}
			return Response.json({ jsonrpc: '2.0', id, result: results[method] })
		},
	})
	const rpcUrl = `http://localhost:${server.port}`

	afterAll(() => {
		server.stop(true)
	})

	test('builds the payload the cloud builds for the matching log', async () => {
		expect(
			await fetchEventTrigger({
				rpcUrl,
				txHash: TX_HASH,
				eventSignature:
					'Transfer(address indexed from, address indexed to, uint256 value)',
			}),
		).toEqual(validPayload as Awaited<ReturnType<typeof fetchEventTrigger>>)
		expect(methods).toContain('eth_getBlockByHash')
	})

	test('without a signature, takes the log at logIndex undecoded', async () => {
		const payload = await fetchEventTrigger({
			rpcUrl,
			txHash: TX_HASH,
			logIndex: 11,
		})
		expect(payload.eventName).toBe('')
		expect(payload.eventSignature).toBe('')
		expect(payload.log.logIndex).toBe(11)
		expect(payload.log.topics).toEqual(approvalTopics)
	})

	test('rejects a malformed hash before calling the RPC', async () => {
		methods.length = 0
		await expect(
			fetchEventTrigger({ rpcUrl, txHash: '0x1234' }),
		).rejects.toThrow('--event-tx must be a 32-byte')
		expect(methods).toEqual([])
	})
})
