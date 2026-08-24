import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTaskInputs } from '../src/utils/task-inputs'

const tempDirectories: string[] = []

async function makeTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'thyme-inputs-'))
	tempDirectories.push(directory)
	return directory
}

afterEach(async () => {
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	)
})

describe('loadTaskInputs', () => {
	test('defaults absent args and storage files to empty objects', async () => {
		const directory = await makeTempDirectory()
		await expect(
			loadTaskInputs(
				join(directory, 'args.json'),
				join(directory, 'storage.json'),
			),
		).resolves.toEqual({ args: {}, storage: {} })
	})

	test('loads args and storage together', async () => {
		const directory = await makeTempDirectory()
		const argsPath = join(directory, 'args.json')
		const storagePath = join(directory, 'storage.json')
		await Promise.all([
			writeFile(argsPath, '{"name":"smoke"}'),
			writeFile(storagePath, '{"runs":4}'),
		])

		await expect(loadTaskInputs(argsPath, storagePath)).resolves.toEqual({
			args: { name: 'smoke' },
			storage: { runs: 4 },
		})
	})

	test('rejects malformed args instead of substituting an empty object', async () => {
		const directory = await makeTempDirectory()
		const argsPath = join(directory, 'args.json')
		await writeFile(argsPath, '{"name":')

		await expect(
			loadTaskInputs(argsPath, join(directory, 'storage.json')),
		).rejects.toThrow('args.json contains invalid JSON')
	})

	test('rejects malformed storage so --persist cannot replace it', async () => {
		const directory = await makeTempDirectory()
		const storagePath = join(directory, 'storage.json')
		await writeFile(storagePath, '{"runs":4')

		await expect(
			loadTaskInputs(join(directory, 'args.json'), storagePath),
		).rejects.toThrow('storage.json contains invalid JSON')
	})
})
