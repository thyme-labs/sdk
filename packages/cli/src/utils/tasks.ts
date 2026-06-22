import { existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Regex pattern for valid task names
 * Only lowercase alphanumeric characters and hyphens allowed
 */
const VALID_TASK_NAME_PATTERN = /^[a-z0-9-]+$/

/**
 * Maximum length for task names
 */
const MAX_TASK_NAME_LENGTH = 64

/**
 * Validate a task name for security and consistency
 * Prevents path traversal and ensures valid naming conventions
 *
 * @throws Error if task name is invalid
 */
export function validateTaskName(taskName: string): void {
	if (!taskName) {
		throw new Error('Task name is required')
	}

	if (taskName.length > MAX_TASK_NAME_LENGTH) {
		throw new Error(
			`Task name too long: ${taskName.length} characters (max: ${MAX_TASK_NAME_LENGTH})`,
		)
	}

	// Check for path traversal attempts
	if (
		taskName.includes('..') ||
		taskName.includes('/') ||
		taskName.includes('\\')
	) {
		throw new Error('Invalid task name: path traversal characters not allowed')
	}

	// Check for valid characters
	if (!VALID_TASK_NAME_PATTERN.test(taskName)) {
		throw new Error(
			'Task name must be lowercase alphanumeric with hyphens only',
		)
	}

	// Check for reserved names
	const reservedNames = ['node_modules', 'dist', 'build', 'src', 'lib']
	if (reservedNames.includes(taskName)) {
		throw new Error(`Task name "${taskName}" is reserved`)
	}
}

/**
 * Discover all tasks in the functions directory
 */
export async function discoverTasks(projectRoot: string): Promise<string[]> {
	const functionsDir = join(projectRoot, 'functions')

	if (!existsSync(functionsDir)) {
		return []
	}

	try {
		const entries = await readdir(functionsDir, { withFileTypes: true })

		return entries
			.filter((e) => e.isDirectory())
			.filter((e) => {
				// Validate task name format
				try {
					validateTaskName(e.name)
					return existsSync(join(functionsDir, e.name, 'index.ts'))
				} catch {
					return false
				}
			})
			.map((e) => e.name)
	} catch {
		return []
	}
}

/**
 * Get the path to a task's index file
 * Includes path traversal protection
 *
 * @throws Error if task name is invalid or path escapes functions directory
 */
export function getTaskPath(projectRoot: string, taskName: string): string {
	// Validate task name first
	validateTaskName(taskName)

	const functionsDir = resolve(projectRoot, 'functions')
	const taskPath = resolve(functionsDir, taskName, 'index.ts')

	// Ensure the resolved path is within the functions directory
	if (!taskPath.startsWith(functionsDir)) {
		throw new Error('Invalid task path: path traversal detected')
	}

	return taskPath
}

/**
 * Get the path to a task's args file
 * Includes path traversal protection
 *
 * @throws Error if task name is invalid or path escapes functions directory
 */
export function getTaskArgsPath(projectRoot: string, taskName: string): string {
	// Validate task name first
	validateTaskName(taskName)

	const functionsDir = resolve(projectRoot, 'functions')
	const argsPath = resolve(functionsDir, taskName, 'args.json')

	// Ensure the resolved path is within the functions directory
	if (!argsPath.startsWith(functionsDir)) {
		throw new Error('Invalid task path: path traversal detected')
	}

	return argsPath
}

/**
 * Get the path to a task's local storage file
 * Includes path traversal protection
 *
 * @throws Error if task name is invalid or path escapes functions directory
 */
export function getTaskStoragePath(
	projectRoot: string,
	taskName: string,
): string {
	// Validate task name first
	validateTaskName(taskName)

	const functionsDir = resolve(projectRoot, 'functions')
	const storagePath = resolve(functionsDir, taskName, 'storage.json')

	// Ensure the resolved path is within the functions directory
	if (!storagePath.startsWith(functionsDir)) {
		throw new Error('Invalid task path: path traversal detected')
	}

	return storagePath
}

/**
 * Get the path to a task's local env file
 * Includes path traversal protection
 *
 * @throws Error if task name is invalid or path escapes functions directory
 */
export function getTaskEnvPath(projectRoot: string, taskName: string): string {
	// Validate task name first
	validateTaskName(taskName)

	const functionsDir = resolve(projectRoot, 'functions')
	const envPath = resolve(functionsDir, taskName, '.env')

	// Ensure the resolved path is within the functions directory
	if (!envPath.startsWith(functionsDir)) {
		throw new Error('Invalid task path: path traversal detected')
	}

	return envPath
}

/**
 * Check if we're in a Thyme project
 * Validates by checking for functions directory AND package.json with @thyme-labs/sdk
 */
export function isThymeProject(projectRoot: string): boolean {
	const functionsDir = join(projectRoot, 'functions')
	const packageJsonPath = join(projectRoot, 'package.json')

	// Must have functions directory
	if (!existsSync(functionsDir)) {
		return false
	}

	// Check for package.json with thyme SDK dependency
	if (existsSync(packageJsonPath)) {
		try {
			// Synchronous check for simplicity in this validation function
			const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
			const deps = {
				...packageJson.dependencies,
				...packageJson.devDependencies,
			}
			return '@thyme-labs/sdk' in deps || '@thyme-labs/cli' in deps
		} catch {
			// If we can't read package.json, fall back to just checking functions dir
			return true
		}
	}

	return true
}
