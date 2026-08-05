/**
 * Extract a Zod schema from task source code and convert it to JSON Schema.
 * This allows every Thyme client and backend to generate the same argument
 * form contract from uploaded task source.
 *
 * The source is parsed with a small balanced-delimiter scanner rather than a
 * single regex: a regex cannot match the recursive `{ ... }` grammar of a
 * nested `z.object()`. Before scanning, comments are stripped (respecting string
 * literals) so a `//` comment containing a comma can't split a field. Optionality
 * is judged from the field's TOP-LEVEL chain only, so a nested `.optional()`
 * doesn't mark its parent optional. The `schema:` value may be inline
 * (`schema: z.object({...})`) or a reference to a `const x = z.object({...})`.
 */

type JsonSchema = Record<string, unknown>

type ObjectSchema = {
	type: 'object'
	properties: Record<string, JsonSchema>
	required: string[]
}

/**
 * A `/` begins a regex literal (rather than division) when the previous
 * significant token is an operator / opener / nothing — not a value, identifier,
 * or closer. Good enough for the `.regex(/.../)` shapes that appear in schemas.
 */
function isRegexStart(prevSignificant: string): boolean {
	return (
		prevSignificant === '' || '(,=:[{!&|?;<>+-*%^~'.includes(prevSignificant)
	)
}

/**
 * Remove `//` line comments and block comments while preserving string AND regex
 * literals. Without regex awareness, a Zod field like `z.string().regex(/^a\/\/b/)`
 * contains a literal `//` that would be mistaken for a comment and silently drop
 * every following field. Regex literals are replaced by a harmless placeholder
 * (the extractor only needs each field's base type, not its regex).
 */
function stripComments(code: string): string {
	let out = ''
	let stringChar: string | null = null
	let prevSignificant = ''

	for (let i = 0; i < code.length; i++) {
		const ch = code[i]
		const next = code[i + 1]

		if (stringChar) {
			out += ch
			if (ch === '\\') {
				out += next ?? ''
				i++
			} else if (ch === stringChar) {
				stringChar = null
			}
			continue
		}

		if (ch === '"' || ch === "'" || ch === '`') {
			stringChar = ch
			out += ch
			prevSignificant = ch
			continue
		}

		// `//` and `/*` are always comments (an empty `//` regex is a syntax error),
		// so check these BEFORE treating `/` as a possible regex literal.
		if (ch === '/' && next === '/') {
			while (i < code.length && code[i] !== '\n') i++
			out += '\n'
			continue
		}
		if (ch === '/' && next === '*') {
			i += 2
			while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++
			i += 1
			out += ' '
			continue
		}

		// Regex literal: consume to its closing `/` (respecting `\` escapes and
		// `[...]` character classes) so its internal `/` can't be misread, and emit
		// a neutral placeholder.
		if (ch === '/' && isRegexStart(prevSignificant)) {
			let j = i + 1
			let inClass = false
			let terminated = false
			while (j < code.length) {
				const c = code[j]
				if (c === '\\') {
					j += 2
					continue
				}
				if (c === '\n') break
				if (c === '[') inClass = true
				else if (c === ']') inClass = false
				else if (c === '/' && !inClass) {
					terminated = true
					break
				}
				j++
			}
			if (terminated) {
				out += '/RE/'
				prevSignificant = '/'
				i = j
				continue
			}
			// Not a real regex (unterminated) — fall through and emit the `/`.
		}

		out += ch
		if (ch && !/\s/.test(ch)) prevSignificant = ch
	}

	return out
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
 * Split a comma-separated list into its top-level segments, respecting nested
 * braces/parens/brackets and string literals (so commas inside a nested
 * definition don't split a segment). Comments must already be stripped.
 */
function splitTopLevel(body: string): string[] {
	const parts: string[] = []
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
			if (current.trim()) parts.push(current.trim())
			current = ''
			continue
		}

		current += ch
	}

	if (current.trim()) parts.push(current.trim())
	return parts
}

/**
 * Reduce a field definition to its TOP-LEVEL method chain by dropping every
 * bracketed group and string literal. `z.object({ x: z.string().optional() })`
 * becomes `z.object`, so a nested `.optional()` is not mistaken for the field's.
 */
function topLevelChain(def: string): string {
	let out = ''
	let depth = 0
	let stringChar: string | null = null

	for (let i = 0; i < def.length; i++) {
		const ch = def[i]

		if (stringChar) {
			if (ch === '\\') i++
			else if (ch === stringChar) stringChar = null
			continue
		}

		if (ch === '"' || ch === "'" || ch === '`') {
			stringChar = ch
		} else if (ch === '(' || ch === '{' || ch === '[') {
			depth++
		} else if (ch === ')' || ch === '}' || ch === ']') {
			depth--
		} else if (depth === 0) {
			out += ch
		}
	}

	return out
}

/**
 * A field is not required when its TOP-LEVEL chain makes it omittable:
 * `.optional()`, `.nullish()`, or `.default(...)`.
 */
function isOptionalDefinition(def: string): boolean {
	const chain = topLevelChain(def)
	return (
		/\.optional\b/.test(chain) ||
		/\.nullish\b/.test(chain) ||
		/\.default\b/.test(chain)
	)
}

/** Parse a simple JS literal (string / number / boolean / null / bigint / JSON object|array). */
function parseLiteral(raw: string): unknown {
	const s = raw.trim()
	if (s === '') return undefined
	if (s[0] === '"' || s[0] === "'" || s[0] === '`') {
		return s.slice(1, -1)
	}
	if (s === 'true') return true
	if (s === 'false') return false
	if (s === 'null') return null
	if (/^-?\d+n$/.test(s)) return s.slice(0, -1) // bigint literal -> decimal string
	if (s[0] === '{' || s[0] === '[') {
		// Object/array literal: only usable if it's valid JSON. JS literals with
		// unquoted keys / trailing commas won't parse — drop the value rather than
		// emit a wrong-typed string.
		try {
			return JSON.parse(s)
		} catch {
			return undefined
		}
	}
	const n = Number(s)
	if (s !== '' && !Number.isNaN(n)) return n
	return s // identifier / unmodelled expression — keep as-is
}

/** Content inside the first `z.<typeName>( ... )` parentheses, or null. */
function zArg(def: string, typeName: string): string | null {
	const match = def.match(new RegExp(`z\\s*\\.\\s*${typeName}\\s*\\(`))
	if (!match || match.index === undefined) return null
	const parenIndex = match.index + match[0].length - 1
	return extractBalanced(def, parenIndex)
}

/** If `s` is a `[ ... ]` array literal, return its inner contents; else `s`. */
function stripArrayBrackets(s: string): string {
	const t = s.trim()
	return t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t
}

/** The value passed to a TOP-LEVEL `.default(...)`, or undefined if none. */
function topLevelDefaultValue(def: string): unknown {
	let depth = 0
	let stringChar: string | null = null

	for (let i = 0; i < def.length; i++) {
		const ch = def[i]

		if (stringChar) {
			if (ch === '\\') i++
			else if (ch === stringChar) stringChar = null
			continue
		}

		if (ch === '"' || ch === "'" || ch === '`') {
			stringChar = ch
			continue
		}
		if (ch === '(' || ch === '{' || ch === '[') {
			depth++
			continue
		}
		if (ch === ')' || ch === '}' || ch === ']') {
			depth--
			continue
		}
		if (depth === 0 && def.startsWith('.default(', i)) {
			const inner = extractBalanced(def, i + '.default'.length)
			if (inner !== null) return parseLiteral(inner)
		}
	}

	return undefined
}

/** Map a primitive Zod type name to its JSON Schema representation. */
function primitiveToJsonSchema(zodType: string): JsonSchema {
	switch (zodType) {
		case 'number':
			return { type: 'number' }
		case 'boolean':
			return { type: 'boolean' }
		case 'bigint':
			return {
				type: 'string',
				pattern: '^-?\\d+$',
				description: 'Integer as a decimal string (bigint)',
			}
		case 'address':
			return {
				type: 'string',
				pattern: '^0x[a-fA-F0-9]{40}$',
				description: 'Ethereum address',
			}
		default:
			// string, date, and anything else we don't model explicitly
			return { type: 'string' }
	}
}

/** Convert a single field definition (the part after `name:`) to JSON Schema. */
function definitionToJsonSchema(def: string): JsonSchema {
	const trimmed = def.trim()
	let base = trimmed.match(/z\s*\.\s*(\w+)/)?.[1] ?? 'string'
	if (base === 'coerce') {
		// z.coerce.bigint() / z.coerce.number() — model the coerced target type.
		base = trimmed.match(/z\s*\.\s*coerce\s*\.\s*(\w+)/)?.[1] ?? 'string'
	}

	let schema: JsonSchema

	switch (base) {
		case 'object': {
			const objectMatch = trimmed.match(/z\s*\.\s*object\s*\(\s*\{/)
			const braceIndex =
				objectMatch?.index !== undefined
					? objectMatch.index + objectMatch[0].length - 1
					: -1
			const inner =
				braceIndex >= 0 ? extractBalanced(trimmed, braceIndex) : null
			schema = (inner !== null && buildObjectSchema(inner)) || {
				type: 'object',
			}
			break
		}
		case 'array': {
			const inner = zArg(trimmed, 'array')
			const element = inner !== null ? splitTopLevel(inner)[0] : undefined
			schema = {
				type: 'array',
				items: element ? definitionToJsonSchema(element) : {},
			}
			break
		}
		case 'enum': {
			const inner = zArg(trimmed, 'enum')
			const values =
				inner !== null
					? splitTopLevel(stripArrayBrackets(inner)).map(parseLiteral)
					: []
			schema = values.length
				? { type: 'string', enum: values }
				: { type: 'string' }
			break
		}
		case 'literal': {
			const inner = zArg(trimmed, 'literal')
			schema =
				inner !== null ? { const: parseLiteral(inner) } : { type: 'string' }
			break
		}
		case 'union': {
			const inner = zArg(trimmed, 'union')
			const options =
				inner !== null
					? splitTopLevel(stripArrayBrackets(inner)).map(definitionToJsonSchema)
					: []
			schema = options.length ? { anyOf: options } : { type: 'string' }
			break
		}
		case 'tuple': {
			const inner = zArg(trimmed, 'tuple')
			const items =
				inner !== null
					? splitTopLevel(stripArrayBrackets(inner)).map(definitionToJsonSchema)
					: []
			schema = { type: 'array', items }
			break
		}
		case 'record': {
			// z.record(keyType, valueType) | z.record(valueType): model the value type.
			const inner = zArg(trimmed, 'record')
			const parts = inner !== null ? splitTopLevel(inner) : []
			const valuePart = parts.length > 1 ? parts[1] : parts[0]
			schema = {
				type: 'object',
				additionalProperties: valuePart
					? definitionToJsonSchema(valuePart)
					: true,
			}
			break
		}
		default:
			schema = primitiveToJsonSchema(base)
	}

	const defaultValue = topLevelDefaultValue(trimmed)
	if (defaultValue !== undefined) {
		schema = { ...schema, default: defaultValue }
	}

	return schema
}

/** Build an object schema from the contents of a `z.object({ ... })` body. */
function buildObjectSchema(body: string): ObjectSchema | null {
	const properties: Record<string, JsonSchema> = {}
	const required: string[] = []

	for (const field of splitTopLevel(body)) {
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

/**
 * Return the `{ ... }` body of a `z.object({ ... })` that begins (after optional
 * whitespace) at `fromIndex`, or null if `z.object({` is not anchored there.
 */
function objectBodyAt(code: string, fromIndex: number): string | null {
	const anchored = code.slice(fromIndex).match(/^\s*z\s*\.\s*object\s*\(\s*\{/)
	if (!anchored) return null
	const braceIndex = fromIndex + anchored[0].length - 1
	return extractBalanced(code, braceIndex)
}

export function extractSchemaFromTask(taskCode: string): string | null {
	try {
		const code = stripComments(taskCode)

		// Locate the `schema:` property.
		const keyMatch = code.match(/\bschema\s*:/)
		if (!keyMatch || keyMatch.index === undefined) return null
		const afterKey = keyMatch.index + keyMatch[0].length

		let body: string | null = null

		// Case A — inline: `schema: z.object({ ... })`.
		body = objectBodyAt(code, afterKey)

		// Case B — reference: `schema: mySchema` where `const mySchema = z.object({...})`.
		if (body === null) {
			const rest = code.slice(afterKey).replace(/^\s*/, '')
			const idMatch = rest.match(/^([A-Za-z_$][\w$]*)/)
			if (idMatch?.[1]) {
				// Escape the identifier before embedding it in a RegExp ('$' and friends
				// are metacharacters). `(?:[^=;]|=>)*?=(?!>)` skips a possible `: Type`
				// annotation (which can contain `=>`) to reach the real assignment `=`.
				const id = idMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
				const decl = code.match(
					new RegExp(`(?:const|let|var)\\s+${id}\\b(?:[^=;]|=>)*?=(?!>)`),
				)
				if (decl?.index !== undefined) {
					body = objectBodyAt(code, decl.index + decl[0].length)
				}
			}
		}

		if (body === null) return null

		const schema = buildObjectSchema(body)
		if (!schema) return null

		return JSON.stringify(schema)
	} catch (err) {
		console.error('Error extracting schema:', err)
		return null
	}
}
