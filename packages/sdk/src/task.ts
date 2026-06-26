import type { z } from 'zod'
import type { TaskDefinition } from './types'

/**
 * Format a Zod validation failure into a single, readable line.
 * Each issue is rendered as `path: message` (root-level issues omit the path).
 */
function formatArgsError(error: z.ZodError): string {
	const issues = error.issues
		.map((issue) => {
			const path = issue.path.join('.')
			return path ? `${path}: ${issue.message}` : issue.message
		})
		.join('; ')
	return `Invalid task arguments: ${issues || 'schema validation failed'}`
}

/**
 * Define a Web3 automation task.
 *
 * The returned task's `run` validates **and transforms** `ctx.args` against the
 * declared `schema` *before* your `run` body executes. This guarantees that, by
 * the time your code runs, `ctx.args`:
 *
 * - has been validated (invalid input throws and execution is aborted — your
 *   `run` body is never entered);
 * - has had Zod transforms applied — e.g. `z.address()` returns a checksummed
 *   viem `Address`, `.default(...)` values are filled in, and `z.coerce.*`
 *   coercions have happened.
 *
 * Because validation lives here (not in the local/cloud execution wrappers),
 * `thyme run` and the production sandbox enforce the *exact same* contract.
 *
 * On invalid arguments `run` throws `Error('Invalid task arguments: ...')`,
 * which both runners surface as a failed execution.
 *
 * @example
 * ```typescript
 * import { defineTask, z } from '@thyme-labs/sdk'
 * import { encodeFunctionData } from 'viem'
 *
 * const abi = [
 *   'function transfer(address to, uint256 amount) returns (bool)',
 * ] as const
 *
 * export default defineTask({
 *   schema: z.object({
 *     targetAddress: z.address(),
 *   }),
 *   async run(ctx) {
 *     // ctx.args.targetAddress is already validated + checksummed here.
 *     return {
 *       canExec: true,
 *       calls: [{
 *         to: ctx.args.targetAddress,
 *         data: encodeFunctionData({
 *           abi,
 *           functionName: 'transfer',
 *           args: [recipientAddress, 1000n],
 *         }),
 *       }]
 *     }
 *   }
 * })
 * ```
 */
export function defineTask<TSchema extends z.ZodType>(
	definition: TaskDefinition<TSchema>,
): TaskDefinition<TSchema> {
	const { schema, run } = definition

	return {
		schema,
		async run(ctx) {
			// Validate + transform the raw arguments against the task's schema
			// before the user's run body is ever entered. `parsed.data` is the
			// schema's *output* type (transforms applied), so it matches the
			// `z.infer<TSchema>` type that `run` is declared with.
			// `safeParseAsync` so schemas with async refinements/transforms work
			// (the sync `safeParse` throws on those instead of returning a result).
			const parsed = await schema.safeParseAsync(ctx.args)
			if (!parsed.success) {
				throw new Error(formatArgsError(parsed.error))
			}
			// Delegate to `ctx` via the prototype chain rather than spreading it.
			// A spread (`{ ...ctx }`) performs [[Get]] on every own property, which
			// would eagerly invoke accessor getters on the context — e.g. the local
			// runner exposes `client` as a lazy `get client()` that throws when no
			// RPC URL is set — defeating that laziness and breaking client-less
			// tasks. `Object.create` keeps `client` lazy and `storage` the same
			// shared reference (so in-task storage mutations still flow back).
			const next: typeof ctx = Object.create(ctx)
			next.args = parsed.data
			return run(next)
		},
	}
}
