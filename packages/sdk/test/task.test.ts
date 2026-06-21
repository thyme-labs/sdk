import { describe, expect, test } from 'bun:test'
import { zodExtended as z } from '../src/schema'
import { defineTask } from '../src/task'

describe('defineTask', () => {
	test('returns the same definition object (identity passthrough)', () => {
		const def = {
			schema: z.object({ target: z.address() }),
			async run() {
				return { canExec: false as const, message: 'noop' }
			},
		}
		expect(defineTask(def)).toBe(def)
	})

	test('preserves the schema and run function', async () => {
		const def = defineTask({
			schema: z.object({ n: z.number() }),
			async run(_ctx) {
				return { canExec: true as const, calls: [] }
			},
		})
		expect(def.schema.parse({ n: 1 })).toEqual({ n: 1 })
		const result = await def.run({
			args: { n: 1 },
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub context for the unit test
			client: {} as any,
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub context for the unit test
			logger: {} as any,
			secrets: {},
			storage: {},
		})
		expect(result).toEqual({ canExec: true, calls: [] })
	})
})
