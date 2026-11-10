import { randomUUID } from 'node:crypto'
import { type BigIntStats, constants } from 'node:fs'
import {
	type FileHandle,
	open,
	readdir,
	rename,
	unlink,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Linux O_PATH is not exposed by Node's fs.constants. It pins an inode without
// opening a device/FIFO for I/O. /proc/self/fd then supplies descriptor-relative
// operations: only this trusted procfs link is followed, never a user pathname.
const O_PATH = 0x200000
const DIRECTORY_FLAGS =
	constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
export const LOCAL_INPUT_MAX_BYTES = 100 * 1024 * 1024

function component(name: string): void {
	if (
		!name ||
		name === '.' ||
		name === '..' ||
		name.includes('/') ||
		name.includes('\0')
	) {
		throw new Error('Expected a single file or directory name')
	}
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function regular(stats: BigIntStats, maxBytes: number): void {
	if (!stats.isFile() || stats.nlink !== 1n || stats.size > BigInt(maxBytes)) {
		throw new Error(
			`Expected a single-link regular file of at most ${maxBytes} bytes`,
		)
	}
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
	return (
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.mode === after.mode &&
		before.nlink === after.nlink &&
		before.size === after.size &&
		before.mtimeNs === after.mtimeNs &&
		before.ctimeNs === after.ctimeNs
	)
}

/** An explicit directory authority, retained across selection, execution and writes. */
export class PinnedDirectory {
	private constructor(
		readonly handle: FileHandle,
		readonly path: string,
	) {}

	get procPath(): string {
		return `/proc/self/fd/${this.handle.fd}`
	}

	static async open(path: string): Promise<PinnedDirectory> {
		if (process.platform !== 'linux') {
			throw new Error('Local file confinement requires Linux and /proc/self/fd')
		}
		const absolute = resolve(path)
		// The caller's working directory is an explicit authority already held by
		// the kernel. Do not re-resolve its parents if they are renamed meanwhile.
		if (absolute === process.cwd()) {
			return new PinnedDirectory(await open('.', DIRECTORY_FLAGS), absolute)
		}
		let directory = new PinnedDirectory(await open('/', DIRECTORY_FLAGS), '/')
		try {
			for (const name of absolute.split('/').filter(Boolean)) {
				const next = await directory.directory(name)
				await directory.close()
				directory = next
			}
			return directory
		} catch (error) {
			await directory.close()
			throw error
		}
	}

	async directory(name: string): Promise<PinnedDirectory> {
		component(name)
		return new PinnedDirectory(
			await open(`${this.procPath}/${name}`, DIRECTORY_FLAGS),
			join(this.path, name),
		)
	}

	async descendants(names: string[]): Promise<PinnedDirectory> {
		if (!names.length) throw new Error('A task must have its own directory')
		let current: PinnedDirectory | undefined
		try {
			for (const name of names) {
				const next = await (current ?? this).directory(name)
				await current?.close()
				current = next
			}
			return current!
		} catch (error) {
			await current?.close()
			throw error
		}
	}

	async entries(): Promise<string[]> {
		return readdir(this.procPath)
	}

	async file(
		name: string,
		optional = false,
		maxBytes = LOCAL_INPUT_MAX_BYTES,
	): Promise<FileHandle | undefined> {
		component(name)
		let handle: FileHandle
		try {
			handle = await open(
				`${this.procPath}/${name}`,
				O_PATH | constants.O_NOFOLLOW,
			)
		} catch (error) {
			if (optional && missing(error)) return undefined
			throw error
		}
		try {
			regular(await handle.stat({ bigint: true }), maxBytes)
			return handle
		} catch (error) {
			await handle.close()
			throw new Error(
				`Unsafe local file ${name}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	async read(
		name: string,
		optional = true,
		maxBytes = LOCAL_INPUT_MAX_BYTES,
	): Promise<string | undefined> {
		const pinned = await this.file(name, optional, maxBytes)
		if (!pinned) return undefined
		let reader: FileHandle | undefined
		try {
			const before = await pinned.stat({ bigint: true })
			regular(before, maxBytes)
			// Reopen the pinned regular inode, not its potentially replaced name.
			reader = await open(
				`/proc/self/fd/${pinned.fd}`,
				constants.O_RDONLY | constants.O_NONBLOCK,
			)
			if (!unchanged(before, await reader.stat({ bigint: true })))
				throw new Error('Local input changed while opening')
			const bytes = Buffer.alloc(Number(before.size))
			let offset = 0
			while (offset < bytes.length) {
				const { bytesRead } = await reader.read(
					bytes,
					offset,
					Math.min(bytes.length - offset, 64 * 1024),
					offset,
				)
				if (!bytesRead) throw new Error('Local input changed while reading')
				offset += bytesRead
			}
			const after = await reader.stat({ bigint: true })
			regular(after, maxBytes)
			if (!unchanged(before, after))
				throw new Error('Local input changed while reading')
			return bytes.toString('utf8')
		} finally {
			await reader?.close()
			await pinned.close()
		}
	}

	async writeAtomic(name: string, text: string): Promise<void> {
		component(name)
		if (Buffer.byteLength(text) > LOCAL_INPUT_MAX_BYTES)
			throw new Error('Local storage is too large')
		const existing = await this.file(name, true)
		await existing?.close()
		const temporary = `.thyme-${randomUUID()}.tmp`
		const source = `${this.procPath}/${temporary}`
		const writer = await open(
			source,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		)
		try {
			regular(await writer.stat({ bigint: true }), LOCAL_INPUT_MAX_BYTES)
			await writer.writeFile(text, 'utf8')
			await writer.sync()
			const completed = await writer.stat({ bigint: true })
			regular(completed, LOCAL_INPUT_MAX_BYTES)
			const named = await this.file(temporary)
			try {
				if (!named || !unchanged(completed, await named.stat({ bigint: true })))
					throw new Error('Local storage staging file changed')
			} finally {
				await named?.close()
			}
			// rename replaces the directory entry; it never follows/truncates an
			// existing target, even if replaced by a symlink/hardlink after validation.
			await rename(source, `${this.procPath}/${name}`)
		} finally {
			await writer.close()
			await unlink(source).catch((error: unknown) => {
				if (!missing(error)) throw error
			})
		}
	}

	async close(): Promise<void> {
		await this.handle.close()
	}
}

export interface LocalFileAuthority {
	project: PinnedDirectory
	task: PinnedDirectory
}
