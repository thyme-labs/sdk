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
 * Context provided to task execution
 */
export interface ThymeContext<TArgs> {
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
 * Task definition with schema and execution logic
 */
export interface TaskDefinition<TSchema extends z.ZodType> {
	/** Zod schema for validating task arguments */
	schema: TSchema
	/** Main execution function */
	run: (ctx: ThymeContext<z.infer<TSchema>>) => Promise<TaskResult>
}
