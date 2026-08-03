import { expect, test } from 'bun:test'
import { extractSchemaFromTask } from '../src/utils/schema-extractor'

test('re-exports schema extraction from the SDK package', () => {
	const schema = extractSchemaFromTask(
		'schema: z.object({ name: z.string(), count: z.number().optional() })',
	)

	expect(schema && JSON.parse(schema)).toEqual({
		type: 'object',
		properties: {
			name: { type: 'string' },
			count: { type: 'number' },
		},
		required: ['name'],
	})
})
