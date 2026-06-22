import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	discoverTasks,
	getTaskArgsPath,
	getTaskEnvPath,
	getTaskPath,
	isThymeProject,
	validateTaskName,
} from '../src/utils/tasks'

let root: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'thyme-tasks-'))
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

describe('validateTaskName', () => {
	test('accepts lowercase, digits and hyphens', () => {
		expect(() => validateTaskName('my-task-2')).not.toThrow()
		expect(() => validateTaskName('abc123')).not.toThrow()
	})

	test('rejects an empty name', () => {
		expect(() => validateTaskName('')).toThrow('Task name is required')
	})

	test('rejects names longer than 64 characters', () => {
		expect(() => validateTaskName('a'.repeat(65))).toThrow('too long')
	})

	test('rejects path-traversal characters', () => {
		expect(() => validateTaskName('../evil')).toThrow('path traversal')
		expect(() => validateTaskName('a/b')).toThrow('path traversal')
		expect(() => validateTaskName('a\\b')).toThrow('path traversal')
	})

	test('rejects uppercase and other invalid characters', () => {
		expect(() => validateTaskName('MyTask')).toThrow('lowercase alphanumeric')
		expect(() => validateTaskName('my_task')).toThrow('lowercase alphanumeric')
		expect(() => validateTaskName('my task')).toThrow('lowercase alphanumeric')
	})

	test('rejects reserved names', () => {
		for (const reserved of ['node_modules', 'dist', 'build', 'src', 'lib']) {
			// node_modules/build/lib also contain underscores/are lowercase ok,
			// the reserved check is what should fire here.
			expect(() => validateTaskName(reserved)).toThrow()
		}
		expect(() => validateTaskName('dist')).toThrow('reserved')
	})
})

describe('getTaskPath / getTaskArgsPath / getTaskEnvPath', () => {
	test('build the expected paths inside functions/<task>', () => {
		expect(getTaskPath(root, 'foo')).toBe(
			join(root, 'functions', 'foo', 'index.ts'),
		)
		expect(getTaskArgsPath(root, 'foo')).toBe(
			join(root, 'functions', 'foo', 'args.json'),
		)
		expect(getTaskEnvPath(root, 'foo')).toBe(
			join(root, 'functions', 'foo', '.env'),
		)
	})

	test('validate the task name before resolving', () => {
		expect(() => getTaskPath(root, '../escape')).toThrow()
		expect(() => getTaskArgsPath(root, 'Bad Name')).toThrow()
		expect(() => getTaskEnvPath(root, '')).toThrow()
	})
})

describe('discoverTasks', () => {
	test('returns [] when there is no functions directory', async () => {
		expect(await discoverTasks(root)).toEqual([])
	})

	test('lists only directories that contain an index.ts', async () => {
		const fns = join(root, 'functions')
		mkdirSync(join(fns, 'with-index'), { recursive: true })
		writeFileSync(join(fns, 'with-index', 'index.ts'), 'x')
		mkdirSync(join(fns, 'no-index'), { recursive: true })
		const tasks = await discoverTasks(root)
		expect(tasks).toEqual(['with-index'])
	})

	test('skips directories with invalid task names', async () => {
		const fns = join(root, 'functions')
		mkdirSync(join(fns, 'Invalid_Name'), { recursive: true })
		writeFileSync(join(fns, 'Invalid_Name', 'index.ts'), 'x')
		expect(await discoverTasks(root)).toEqual([])
	})

	test('ignores plain files in the functions directory', async () => {
		const fns = join(root, 'functions')
		mkdirSync(fns, { recursive: true })
		writeFileSync(join(fns, 'index.ts'), 'x')
		expect(await discoverTasks(root)).toEqual([])
	})
})

describe('isThymeProject', () => {
	test('false when there is no functions directory', () => {
		expect(isThymeProject(root)).toBe(false)
	})

	test('true with functions dir + package.json depending on the SDK', () => {
		mkdirSync(join(root, 'functions'), { recursive: true })
		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({ dependencies: { '@thyme-labs/sdk': '^0.3.2' } }),
		)
		expect(isThymeProject(root)).toBe(true)
	})

	test('true with functions dir + devDependency on the CLI', () => {
		mkdirSync(join(root, 'functions'), { recursive: true })
		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({ devDependencies: { '@thyme-labs/cli': '^0.3.2' } }),
		)
		expect(isThymeProject(root)).toBe(true)
	})

	test('false with functions dir + package.json lacking any thyme dep', () => {
		mkdirSync(join(root, 'functions'), { recursive: true })
		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({ dependencies: { viem: '^2' } }),
		)
		expect(isThymeProject(root)).toBe(false)
	})

	test('true with functions dir and no package.json at all', () => {
		mkdirSync(join(root, 'functions'), { recursive: true })
		expect(isThymeProject(root)).toBe(true)
	})

	test('true with functions dir and unparseable package.json (lenient fallback)', () => {
		mkdirSync(join(root, 'functions'), { recursive: true })
		writeFileSync(join(root, 'package.json'), '{ not valid json')
		expect(isThymeProject(root)).toBe(true)
	})
})
