import {
	type AbiEvent,
	type DecodeEventLogReturnType,
	decodeEventLog,
	type Hex,
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
 * does not match `abiEvent` (different signature or indexed layout).
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
