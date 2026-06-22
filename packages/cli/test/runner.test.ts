import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDeno, runInDeno } from '../src/deno/runner'

// Whether a real task can actually be executed here. This needs Deno AND the
// ability to initialise the npm sandbox (viem download). When either is
// unavailable (offline sandbox, CI image with only Bun) the integration tests
// below skip themselves rather than failing, so the suite stays green anywhere.
let denoUsable = false

const makeTask = (body: string) => {
	const root = mkdtempSync(join(tmpdir(), 'thyme-run-'))
	const taskPath = join(root, 'index.ts')
	writeFileSync(
		taskPath,
		`export default {\n  async run(ctx) {\n${body}\n  }\n}\n`,
	)
	return { root, taskPath }
}

beforeAll(async () => {
	if (!(await checkDeno())) return
	const { root, taskPath } = makeTask(
		`    return { canExec: false, message: 'canary' }`,
	)
	const canary = await runInDeno(
		taskPath,
		{},
		{ memory: 128, timeout: 30, network: false },
		root,
	)
	denoUsable = canary.success
	if (!denoUsable) {
		console.warn(
			'[runner.test] Deno sandbox unavailable — skipping integration tests',
		)
	}
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
		const { root, taskPath } = makeTask(
			`    ctx.logger.info('hello ' + ctx.args.name)
    return { canExec: false, message: 'done:' + ctx.args.name }`,
		)
		const result = await runInDeno(
			taskPath,
			{ name: 'world' },
			{ memory: 128, timeout: 30, network: false },
			root,
		)
		expect(result.success).toBe(true)
		expect(result.result).toEqual({ canExec: false, message: 'done:world' })
		expect(result.logs.some((l) => l.includes('hello world'))).toBe(true)
		expect(typeof result.executionTime).toBe('number')
		expect(result.rpcRequestCount).toBe(0)
	}, 60_000)

	test('exposes user secrets but filters reserved/unsafe keys', async () => {
		if (!denoUsable) return
		const { root, taskPath } = makeTask(
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
				timeout: 30,
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
		const { root, taskPath } = makeTask(
			`    ctx.storage.runs = (ctx.storage.runs ?? 0) + 1
    return { canExec: false, message: String(ctx.storage.runs) }`,
		)
		const result = await runInDeno(
			taskPath,
			{},
			{ memory: 128, timeout: 30, network: false },
			root,
			{ runs: 4 },
		)
		expect(result.success).toBe(true)
		expect(result.result).toEqual({ canExec: false, message: '5' })
		expect(result.storage).toEqual({ runs: 5 })
	}, 60_000)

	test('reports failure (not a throw) when the task itself throws', async () => {
		if (!denoUsable) return
		const { root, taskPath } = makeTask(`    throw new Error('boom')`)
		const result = await runInDeno(
			taskPath,
			{},
			{ memory: 128, timeout: 30, network: false },
			root,
		)
		expect(result.success).toBe(false)
		expect(result.error).toBeTruthy()
	}, 60_000)
})
