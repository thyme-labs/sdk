import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from 'dotenv'

export type EnvMap = Record<string, string>

/**
 * Load environment variables from .env file
 */
export function loadEnv(projectRoot: string): EnvMap {
	return loadEnvFile(join(projectRoot, '.env'))
}

/**
 * Load environment variables from a specific .env file
 */
export function loadEnvFile(
	envPath: string,
	options: { override?: boolean } = {},
): EnvMap {
	if (existsSync(envPath)) {
		const result = config({ path: envPath, override: options.override })
		return result.parsed ?? {}
	}
	return {}
}

/**
 * Resolve the currently effective values for keys loaded from env files
 */
export function resolveLoadedEnv(...envs: EnvMap[]): EnvMap {
	const result: EnvMap = {}
	const keys = new Set<string>()

	for (const env of envs) {
		for (const key of Object.keys(env)) {
			keys.add(key)
		}
	}

	for (const key of keys) {
		const value = process.env[key]
		if (value !== undefined) {
			result[key] = value
		}
	}

	return result
}

/**
 * Get environment variable with fallback
 */
export function getEnv(key: string, fallback?: string): string | undefined {
	return process.env[key] ?? fallback
}

/**
 * Get required environment variable
 */
export function getRequiredEnv(key: string): string {
	const value = process.env[key]
	if (!value) {
		throw new Error(`Missing required environment variable: ${key}`)
	}
	return value
}
