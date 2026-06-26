import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getEnv } from './env'

interface Config {
	authToken?: string
	apiUrl?: string
}

export type ApiUrlSource = 'config' | 'env' | 'default'

export function getConfigDir(): string {
	const dir = join(homedir(), '.thyme')
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true })
	}
	return dir
}

function getConfigPath(): string {
	return join(getConfigDir(), 'config.json')
}

export function readConfig(): Config {
	const configPath = getConfigPath()
	if (!existsSync(configPath)) {
		return {}
	}
	try {
		return JSON.parse(readFileSync(configPath, 'utf-8'))
	} catch {
		return {}
	}
}

export function writeConfig(config: Config): void {
	const configPath = getConfigPath()
	writeFileSync(configPath, JSON.stringify(config, null, 2), {
		mode: 0o600,
	})
}

export function getAuthToken(): string | undefined {
	// 1. Global config
	const config = readConfig()
	if (config.authToken) return config.authToken

	// 2. Environment variable or .env file
	return getEnv('THYME_AUTH_TOKEN')
}

export function setAuthToken(token: string): void {
	const config = readConfig()
	config.authToken = token
	writeConfig(config)
}

export function clearAuthToken(): void {
	const config = readConfig()
	delete config.authToken
	writeConfig(config)
}

const DEFAULT_API_URL = 'https://functions.thymelabs.io/http'

export function getApiUrl(): string {
	// 1. Environment variable or .env file (highest priority, 12-factor style)
	const envApiUrl = getEnv('THYME_API_URL')
	if (envApiUrl) return envApiUrl

	// 2. Global config (explicit override, e.g. `thyme login --api-url`)
	const config = readConfig()
	if (config.apiUrl) return config.apiUrl

	// 3. Built-in default
	return DEFAULT_API_URL
}

export function getApiUrlInfo(): { url: string; source: ApiUrlSource } {
	// 1. Environment variable or .env file (highest priority, 12-factor style)
	const envApiUrl = getEnv('THYME_API_URL')
	if (envApiUrl) {
		return { url: envApiUrl, source: 'env' }
	}

	// 2. Global config (explicit override, e.g. `thyme login --api-url`)
	const config = readConfig()
	if (config.apiUrl) {
		return { url: config.apiUrl, source: 'config' }
	}

	// 3. Fallback default
	return { url: DEFAULT_API_URL, source: 'default' }
}

export function setApiUrl(url: string): void {
	const config = readConfig()
	config.apiUrl = url
	writeConfig(config)
}
