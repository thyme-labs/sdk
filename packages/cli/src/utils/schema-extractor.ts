/**
 * Extract a Zod schema from task source code and convert it to JSON Schema.
 * This allows the frontend to generate forms for task arguments.
 *
 * The source is parsed with a small balanced-delimiter scanner rather than a
 * single regex: a regex cannot match the recursive `{ ... }` grammar of a
 * nested `z.object()`, which previously caused nested objects to corrupt the
 * output and optional fields to be reported as required.
 */

type JsonSchema = Record<string, unknown>

type ObjectSchema = {
	type: 'object'
	properties: Record<string, JsonSchema>
	required: string[]
}

/**
 * Return the substring inside the delimiter that opens at `openIndex`
 * (one of `{`, `(`, `[`), excluding the delimiters themselves. String literals
 * are skipped so delimiters inside strings don't affect the depth count.
 * Returns null if the opening delimiter is never closed.
 */
function extractBalanced(code: string, openIndex: number): string | null {
	const open = code[openIndex]
	const close =
		open === '{' ? '}' : open === '(' ? ')' : open === '[' ? ']' : ''
	if (!close) return null

	let depth = 0
	let stringChar: string | null = null

	for (let i = openIndex; i < code.length; i++) {
		const ch = code[i]

		if (stringChar) {
			if (ch === '\\') {
				i++ // skip the escaped character
			} else if (ch === stringChar) {
				stringChar = null
			}
			continue
		}

		if (ch === '"' || ch === "'" || ch === '`') {
			stringChar = ch
		} else if (ch === open) {
			depth++
		} else if (ch === close) {
			depth--
			if (depth === 0) {
				return code.slice(openIndex + 1, i)
			}
		}
	}

	return null
}

/**
 * Split an object body into its top-level `key: value` entries, respecting
 * nested braces/parens/brackets and string literals (so commas inside a nested
 * definition don't split a field).
 */
function splitTopLevelFields(body: string): string[] {
	const fields: string[] = []
	let depth = 0
	let stringChar: string | null = null
	let current = ''

	for (let i = 0; i < body.length; i++) {
		const ch = body[i]

		if (stringChar) {
			current += ch
			if (ch === '\\') {
				current += body[i + 1] ?? ''
				i++
			} else if (ch === stringChar) {
				stringChar = null
			}
			continue
		}

		if (ch === '"' || ch === "'" || ch === '`') {
			stringChar = ch
		} else if (ch === '{' || ch === '(' || ch === '[') {
			depth++
		} else if (ch === '}' || ch === ')' || ch === ']') {
			depth--
		} else if (ch === ',' && depth === 0) {
			if (current.trim()) fields.push(current.trim())
			current = ''
			continue
		}

		current += ch
	}

	if (current.trim()) fields.push(current.trim())
	return fields
}

/**
 * A field is not required when its definition makes it omittable:
 * `.optional()`, `.nullish()`, or `.default(...)`.
 */
function isOptionalDefinition(def: string): boolean {
	return (
		/\.optional\s*\(/.test(def) ||
		/\.nullish\s*\(/.test(def) ||
		/\.default\s*\(/.test(def)
	)
}

/** Map a primitive Zod type name to its JSON Schema representation. */
function primitiveToJsonSchema(zodType: string): JsonSchema {
	switch (zodType) {
		case 'number':
			return { type: 'number' }
		case 'boolean':
			return { type: 'boolean' }
		case 'address':
			return {
				type: 'string',
				pattern: '^0x[a-fA-F0-9]{40}$',
				description: 'Ethereum address',
			}
		default:
			// string, date, enum, and anything else we don't model explicitly
			return { type: 'string' }
	}
}

/** Convert a single field definition (the part after `name:`) to JSON Schema. */
function definitionToJsonSchema(def: string): JsonSchema {
	// Nested object: recurse into its balanced { ... } body.
	const objectMatch = def.match(/z\.object\s*\(\s*\{/)
	if (objectMatch && objectMatch.index !== undefined) {
		const braceIndex = objectMatch.index + objectMatch[0].length - 1
		const inner = extractBalanced(def, braceIndex)
		if (inner !== null) {
			return buildObjectSchema(inner) ?? { type: 'object' }
		}
	}

	// Array: model its element type from the first argument.
	const arrayMatch = def.match(/z\.array\s*\(/)
	if (arrayMatch && arrayMatch.index !== undefined) {
		const parenIndex = arrayMatch.index + arrayMatch[0].length - 1
		const inner = extractBalanced(def, parenIndex)
		return {
			type: 'array',
			items: inner !== null ? definitionToJsonSchema(inner.trim()) : {},
		}
	}

	// Primitive: the type is the first `z.<type>(` in the chain.
	const typeMatch = def.match(/z\.(\w+)\s*\(/)
	return primitiveToJsonSchema(typeMatch?.[1] ?? 'string')
}

/** Build an object schema from the contents of a `z.object({ ... })` body. */
function buildObjectSchema(body: string): ObjectSchema | null {
	const properties: Record<string, JsonSchema> = {}
	const required: string[] = []

	for (const field of splitTopLevelFields(body)) {
		const match = field.match(/^["']?([A-Za-z_$][\w$]*)["']?\s*:\s*([\s\S]+)$/)
		if (!match) continue

		const [, name, def] = match
		if (!name || !def) continue

		properties[name] = definitionToJsonSchema(def.trim())
		if (!isOptionalDefinition(def)) {
			required.push(name)
		}
	}

	if (Object.keys(properties).length === 0) {
		return null
	}

	return { type: 'object', properties, required }
}

export function extractSchemaFromTask(taskCode: string): string | null {
	try {
		// Locate the `schema:` property, then its `z.object({ ... })` body.
		const schemaKeyIndex = taskCode.search(/\bschema\s*:/)
		if (schemaKeyIndex === -1) return null

		const afterKey = taskCode.slice(schemaKeyIndex)
		const objectMatch = afterKey.match(/z\.object\s*\(\s*\{/)
		if (!objectMatch || objectMatch.index === undefined) return null

		const braceIndex =
			schemaKeyIndex + objectMatch.index + objectMatch[0].length - 1
		const body = extractBalanced(taskCode, braceIndex)
		if (body === null) return null

		const schema = buildObjectSchema(body)
		if (!schema) return null

		return JSON.stringify(schema)
	} catch (err) {
		console.error('Error extracting schema:', err)
		return null
	}
}
