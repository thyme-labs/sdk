import { readFile } from 'node:fs/promises'
import {
	type AbiEvent,
	createPublicClient,
	decodeEventLog,
	type Hash,
	type Hex,
	http,
	isHash,
	parseAbiItem,
	toEventSelector,
} from 'viem'
import { z } from 'zod'

const hexSchema = z
	.string()
	.regex(/^0x[0-9a-fA-F]*$/, 'must be 0x-prefixed hex')
const hashSchema = z
	.string()
	.regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte 0x-prefixed hex value')
const indexSchema = z.number().int().nonnegative()

/**
 * The `THYME_TRIGGER_JSON` payload of an event run, as the cloud sets it.
 * `blockTimestamp` is unix seconds.
 */
export const eventTriggerPayloadSchema = z.object({
	type: z.literal('event'),
	chainId: z.number().int().positive(),
	eventName: z.string(),
	eventSignature: z.string(),
	log: z.object({
		address: z
			.string()
			.regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte 0x-prefixed address'),
		topics: z.array(hashSchema).max(4),
		data: hexSchema,
		blockNumber: indexSchema,
		blockHash: hashSchema,
		transactionHash: hashSchema,
		transactionIndex: indexSchema,
		logIndex: indexSchema,
	}),
	blockTimestamp: indexSchema,
})

export type EventTriggerPayload = z.infer<typeof eventTriggerPayloadSchema>

/** What `thyme run` passes as `THYME_TRIGGER_JSON`. */
export type TriggerPayload = { type: 'manual' } | EventTriggerPayload

/** `Name(...)` or `event Name(...)` as the `event Name(...)` the cloud stores. */
export function normalizeEventSignature(signature: string): string {
	const trimmed = signature.trim()
	return trimmed.startsWith('event ') ? trimmed : `event ${trimmed}`
}

export function parseEventSignature(signature: string): AbiEvent {
	let item: ReturnType<typeof parseAbiItem>
	try {
		item = parseAbiItem(normalizeEventSignature(signature))
	} catch (err) {
		throw new Error(
			`Invalid event signature "${signature}": ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	if (item.type !== 'event') {
		throw new Error(`"${signature}" is not an event signature`)
	}
	return item
}

/** Read an event payload file in the `THYME_TRIGGER_JSON` shape. */
export async function loadEventTriggerFile(
	path: string,
): Promise<EventTriggerPayload> {
	let parsed: unknown
	try {
		parsed = JSON.parse(await readFile(path, 'utf-8'))
	} catch (err) {
		throw new Error(
			`Failed to read event file ${path}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	const result = eventTriggerPayloadSchema.safeParse(parsed)
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) =>
				issue.path.length > 0
					? `${issue.path.join('.')}: ${issue.message}`
					: issue.message,
			)
			.join('; ')
		throw new Error(`Event file ${path} is invalid: ${issues}`)
	}
	return result.data
}

type ReceiptLog = {
	address: string
	topics: readonly Hex[]
	data: Hex
	blockNumber: bigint
	blockHash: Hash
	transactionHash: Hash
	transactionIndex: number
	logIndex: number
}

/**
 * Pick the triggering log: by block-level `logIndex`, else the first log
 * whose topic0 matches `abiEvent`; with neither, the first log.
 */
export function selectTriggerLog<TLog extends ReceiptLog>(
	logs: readonly TLog[],
	options: { logIndex?: number; abiEvent?: AbiEvent },
): TLog {
	if (logs.length === 0) {
		throw new Error('The transaction emitted no logs')
	}
	if (options.logIndex !== undefined) {
		const log = logs.find((item) => item.logIndex === options.logIndex)
		if (!log) {
			throw new Error(
				`The transaction has no log with logIndex ${options.logIndex} (logIndex counts within the block). Its logs: ${logs.map((item) => item.logIndex).join(', ')}`,
			)
		}
		return log
	}
	if (options.abiEvent) {
		const topic0 = toEventSelector(options.abiEvent)
		const log = logs.find((item) => item.topics[0]?.toLowerCase() === topic0)
		if (!log) {
			throw new Error(
				'No log in the transaction matches the event signature; pass --log-index to pick one',
			)
		}
		return log
	}
	return logs[0]!
}

/**
 * Build the event payload for a log of a mined transaction, read through
 * `rpcUrl`, the same way the cloud builds it for a matched log.
 */
export async function fetchEventTrigger(options: {
	rpcUrl: string
	txHash: string
	logIndex?: number
	eventSignature?: string
}): Promise<EventTriggerPayload> {
	if (!isHash(options.txHash)) {
		throw new Error('--event-tx must be a 32-byte 0x-prefixed transaction hash')
	}
	const abiEvent = options.eventSignature
		? parseEventSignature(options.eventSignature)
		: undefined
	const client = createPublicClient({ transport: http(options.rpcUrl) })
	const [chainId, receipt] = await Promise.all([
		client.getChainId(),
		client.getTransactionReceipt({ hash: options.txHash }),
	])
	const log = selectTriggerLog(receipt.logs, {
		logIndex: options.logIndex,
		abiEvent,
	})
	const block = await client.getBlock({ blockHash: receipt.blockHash })

	return {
		type: 'event',
		chainId,
		eventName: abiEvent?.name ?? '',
		eventSignature: options.eventSignature
			? normalizeEventSignature(options.eventSignature)
			: '',
		log: {
			address: log.address.toLowerCase(),
			topics: [...log.topics],
			data: log.data,
			blockNumber: Number(log.blockNumber),
			blockHash: log.blockHash,
			transactionHash: log.transactionHash,
			transactionIndex: log.transactionIndex,
			logIndex: log.logIndex,
		},
		blockTimestamp: Number(block.timestamp),
	}
}

/**
 * Why `ctx.trigger.event.args` will be undefined for this payload, if it
 * will be: the run itself never fails on a log it cannot decode.
 */
export function eventDecodeProblem(
	payload: EventTriggerPayload,
): string | undefined {
	if (!payload.eventSignature) {
		return 'no event signature was given'
	}
	try {
		// Same call as the runtime wrapper, so a file's signature is held to it too.
		decodeEventLog({
			abi: [parseAbiItem(payload.eventSignature)],
			topics: payload.log.topics as [Hex, ...Hex[]],
			data: payload.log.data as Hex,
		})
		return undefined
	} catch (err) {
		return err instanceof Error ? err.message.split('\n')[0] : String(err)
	}
}
