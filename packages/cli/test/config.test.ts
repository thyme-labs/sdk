import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect node:os.homedir() to a throwaway directory so the suite never
// reads or writes the developer's real ~/.thyme/config.json.
let fakeHome = ''
mock.module('node:os', () => ({ homedir: () => fakeHome, tmpdir }))

const config = await import('../src/utils/config')

const configFile = () => join(fakeHome, '.thyme', 'config.json')

const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ['THYME_AUTH_TOKEN', 'THYME_API_URL']

beforeEach(() => {
	fakeHome = mkdtempSync(join(tmpdir(), 'thyme-home-'))
	// Ensure ~/.thyme exists so tests that write the config file directly work.
	config.getConfigDir()
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k]
		delete process.env[k]
	}
})

afterEach(() => {
	rmSync(fakeHome, { recursive: true, force: true })
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k]
		else process.env[k] = savedEnv[k]
	}
})

describe('readConfig', () => {
	test('returns {} when no config file exists', () => {
		expect(config.readConfig()).toEqual({})
	})

	test('returns {} when the config file is invalid JSON', () => {
		writeFileSync(configFile(), '{ broken')
		expect(config.readConfig()).toEqual({})
	})

	test('parses a valid config file', () => {
		writeFileSync(configFile(), JSON.stringify({ authToken: 't', apiUrl: 'u' }))
		expect(config.readConfig()).toEqual({ authToken: 't', apiUrl: 'u' })
	})
})

describe('writeConfig', () => {
	test('persists JSON and creates the .thyme directory', () => {
		config.writeConfig({ authToken: 'abc' })
		expect(existsSync(configFile())).toBe(true)
		expect(JSON.parse(readFileSync(configFile(), 'utf-8'))).toEqual({
			authToken: 'abc',
		})
	})

	test('writes the file with 0600 permissions (owner read/write only)', () => {
		config.writeConfig({ authToken: 'abc' })
		const mode = statSync(configFile()).mode & 0o777
		expect(mode).toBe(0o600)
	})
})

describe('auth token helpers', () => {
	test('setAuthToken then getAuthToken round-trips via config', () => {
		config.setAuthToken('secret')
		expect(config.getAuthToken()).toBe('secret')
	})

	test('getAuthToken falls back to THYME_AUTH_TOKEN env when no config', () => {
		process.env.THYME_AUTH_TOKEN = 'from-env'
		expect(config.getAuthToken()).toBe('from-env')
	})

	test('config token takes precedence over the env var', () => {
		config.setAuthToken('from-config')
		process.env.THYME_AUTH_TOKEN = 'from-env'
		expect(config.getAuthToken()).toBe('from-config')
	})

	test('clearAuthToken removes the token from config', () => {
		config.setAuthToken('secret')
		config.clearAuthToken()
		expect(config.getAuthToken()).toBeUndefined()
	})
})

describe('API URL resolution', () => {
	const DEFAULT_URL = 'https://functions.thymelabs.io/http'

	test('falls back to the built-in default when nothing is configured', () => {
		expect(config.getApiUrl()).toBe(DEFAULT_URL)
		expect(config.getApiUrlInfo()).toEqual({
			url: DEFAULT_URL,
			source: 'default',
		})
	})

	test('uses THYME_API_URL env when present and no config value', () => {
		process.env.THYME_API_URL = 'https://env.example/http'
		expect(config.getApiUrl()).toBe('https://env.example/http')
		expect(config.getApiUrlInfo().source).toBe('env')
	})

	test('env THYME_API_URL wins over both config and default (12-factor)', () => {
		config.setApiUrl('https://config.example/http')
		process.env.THYME_API_URL = 'https://env.example/http'
		expect(config.getApiUrl()).toBe('https://env.example/http')
		expect(config.getApiUrlInfo().source).toBe('env')
	})

	test('config apiUrl wins over the default when no env is set', () => {
		config.setApiUrl('https://config.example/http')
		expect(config.getApiUrl()).toBe('https://config.example/http')
		expect(config.getApiUrlInfo().source).toBe('config')
	})
})
