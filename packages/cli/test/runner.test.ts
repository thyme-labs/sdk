import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDeno, runInDeno } from '../src/deno/runner'

// Whether a real task can actually be executed here. This needs Deno AND a
// project with node_modules (the read-only runner uses `--node-modules-dir=manual`,
// so the wrapper's bare `viem` import resolves from the project's node_modules).
// When Deno or `bun install` is unavailable (offline CI image with only Bun, no
// network), the integration tests below skip themselves rather than failing.
let denoUsable = false
let fixtureRoot = ''
let taskCounter = 0

const makeTask = (body: string) => {
	const dir = join(fixtureRoot, 'tasks', `t${taskCounter++}`)
	mkdirSync(dir, { recursive: true })
	const taskPath = join(dir, 'index.ts')
	writeFileSync(
		taskPath,
		`export default {\n  async run(ctx) {\n${body}\n  }\n}\n`,
	)
	return { taskPath, root: fixtureRoot }
}

beforeAll(async () => {
	if (!(await checkDeno())) return

	// A real Thyme project has node_modules with viem installed; build a minimal
	// one so the read-only runner can resolve the wrapper's bare viem import.
	fixtureRoot = mkdtempSync(join(tmpdir(), 'thyme-run-'))
	writeFileSync(
		join(fixtureRoot, 'package.json'),
		JSON.stringify({
			name: 'fixture',
			type: 'module',
			dependencies: { viem: '2.46.3' },
		}),
	)
	try {
		execFileSync('bun', ['install', '--silent'], {
			cwd: fixtureRoot,
			stdio: 'ignore',
		})
	} catch {
		return // no bun / offline — leave denoUsable false so tests skip
	}

	const { taskPath, root } = makeTask(
		`    return { canExec: false, message: 'canary' }`,
	)
	const canary = await runInDeno(
		taskPath,
		{},
		{ memory: 128, network: false },
		root,
	)
	denoUsable = canary.success
	if (!denoUsable) {
		console.warn(
			'[runner.test] Deno sandbox unavailable — skipping integration tests',
		)
	}
})

afterAll(() => {
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('checkDeno', () => {
	test('resolves to a boolean', async () => {
		expect(typeof (await checkDeno())).toBe('boolean')
	})
})

// Integration tests exercise the real Deno sandbox; gated on `denoUsable`.
describe('runInDeno (integration, requires Deno)', () => {
	test('runs a task and returns its result + execution stats', async () => {
		if (!denoUsable) return
		const { taskPath, root } = makeTask(
			`    ctx.logger.info('hello ' + ctx.args.name)
    return { canExec: false, message: 'done:' + ctx.args.name }`,
		)
		const result = await runInDeno(
			taskPath,
			{ name: 'world' },
			{ memory: 128, network: false },
			root,
		)
		expect(result.success).toBe(true)
		expect(result.result).toEqual({ canExec: false, message: 'done:world' })
		expect(result.logs.some((l) => l.includes('hello world'))).toBe(true)
		expect(typeof result.executionTime).toBe('number')
		expect(result.rpcRequestCount).toBe(0)
	}, 60_000)

	test('serializes BigInt values (matches the production wrapper)', async () => {
		if (!denoUsable) return
		const { taskPath, root } = makeTask(
			`    ctx.logger.info(JSON.stringify({ big: 9007199254740993n }))
    return { canExec: false, message: 'bigint-ok' }`,
		)
		const result = await runInDeno(
			taskPath,
			{},
			{ memory: 128, network: false },
			root,
		)
		expect(result.success).toBe(true)
		expect(result.logs.some((l) => l.includes('"9007199254740993"'))).toBe(true)
	}, 60_000)

	test('a task that never uses ctx.client runs without an RPC URL', async () => {
		if (!denoUsable) return
		const { taskPath, root } = makeTask(
			`    return { canExec: false, message: 'no client used' }`,
		)
		const result = await runInDeno(
			taskPath,
			{},
			{ memory: 128, network: false },
			root,
		)
		expect(result.success).toBe(true)
		expect(result.result).toEqual({ canExec: false, message: 'no client used' })
	}, 60_000)

	test('exposes user secrets but filters reserved/unsafe keys', async () => {
		if (!denoUsable) return
		const { taskPath, root } = makeTask(
			`    return {
      canExec: false,
      message: JSON.stringify({
        my: ctx.secrets.MY_SECRET ?? null,
        authHidden: ctx.secrets.THYME_AUTH_TOKEN ?? null,
        rpcHidden: ctx.secrets.RPC_URL ?? null,
      }),
    }`,
		)
		const result = await runInDeno(
			taskPath,
			{},
			{
				memory: 128,
				network: false,
				env: {
					MY_SECRET: 'visible',
					THYME_AUTH_TOKEN: 'should-be-hidden',
					RPC_URL: 'http://localhost:8545',
				},
			},
			root,
		)
		expect(result.success).toBe(true)
		const payload = JSON.parse((result.result as { message: string }).message)
		expect(payload.my).toBe('visible')
		expect(payload.authHidden).toBeNull()
		expect(payload.rpcHidden).toBeNull()
	}, 60_000)

	test('exposes mutable executable storage', async () => {
		if (!denoUsable) return
		const { taskPath, root } = makeTask(
			`    ctx.storage.runs = (ctx.storage.runs ?? 0) + 1
    return { canExec: false, message: String(ctx.storage.runs) }`,
		)
		const result = await runInDeno(
			taskPath,
			{},
			{ memory: 128, network: false },
			root,
			{ runs: 4 },
		)
		expect(result.success).toBe(true)
		expect(result.result).toEqual({ canExec: false, message: '5' })
		expect(result.storage).toEqual({ runs: 5 })
	}, 60_000)

	test('cannot read project files outside the task directory', async () => {
		if (!denoUsable) return
		const secretPath = join(fixtureRoot, 'sibling-secret.txt')
		writeFileSync(secretPath, 'TOP_SECRET')
		const { taskPath, root } = makeTask(
			`    try {
      await Deno.readTextFile(${JSON.stringify(secretPath)})
      return { canExec: false, message: 'LEAKED' }
    } catch (e) {
      return { canExec: false, message: 'blocked:' + e.name }
    }`,
		)
		const result = await runInDeno(
			taskPath,
			{},
			{ memory: 128, network: false },
			root,
		)
		expect(result.success).toBe(true)
		expect((result.result as { message: string }).message).toContain('blocked')
	}, 60_000)

	test('reports failure (not a throw) when the task itself throws', async () => {
		if (!denoUsable) return
		const { taskPath, root } = makeTask(`    throw new Error('boom')`)
		const result = await runInDeno(
			taskPath,
			{},
			{ memory: 128, network: false },
			root,
		)
		expect(result.success).toBe(false)
		expect(result.error).toBeTruthy()
	}, 60_000)
})
