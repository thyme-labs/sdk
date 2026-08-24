import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getScaffoldDependencyVersions } from '../src/utils/package-info'

const cliEntry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
let fixtureRoot = ''
let projectRoot = ''

function runCli(args: string[]) {
	return spawnSync(process.execPath, [cliEntry, ...args], {
		cwd: projectRoot || fixtureRoot,
		encoding: 'utf8',
		env: {
			...process.env,
			CI: '1',
			NO_COLOR: '1',
		},
	})
}

beforeAll(() => {
	fixtureRoot = mkdtempSync(join(tmpdir(), 'thyme-scaffold-'))
	projectRoot = fixtureRoot

	const init = runCli(['init', 'smoke-project', '--ci'])
	if (init.status !== 0) {
		throw new Error(`thyme init failed:\n${init.stdout}\n${init.stderr}`)
	}
	projectRoot = join(fixtureRoot, 'smoke-project')

	const createTask = runCli(['new', 'smoke-task', '--ci'])
	if (createTask.status !== 0) {
		throw new Error(
			`thyme new failed:\n${createTask.stdout}\n${createTask.stderr}`,
		)
	}
})

afterAll(() => {
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('project and task scaffolds', () => {
	test('use versions declared by the installed CLI package', () => {
		const manifest = JSON.parse(
			readFileSync(join(projectRoot, 'package.json'), 'utf8'),
		)
		const expected = getScaffoldDependencyVersions()

		expect(manifest.dependencies).toMatchObject({
			'@thyme-labs/sdk': expected.sdk,
			viem: expected.viem,
			zod: expected.zod,
		})
		expect(manifest.devDependencies).toMatchObject({
			'@thyme-labs/cli': expected.cli,
			typescript: expected.typescript,
		})
	})

	test('create an inert task template', () => {
		const source = readFileSync(
			join(projectRoot, 'functions/smoke-task/index.ts'),
			'utf8',
		)
		expect(source).toContain('canExec: false')
		expect(source).not.toMatch(/^\s*canExec: true/m)
		expect(source).not.toContain("data: '0x'")
	})

	test('tell the user to configure the required local account', () => {
		const readme = readFileSync(join(projectRoot, 'README.md'), 'utf8')
		expect(readme).toContain('cp .env.example .env')
		expect(readme).toContain('Edit .env before running a task')
	})

	test('does not overwrite malformed storage with --persist', () => {
		const storagePath = join(projectRoot, 'functions/smoke-task/storage.json')
		const malformed = '{"runs": 4'
		writeFileSync(storagePath, malformed)

		const result = runCli(['run', 'smoke-task', '--persist', '--ci'])
		const output = `${result.stdout}\n${result.stderr}`
		expect(result.status).toBe(1)
		expect(output).toContain('storage.json contains invalid JSON')
		expect(readFileSync(storagePath, 'utf8')).toBe(malformed)
	})
})
