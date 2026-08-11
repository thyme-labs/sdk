import { describe, expect, test } from 'bun:test'
import { zodExtended as z } from '../src/schema'
import { defineTask } from '../src/task'
import type { ThymeContext } from '../src/types'

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

// Minimal stub context; args is overridden per-test.
function ctx<T>(args: T): ThymeContext<T> {
	return {
		account: VITALIK,
		args,
		// biome-ignore lint/suspicious/noExplicitAny: minimal stub context for the unit test
		client: {} as any,
		// biome-ignore lint/suspicious/noExplicitAny: minimal stub context for the unit test
		logger: {} as any,
		secrets: {},
		storage: {},
	}
}

describe('defineTask', () => {
	test('preserves the schema for the form extractor / wrappers', () => {
		const schema = z.object({ n: z.number() })
		const def = defineTask({
			schema,
			async run() {
				return { canExec: true as const, calls: [] }
			},
		})
		expect(def.schema).toBe(schema)
	})

	test('validates args against the schema before run is called', async () => {
		let ran = false
		const def = defineTask({
			schema: z.object({ n: z.number() }),
			async run() {
				ran = true
				return { canExec: true as const, calls: [] }
			},
		})

		// Wrong type for `n` must reject BEFORE the run body executes.
		await expect(
			// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
			def.run(ctx({ n: 'not-a-number' } as any)),
		).rejects.toThrow(/Invalid task arguments/)
		expect(ran).toBe(false)
	})

	test('transforms args: z.address() is checksummed before run sees it', async () => {
		let seen: string | undefined
		const def = defineTask({
			schema: z.object({ target: z.address() }),
			async run(c) {
				seen = c.args.target
				return { canExec: true as const, calls: [] }
			},
		})

		await def.run(ctx({ target: VITALIK.toLowerCase() }))
		// The run body received the checksummed Address, not the raw lowercase input.
		expect(seen).toBe(VITALIK)
	})

	test('applies .default() values before run sees them', async () => {
		let seen: number | undefined
		const def = defineTask({
			schema: z.object({ limit: z.number().default(5) }),
			async run(c) {
				seen = c.args.limit
				return { canExec: true as const, calls: [] }
			},
		})

		// Field omitted entirely — the default must be filled in by validation.
		// biome-ignore lint/suspicious/noExplicitAny: omitting a defaulted field
		await def.run(ctx({} as any))
		expect(seen).toBe(5)
	})

	test('error message includes the offending field path', async () => {
		const def = defineTask({
			schema: z.object({ target: z.address() }),
			async run() {
				return { canExec: true as const, calls: [] }
			},
		})

		await expect(def.run(ctx({ target: 'not-an-address' }))).rejects.toThrow(
			/target: Invalid Ethereum address/,
		)
	})

	test('root-level (non-object) schema failure reports without a field path', async () => {
		// A top-level schema produces a ZodError issue with an empty `path`,
		// exercising the no-prefix branch of the error formatter.
		const def = defineTask({
			schema: z.address(),
			async run() {
				return { canExec: true as const, calls: [] }
			},
		})

		const promise = def.run(ctx('not-an-address'))
		await expect(promise).rejects.toThrow(
			/Invalid task arguments: Invalid Ethereum address/,
		)
		// No `field:` prefix, since the failing value is the root itself.
		await expect(promise).rejects.toThrow(
			/arguments: Invalid Ethereum address$/,
		)
	})

	test('passes through valid args and returns the run result', async () => {
		const def = defineTask({
			schema: z.object({ n: z.number() }),
			async run(c) {
				return { canExec: false as const, message: `n=${c.args.n}` }
			},
		})

		const result = await def.run(ctx({ n: 7 }))
		expect(result).toEqual({ canExec: false, message: 'n=7' })
	})

	test('does NOT eagerly access a lazy ctx.client getter', async () => {
		// The local runner exposes `client` as a lazy getter that throws without an
		// RPC URL. defineTask must not trigger it (no spread) for client-less tasks.
		let clientReads = 0
		const def = defineTask({
			schema: z.object({ n: z.number() }),
			async run() {
				return { canExec: true as const, calls: [] }
			},
		})
		// biome-ignore lint/suspicious/noExplicitAny: context with a throwing getter
		const c: any = {
			account: VITALIK,
			args: { n: 1 },
			get client() {
				clientReads++
				throw new Error('client accessed eagerly')
			},
			logger: {},
			secrets: {},
			storage: {},
		}
		const result = await def.run(c)
		expect(clientReads).toBe(0)
		expect(result).toEqual({ canExec: true, calls: [] })
	})

	test('in-task storage mutations flow back to the original context', async () => {
		const def = defineTask({
			schema: z.object({ n: z.number() }),
			async run(c) {
				;(c.storage as Record<string, unknown>).touched = c.args.n
				return { canExec: false as const, message: 'ok' }
			},
		})
		const c = ctx({ n: 7 })
		await def.run(c)
		expect((c.storage as Record<string, unknown>).touched).toBe(7)
	})

	test('supports async refinements via safeParseAsync', async () => {
		const def = defineTask({
			schema: z.object({
				n: z.number().refine(async (v) => v > 0, 'must be positive'),
			}),
			async run(c) {
				return { canExec: false as const, message: `n=${c.args.n}` }
			},
		})
		expect(await def.run(ctx({ n: 5 }))).toEqual({
			canExec: false,
			message: 'n=5',
		})
		await expect(def.run(ctx({ n: -1 }))).rejects.toThrow(
			/Invalid task arguments/,
		)
	})

	describe('lifecycle callbacks', () => {
		test('callbacks absent from the definition stay absent on the returned task', () => {
			const def = defineTask({
				schema: z.object({ n: z.number() }),
				async run() {
					return { canExec: true as const, calls: [] }
				},
			})
			expect(def.onSuccess).toBeUndefined()
			expect(def.onSkip).toBeUndefined()
			expect(def.onError).toBeUndefined()
			expect(def.onFail).toBeUndefined()
			expect('onSuccess' in def).toBe(false)
			expect('onSkip' in def).toBe(false)
			expect('onError' in def).toBe(false)
			expect('onFail' in def).toBe(false)
		})

		test('each defined callback passes through and receives its payload', async () => {
			const seen: Record<string, unknown> = {}
			const def = defineTask({
				schema: z.object({ n: z.number() }),
				async run() {
					return { canExec: true as const, calls: [] }
				},
				async onSuccess(_c, tx) {
					seen.onSuccess = tx
				},
				async onSkip(_c, info) {
					seen.onSkip = info
				},
				async onError(_c, info) {
					seen.onError = info
				},
				async onFail(_c, info) {
					seen.onFail = info
				},
			})

			const successPayload = {
				txHash: '0xabc',
				blockNumber: 1,
				gasUsed: '21000',
				gasCostWei: '1',
			}
			await def.onSuccess?.(ctx({ n: 1 }), successPayload)
			await def.onSkip?.(ctx({ n: 1 }), { message: 'skipped' })
			await def.onError?.(ctx({ n: 1 }), { error: 'boom' })
			const failPayload = { stage: 'timeout' as const, reason: 'no receipt' }
			await def.onFail?.(ctx({ n: 1 }), failPayload)

			expect(seen.onSuccess).toEqual(successPayload)
			expect(seen.onSkip).toEqual({ message: 'skipped' })
			expect(seen.onError).toEqual({ error: 'boom' })
			expect(seen.onFail).toEqual(failPayload)
		})

		test('validates and transforms ctx.args in a callback, same as run', async () => {
			let seenTarget: string | undefined
			const def = defineTask({
				schema: z.object({ target: z.address() }),
				async run() {
					return { canExec: true as const, calls: [] }
				},
				async onSuccess(c) {
					seenTarget = c.args.target
				},
			})

			await def.onSuccess?.(ctx({ target: VITALIK.toLowerCase() }), {
				txHash: '0xabc',
				blockNumber: 1,
				gasUsed: '21000',
				gasCostWei: '1',
			})
			// Same checksum transform run's ctx.args gets.
			expect(seenTarget).toBe(VITALIK)
		})

		test('a callback rejects invalid args before its body runs', async () => {
			let ran = false
			const def = defineTask({
				schema: z.object({ n: z.number() }),
				async run() {
					return { canExec: true as const, calls: [] }
				},
				async onFail() {
					ran = true
				},
			})

			await expect(
				def.onFail?.(
					// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
					ctx({ n: 'not-a-number' } as any),
					{ stage: 'submit', reason: 'rejected' },
				),
			).rejects.toThrow(/Invalid task arguments/)
			expect(ran).toBe(false)
		})
	})
})
