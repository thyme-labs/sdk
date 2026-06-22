import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	getEnv,
	getRequiredEnv,
	loadEnv,
	loadEnvFile,
	resolveLoadedEnv,
} from '../src/utils/env'

let dir: string
const TOUCHED = [
	'THYME_TEST_A',
	'THYME_TEST_B',
	'THYME_TEST_EMPTY',
	'THYME_TEST_MISSING',
]
let saved: Record<string, string | undefined>

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'thyme-env-'))
	saved = {}
	for (const k of TOUCHED) {
		saved[k] = process.env[k]
		delete process.env[k]
	}
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
	for (const k of TOUCHED) {
		if (saved[k] === undefined) delete process.env[k]
		else process.env[k] = saved[k]
	}
})

describe('loadEnvFile', () => {
	test('returns {} when the file does not exist', () => {
		expect(loadEnvFile(join(dir, 'nope.env'))).toEqual({})
	})

	test('parses key=value pairs and populates process.env', () => {
		const file = join(dir, '.env')
		writeFileSync(file, 'THYME_TEST_A=hello\nTHYME_TEST_B=world\n')
		const parsed = loadEnvFile(file)
		expect(parsed.THYME_TEST_A).toBe('hello')
		expect(parsed.THYME_TEST_B).toBe('world')
		expect(process.env.THYME_TEST_A).toBe('hello')
	})

	test('does not override an existing process.env value by default', () => {
		process.env.THYME_TEST_A = 'preset'
		const file = join(dir, '.env')
		writeFileSync(file, 'THYME_TEST_A=fromfile\n')
		loadEnvFile(file)
		expect(process.env.THYME_TEST_A).toBe('preset')
	})

	test('overrides an existing value when { override: true }', () => {
		process.env.THYME_TEST_A = 'preset'
		const file = join(dir, '.env')
		writeFileSync(file, 'THYME_TEST_A=fromfile\n')
		loadEnvFile(file, { override: true })
		expect(process.env.THYME_TEST_A).toBe('fromfile')
	})
})

describe('loadEnv', () => {
	test('reads the .env at the project root', () => {
		writeFileSync(join(dir, '.env'), 'THYME_TEST_A=root\n')
		expect(loadEnv(dir).THYME_TEST_A).toBe('root')
	})
})

describe('resolveLoadedEnv', () => {
	test('returns the currently-effective process.env value for every loaded key', () => {
		process.env.THYME_TEST_A = 'effectiveA'
		process.env.THYME_TEST_B = 'effectiveB'
		const merged = resolveLoadedEnv(
			{ THYME_TEST_A: 'fileA' },
			{ THYME_TEST_B: 'fileB' },
		)
		expect(merged).toEqual({
			THYME_TEST_A: 'effectiveA',
			THYME_TEST_B: 'effectiveB',
		})
	})

	test('omits keys that are not present in process.env', () => {
		const merged = resolveLoadedEnv({ THYME_TEST_MISSING: 'x' })
		expect(merged).toEqual({})
	})

	test('deduplicates keys appearing in multiple maps', () => {
		process.env.THYME_TEST_A = 'final'
		const merged = resolveLoadedEnv(
			{ THYME_TEST_A: 'one' },
			{ THYME_TEST_A: 'two' },
		)
		expect(merged).toEqual({ THYME_TEST_A: 'final' })
	})
})

describe('getEnv', () => {
	test('returns the value when set', () => {
		process.env.THYME_TEST_A = 'v'
		expect(getEnv('THYME_TEST_A')).toBe('v')
	})

	test('returns the fallback when unset', () => {
		expect(getEnv('THYME_TEST_MISSING', 'fb')).toBe('fb')
	})

	test('returns undefined when unset and no fallback', () => {
		expect(getEnv('THYME_TEST_MISSING')).toBeUndefined()
	})

	test('treats an empty-string env var as a real value (not the fallback)', () => {
		process.env.THYME_TEST_EMPTY = ''
		// getEnv uses ?? so an empty string is returned verbatim.
		expect(getEnv('THYME_TEST_EMPTY', 'fb')).toBe('')
	})
})

describe('getRequiredEnv', () => {
	test('returns the value when set', () => {
		process.env.THYME_TEST_A = 'v'
		expect(getRequiredEnv('THYME_TEST_A')).toBe('v')
	})

	test('throws when the variable is missing', () => {
		expect(() => getRequiredEnv('THYME_TEST_MISSING')).toThrow(
			'Missing required environment variable: THYME_TEST_MISSING',
		)
	})

	test('treats an empty-string env var as MISSING (inconsistent with getEnv)', () => {
		// Documents the divergence: getEnv('X') === '' but getRequiredEnv('X')
		// throws for the same empty value because it uses a falsy check.
		process.env.THYME_TEST_EMPTY = ''
		expect(() => getRequiredEnv('THYME_TEST_EMPTY')).toThrow()
	})
})
