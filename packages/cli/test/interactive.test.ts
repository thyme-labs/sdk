import { describe, expect, test } from 'bun:test'
import {
	buildNonInteractiveMessage,
	describeNonInteractive,
	isNonInteractiveEnv,
	resolveInteractivity,
} from '../src/utils/interactive'

describe('non-interactive environment detection', () => {
	test('treats the standard CI variables as non-interactive', () => {
		for (const env of [
			{ CI: 'true' },
			{ CI: '1' },
			{ CI: 'woodpecker' },
			{ CONTINUOUS_INTEGRATION: 'true' },
			{ THYME_CI: 'true' },
			{ THYME_NON_INTERACTIVE: '1' },
		]) {
			expect(isNonInteractiveEnv(env)).toBe(true)
		}
	})

	test('ignores unset and explicitly disabled variables', () => {
		for (const env of [
			{},
			{ CI: '' },
			{ CI: '0' },
			{ CI: 'false' },
			{ CI: 'FALSE' },
			{ CI: 'no' },
			{ THYME_CI: 'off' },
			{ SOMETHING_ELSE: 'true' },
		]) {
			expect(isNonInteractiveEnv(env)).toBe(false)
		}
	})
})

describe('interactivity resolution', () => {
	test('a TTY with no CI signal stays interactive', () => {
		expect(resolveInteractivity({ env: {}, tty: true })).toEqual({
			interactive: true,
			assumeYes: false,
			reason: null,
		})
	})

	test('--ci wins over everything and implies yes', () => {
		expect(resolveInteractivity({ ci: true, env: {}, tty: true })).toEqual({
			interactive: false,
			assumeYes: true,
			reason: 'flag',
		})
	})

	test('a CI variable disables prompts even with a TTY attached', () => {
		expect(resolveInteractivity({ env: { CI: 'true' }, tty: true })).toEqual({
			interactive: false,
			assumeYes: true,
			reason: 'env',
		})
	})

	test('a piped stdio disables prompts', () => {
		expect(resolveInteractivity({ env: {}, tty: false })).toEqual({
			interactive: false,
			assumeYes: true,
			reason: 'tty',
		})
	})

	test('--yes keeps prompts but pre-answers confirmations', () => {
		expect(resolveInteractivity({ yes: true, env: {}, tty: true })).toEqual({
			interactive: true,
			assumeYes: true,
			reason: null,
		})
	})
})

describe('missing-input errors', () => {
	test('name the cause and the flag that supplies the value', () => {
		const message = buildNonInteractiveMessage(
			'A workspace',
			'Pass `--workspace <id>`.',
			'flag',
		)
		expect(message).toContain('A workspace is required')
		expect(message).toContain('--ci was passed')
		expect(message).toContain('Pass `--workspace <id>`.')
	})

	test('describe every reason distinctly', () => {
		const described = (['flag', 'env', 'tty', null] as const).map((reason) =>
			describeNonInteractive(reason),
		)
		expect(new Set(described).size).toBe(described.length)
	})
})
