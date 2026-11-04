import type { Address, Hex, PublicClient } from 'viem'
import type { z } from 'zod'
import type { Logger } from './logger'

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

/**
 * What started the current run.
 */
export type TriggerContext =
	| { type: 'cron' }
	| { type: 'interval' }
	| { type: 'manual' }
	| { type: 'webhook'; name?: string }
	| EventTriggerContext

/**
 * The onchain log that started an event-triggered run. Each matching log
 * starts its own run.
 */
export interface EventTriggerContext {
	type: 'event'
	chainId: number
	log: {
		address: Address
		topics: Hex[]
		data: Hex
		blockNumber: bigint
		blockHash: Hex
		transactionHash: Hex
		transactionIndex: number
		/** Position of the log within its block */
		logIndex: number
	}
	/** Unix timestamp of the log's block, in seconds */
	blockTimestamp: number
	event: {
		name: string
		/** Human-readable ABI item the trigger matches on */
		signature: string
		/**
		 * Arguments decoded with `signature`; undefined when decoding failed.
		 * Use `decodeTriggerEvent` for typed arguments.
		 */
		args?: Record<string, unknown> | readonly unknown[]
	}
}

/**
 * Context provided to task execution
 */
export interface ThymeContext<TArgs> {
	/** Address that will execute returned calls on-chain */
	account: Address
	/**
	 * User-provided arguments, already validated **and transformed** against the
	 * task's `schema` by `defineTask` before `run` is called (e.g. `z.address()`
	 * is checksummed, `.default(...)` values are applied). Invalid input aborts
	 * execution before `run` runs.
	 */
	args: TArgs
	/** Viem public client for reading blockchain data */
	client: PublicClient
	/** Logger for outputting messages to the Thyme dashboard */
	logger: Logger
	/** Executable secrets available to the task */
	secrets: Record<string, string>
	/** Persistent JSON storage scoped to this executable */
	storage: JsonObject
	/**
	 * What started this run: a schedule, a manual or webhook run, or an onchain
	 * event. Lifecycle callbacks see the same value as `run`. Undefined on
	 * runners that predate triggers. Narrow event runs with `isEventTrigger`.
	 */
	trigger?: TriggerContext
}

/**
 * A call to be executed on-chain
 */
export interface Call {
	/** Target contract address */
	to: Address
	/** Encoded function call data */
	data: Hex
}

/**
 * Result when task determines execution should proceed
 */
export interface SuccessResult {
	canExec: true
	/** Array of calls to execute on-chain */
	calls: Call[]
}

/**
 * Result when task determines execution should not proceed
 */
export interface FailResult {
	canExec: false
	/** Reason why execution should not proceed */
	message: string
}

/**
 * Result returned from task execution
 */
export type TaskResult = SuccessResult | FailResult

/**
 * Payload passed to `onSuccess` once the submitted call(s) are confirmed on-chain.
 */
export type SuccessPayload = {
	txHash: string
	blockNumber: number
	/** `BundlerResult.actualGasUsed` */
	gasUsed: string
	gasCostWei: string
	/** Absent for raw self-paid transactions (no ERC-4337 UserOperation involved) */
	userOpHash?: string
}

/** Payload passed to `onSkip` when `run` returned `canExec: false`. */
export type SkipPayload = { message: string }

/** Payload passed to `onError` when `run` threw. */
export type ErrorPayload = { error: string }

/**
 * Payload passed to `onFail` when the execution failed after being submitted.
 */
export type FailPayload = {
	/**
	 * - `'reverted'` — the receipt says the tx/userOp reverted (`txHash` present).
	 * - `'submit'`   — the broadcast/bundler rejected it (definitely never landed).
	 * - `'timeout'`  — the receipt wait timed out: the outcome is UNKNOWN, the tx
	 *   may still land. `txHash`/`userOpHash` are provided when known.
	 */
	stage: 'reverted' | 'submit' | 'timeout'
	/** Redacted, user-facing reason (same text shown in the dashboard). */
	reason: string
	txHash?: string
	userOpHash?: string
}

/**
 * Task definition with schema, execution logic, and optional lifecycle callbacks.
 */
export interface TaskDefinition<TSchema extends z.ZodType> {
	/** Zod schema for validating task arguments */
	schema: TSchema
	/** Main execution function */
	run: (ctx: ThymeContext<z.infer<TSchema>>) => Promise<TaskResult>
	/** Called after the submitted call(s) are confirmed on-chain. */
	onSuccess?: (
		ctx: ThymeContext<z.infer<TSchema>>,
		tx: SuccessPayload,
	) => Promise<void> | void
	/** Called when `run` returned `canExec: false`. */
	onSkip?: (
		ctx: ThymeContext<z.infer<TSchema>>,
		info: SkipPayload,
	) => Promise<void> | void
	/** Called when `run` threw. */
	onError?: (
		ctx: ThymeContext<z.infer<TSchema>>,
		info: ErrorPayload,
	) => Promise<void> | void
	/** Called when the execution failed after being submitted (reverted, rejected, or timed out). */
	onFail?: (
		ctx: ThymeContext<z.infer<TSchema>>,
		info: FailPayload,
	) => Promise<void> | void
}
