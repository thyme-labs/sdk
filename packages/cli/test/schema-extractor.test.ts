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

// ---------------------------------------------------------------------------
// Top-level-only optionality: a nested .optional()/.default() must NOT make the
// parent field optional.
// ---------------------------------------------------------------------------
describe('extractSchemaFromTask — top-level-only optionality', () => {
	test('a nested .optional() does not mark the parent object optional', () => {
		const schema = parse(
			`schema: z.object({ config: z.object({ x: z.string().optional() }), id: z.string() })`,
		)
		expect(schema.required.sort()).toEqual(['config', 'id'])
	})

	test('a nested .optional() inside an array element keeps the array required', () => {
		const schema = parse(
			`schema: z.object({ items: z.array(z.string().optional()), id: z.string() })`,
		)
		expect(schema.required.sort()).toEqual(['id', 'items'])
	})

	test('a string literal containing ".optional(" does not flip required', () => {
		const schema = parse(
			`schema: z.object({ name: z.string().describe('pass .optional() to skip') })`,
		)
		expect(schema.required).toEqual(['name'])
	})

	test('a real top-level .optional() is still detected', () => {
		const schema = parse(
			`schema: z.object({ a: z.string().optional(), b: z.number() })`,
		)
		expect(schema.required).toEqual(['b'])
	})
})

// ---------------------------------------------------------------------------
// Comment-aware scanning: a // comment containing a comma must not drop fields.
// ---------------------------------------------------------------------------
describe('extractSchemaFromTask — comment handling', () => {
	test('a line comment with a comma does not drop later fields', () => {
		const schema = parse(
			`schema: z.object({\n  a: z.string(), // first, important\n  b: z.number(),\n  c: z.boolean(),\n})`,
		)
		expect(Object.keys(schema.properties).sort()).toEqual(['a', 'b', 'c'])
		expect(schema.required.sort()).toEqual(['a', 'b', 'c'])
	})

	test('a block comment is ignored', () => {
		const schema = parse(
			`schema: z.object({ a: z.string(), /* b, c here */ d: z.number() })`,
		)
		expect(Object.keys(schema.properties).sort()).toEqual(['a', 'd'])
	})

	test('a // sequence inside a string is preserved (default URL)', () => {
		const schema = parse(
			`schema: z.object({ url: z.string().default('https://x.example/path') })`,
		)
		expect(schema.required).toEqual([])
		expect(schema.properties.url.default).toBe('https://x.example/path')
	})
})

// ---------------------------------------------------------------------------
// Schema referenced as a variable: const x = z.object({...}); schema: x
// ---------------------------------------------------------------------------
describe('extractSchemaFromTask — variable references', () => {
	test('resolves a schema declared as a const before the task', () => {
		const schema = parse(
			`const mySchema = z.object({ target: z.address(), amount: z.number() })\nexport default defineTask({ schema: mySchema, async run() {} })`,
		)
		expect(Object.keys(schema.properties).sort()).toEqual(['amount', 'target'])
		expect(schema.required.sort()).toEqual(['amount', 'target'])
	})

	test('does NOT scrape an unrelated z.object from the run body', () => {
		const schema = parse(
			`schema: mySchema, async run(ctx){ const v = z.object({ wrong: z.number() }) }`,
		)
		// mySchema is undeclared here, so extraction yields null rather than the
		// unrelated z.object() in the run body.
		expect(schema).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// Extended type mapping: enum/union/literal/bigint/record/tuple + defaults.
// ---------------------------------------------------------------------------
describe('extractSchemaFromTask — extended type mapping', () => {
	test('z.enum() preserves its allowed values', () => {
		const schema = parse(
			`schema: z.object({ status: z.enum(['active', 'inactive', 'pending']) })`,
		)
		expect(schema.properties.status).toEqual({
			type: 'string',
			enum: ['active', 'inactive', 'pending'],
		})
	})

	test('z.literal() maps to const', () => {
		const schema = parse(`schema: z.object({ role: z.literal('admin') })`)
		expect(schema.properties.role).toEqual({ const: 'admin' })
	})

	test('z.union() maps to anyOf', () => {
		const schema = parse(
			`schema: z.object({ v: z.union([z.string(), z.number()]) })`,
		)
		expect(schema.properties.v).toEqual({
			anyOf: [{ type: 'string' }, { type: 'number' }],
		})
	})

	test('z.bigint() maps to a decimal-string pattern', () => {
		const schema = parse(`schema: z.object({ amount: z.bigint() })`)
		expect(schema.properties.amount).toMatchObject({
			type: 'string',
			pattern: '^-?\\d+$',
		})
	})

	test('z.coerce.bigint() / z.coerce.number() model the coerced type', () => {
		const big = parse(`schema: z.object({ amount: z.coerce.bigint() })`)
		expect(big.properties.amount).toMatchObject({
			type: 'string',
			pattern: '^-?\\d+$',
		})
		const num = parse(`schema: z.object({ n: z.coerce.number() })`)
		expect(num.properties.n).toEqual({ type: 'number' })
	})

	test('z.tuple() maps to a fixed-items array', () => {
		const schema = parse(
			`schema: z.object({ pair: z.tuple([z.string(), z.number()]) })`,
		)
		expect(schema.properties.pair).toEqual({
			type: 'array',
			items: [{ type: 'string' }, { type: 'number' }],
		})
	})

	test('.default(value) is emitted into the JSON schema', () => {
		const schema = parse(
			`schema: z.object({ limit: z.number().default(10), tag: z.string().default('x') })`,
		)
		expect(schema.properties.limit).toEqual({ type: 'number', default: 10 })
		expect(schema.properties.tag).toEqual({ type: 'string', default: 'x' })
		expect(schema.required).toEqual([])
	})

	test('object/array .default() is structured JSON, not a string', () => {
		const arr = parse(
			`schema: z.object({ tags: z.array(z.string()).default([]) })`,
		)
		expect(arr.properties.tags.default).toEqual([])
		const nums = parse(
			`schema: z.object({ xs: z.array(z.number()).default([1, 2]) })`,
		)
		expect(nums.properties.xs.default).toEqual([1, 2])
	})
})

// ---------------------------------------------------------------------------
// Regression fixes found by adversarial review (regex literals, $ in var names,
// type-annotation '=>').
// ---------------------------------------------------------------------------
describe('extractSchemaFromTask — regex & reference edge cases', () => {
	test('a regex literal containing // does not drop later fields', () => {
		const schema = parse(
			`schema: z.object({\n  url: z.string().regex(/^https?:\\/\\//),\n  name: z.string(),\n  age: z.number(),\n})`,
		)
		expect(Object.keys(schema.properties).sort()).toEqual([
			'age',
			'name',
			'url',
		])
		expect(schema.required.sort()).toEqual(['age', 'name', 'url'])
	})

	test('a regex with a character class is consumed correctly', () => {
		const schema = parse(
			`schema: z.object({ slug: z.string().regex(/[a-z/]+/), id: z.number() })`,
		)
		expect(Object.keys(schema.properties).sort()).toEqual(['id', 'slug'])
	})

	test('a const-referenced schema name containing $ resolves', () => {
		const schema = parse(
			`const my$Schema = z.object({ a: z.string() })\nexport default defineTask({ schema: my$Schema, async run() {} })`,
		)
		expect(Object.keys(schema.properties)).toEqual(['a'])
	})

	test('a const-referenced schema with a type annotation containing => resolves', () => {
		const schema = parse(
			`const mySchema: ZodType<{ fn: () => void }> = z.object({ a: z.string() })\nexport default defineTask({ schema: mySchema, async run() {} })`,
		)
		expect(Object.keys(schema.properties)).toEqual(['a'])
	})
})
