import {
	type AbiEvent,
	type DecodeEventLogReturnType,
	decodeEventLog,
	type Hex,
	parseAbiItem,
	toEventSelector,
} from 'viem'
import type { EventTriggerContext, TriggerContext } from './types'

/** Decoded triggering log for a single ABI event. */
export type DecodedTriggerEvent<TEvent extends AbiEvent> =
	DecodeEventLogReturnType<[TEvent]>

/**
 * True when an onchain event started this run; narrows `ctx.trigger`.
 *
 * @example
 * ```typescript
 * if (isEventTrigger(ctx)) {
 *   ctx.logger.info(`Triggered by ${ctx.trigger.log.transactionHash}`)
 * }
 * ```
 */
export function isEventTrigger<TContext extends { trigger?: TriggerContext }>(
	ctx: TContext,
): ctx is TContext & { trigger: EventTriggerContext } {
	return ctx.trigger?.type === 'event'
}

/**
 * Decode the triggering log against `abiEvent` with typed arguments.
 *
 * Returns `null` when the run was not started by an event, or when the log
 * does not match `abiEvent` (different signature, or different indexed
 * arguments than the trigger's event signature).
 *
 * @example
 * ```typescript
 * import { parseAbiItem } from 'viem'
 *
 * const transfer = parseAbiItem(
 *   'event Transfer(address indexed from, address indexed to, uint256 value)',
 * )
 *
 * const event = decodeTriggerEvent(ctx, transfer)
 * if (event) {
 *   ctx.logger.info(`${event.args.from} sent ${event.args.value}`)
 * }
 * ```
 */
export function decodeTriggerEvent<const TEvent extends AbiEvent>(
	ctx: { trigger?: TriggerContext },
	abiEvent: TEvent,
): DecodedTriggerEvent<TEvent> | null {
	if (!isEventTrigger(ctx)) return null
	if (indexedLayoutDiffers(ctx.trigger.event.signature, abiEvent)) return null
	const { topics, data } = ctx.trigger.log
	try {
		return decodeEventLog({
			abi: [abiEvent] as [TEvent],
			topics: topics as [Hex, ...Hex[]],
			data,
		}) as DecodedTriggerEvent<TEvent>
	} catch {
		return null
	}
}

/**
 * True when `signature` is the same event as `abiEvent` but indexes other
 * arguments. A log does not record which arguments were indexed, so decoding
 * alone would return them swapped.
 */
function indexedLayoutDiffers(signature: string, abiEvent: AbiEvent): boolean {
	let item: ReturnType<typeof parseAbiItem>
	try {
		item = parseAbiItem(signature)
	} catch {
		// No usable signature, e.g. a local run without one: decoding decides.
		return false
	}
	return (
		item.type === 'event' &&
		toEventSelector(item) === toEventSelector(abiEvent) &&
		item.inputs.some(
			(input, i) =>
				Boolean(input.indexed) !== Boolean(abiEvent.inputs[i]?.indexed),
		)
	)
}
