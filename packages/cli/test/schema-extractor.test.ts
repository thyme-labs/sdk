import { describe, expect, test } from 'bun:test'
import { extractSchemaFromTask } from '../src/utils/schema-extractor'

const parse = (code: string) => {
	const json = extractSchemaFromTask(code)
	return json ? JSON.parse(json) : null
}

describe('extractSchemaFromTask — supported cases', () => {
	test('extracts a flat schema of primitive fields', () => {
		const schema = parse(
			`schema: z.object({ name: z.string(), age: z.number(), active: z.boolean() })`,
		)
		expect(schema).toEqual({
			type: 'object',
			properties: {
				name: { type: 'string' },
				age: { type: 'number' },
				active: { type: 'boolean' },
			},
			required: ['name', 'age', 'active'],
		})
	})

	test('maps z.address() to a string with an eth-address pattern', () => {
		const schema = parse(`schema: z.object({ target: z.address() })`)
		expect(schema.properties.target).toEqual({
			type: 'string',
			pattern: '^0x[a-fA-F0-9]{40}$',
			description: 'Ethereum address',
		})
	})

	test('defaults unknown zod types to string', () => {
		const schema = parse(`schema: z.object({ when: z.date() })`)
		expect(schema.properties.when).toEqual({ type: 'string' })
	})

	test('reads the type from a chained validator like z.string().min(3)', () => {
		const schema = parse(`schema: z.object({ name: z.string().min(3) })`)
		expect(schema.properties.name).toEqual({ type: 'string' })
	})

	test('returns null when no schema is present', () => {
		expect(parse('export default defineTask({ async run() {} })')).toBeNull()
	})

	test('returns null for an empty object schema', () => {
		expect(parse('schema: z.object({})')).toBeNull()
	})

	test('marks all detected fields as required', () => {
		const schema = parse(`schema: z.object({ a: z.string(), b: z.string() })`)
		expect(schema.required).toEqual(['a', 'b'])
	})
})

// ---------------------------------------------------------------------------
// Previously-known bugs (AUDIT.md #M1, #M2), now fixed by the balanced-delimiter
// parser. These encode the correct behaviour and pass.
// ---------------------------------------------------------------------------
describe('extractSchemaFromTask — optional & nested fields (#M1, #M2)', () => {
	test('optional fields are NOT listed as required (#M1)', () => {
		const schema = parse(
			`schema: z.object({ a: z.string(), b: z.number().optional() })`,
		)
		expect(schema.required).toEqual(['a'])
		expect(schema.properties.b).toEqual({ type: 'number' })
	})

	test('fields with .default(...) or .nullish() are not required (#M1)', () => {
		const schema = parse(
			`schema: z.object({ a: z.string().default('x'), b: z.number().nullish(), c: z.boolean() })`,
		)
		expect(schema.required).toEqual(['c'])
	})

	test('a nested z.object() does not corrupt the extracted shape (#M2)', () => {
		const schema = parse(
			`schema: z.object({ user: z.object({ name: z.string() }), age: z.number() })`,
		)
		expect(Object.keys(schema.properties).sort()).toEqual(['age', 'user'])
		expect(schema.properties.user).toEqual({
			type: 'object',
			properties: { name: { type: 'string' } },
			required: ['name'],
		})
		expect(schema.properties.age).toEqual({ type: 'number' })
		expect(schema.required.sort()).toEqual(['age', 'user'])
	})

	test('an array field is modelled with its element type (#M2)', () => {
		const schema = parse(
			`schema: z.object({ tags: z.array(z.string()), count: z.number() })`,
		)
		expect(schema.properties.tags).toEqual({
			type: 'array',
			items: { type: 'string' },
		})
		expect(schema.properties.count).toEqual({ type: 'number' })
	})
})
