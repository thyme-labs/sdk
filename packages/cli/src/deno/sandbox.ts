import { execFile, spawn } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import {
	access,
	type FileHandle,
	mkdtemp,
	realpath,
	rm,
	stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import {
	type LocalFileAuthority,
	PinnedDirectory,
} from '../utils/confined-files'

// Capture launcher settings before the CLI loads project/task .env files. Task
// secrets must never become loader options (LD_PRELOAD, DENO_V8_FLAGS, etc.).
const launcherPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'
const scratchRoot = tmpdir()
const launcherEnv = { PATH: launcherPath, LANG: 'C' }
const execFileAsync = promisify(execFile)
const supportedDeno = '2.9.6'

async function executable(name: string): Promise<string> {
	for (const directory of launcherPath.split(delimiter)) {
		if (!isAbsolute(directory)) continue
		const candidate = join(directory, name)
		try {
			await access(candidate, constants.X_OK)
			if ((await stat(candidate)).isFile()) return await realpath(candidate)
		} catch {
			// Try the next absolute PATH entry.
		}
	}
	throw new Error(`Local isolation requires ${name} on PATH`)
}

async function inspect(command: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync(command, args, {
		cwd: '/',
		env: launcherEnv,
		timeout: 5000,
		maxBuffer: 128 * 1024,
	})
	return stdout
}

export async function supportedDenoExecutable(): Promise<string> {
	if (process.platform !== 'linux') {
		throw new Error(
			'Local task execution requires Linux with Landlock and util-linux setpriv 2.41+. Use a Linux VM on macOS/Windows; there is no unrestricted fallback.',
		)
	}
	const deno = await executable('deno')
	const version = await inspect(deno, ['--version'])
	if (!version.startsWith(`deno ${supportedDeno} `)) {
		throw new Error(`Local isolation currently requires Deno ${supportedDeno}`)
	}
	return deno
}

export interface DenoSandbox {
	readPaths: string[]
	spawn: (flags: string[]) => ReturnType<typeof spawn>
	cleanup: () => Promise<void>
}

/**
 * Landlock mediates file opens by the OS, including Deno's module loader, before
 * any task module is read. A Deno --allow-read list alone does NOT do that.
 * Do not bundle or resolve task imports in the unrestricted parent process.
 */
export async function createDenoSandbox(
	taskDir: string,
	projectRoot: string,
	files?: LocalFileAuthority,
): Promise<DenoSandbox> {
	const deno = await supportedDenoExecutable()
	const setpriv = await executable('setpriv')
	const taskRelative = relative(projectRoot, taskDir)
	if (
		taskRelative === '..' ||
		taskRelative.startsWith(`..${sep}`) ||
		isAbsolute(taskRelative) ||
		!taskRelative
	) {
		throw new Error('The task must be in its own directory inside the project')
	}
	const owned: FileHandle[] = []
	let scratch: string | undefined
	try {
		const project = files?.project ?? (await PinnedDirectory.open(projectRoot))
		if (!files) owned.push(project.handle)
		const task =
			files?.task ?? (await project.descendants(taskRelative.split(sep)))
		if (!files) owned.push(task.handle)
		const dependencies = await project.directory('node_modules')
		owned.push(dependencies.handle)
		const grants = [task.handle, dependencies.handle]
		const readPaths = [taskDir, join(projectRoot, 'node_modules')]
		for (const name of [
			'package.json',
			'deno.json',
			'deno.jsonc',
			'tsconfig.json',
		]) {
			const handle = await project.file(name, true)
			if (handle) {
				owned.push(handle)
				grants.push(handle)
				readPaths.push(join(projectRoot, name))
			}
		}

		const rules: string[] = []
		const allow = (path: string, rights: string) => {
			rules.push('--landlock-rule', `path-beneath:${rights}:${path}`)
		}
		// Pass the actual approved inodes to setpriv. Reopening their original
		// names after validation would allow a rename/symlink race to widen a grant.
		for (const [index] of grants.entries()) {
			allow(
				`/proc/self/fd/${index + 3}`,
				index < 2 ? 'read-file,read-dir' : 'read-file',
			)
		}

		allow(deno, 'read-file,execute')
		// Grant individual runtime libraries, never /usr, /lib, HOME or the project
		// root. ldd only inspects the user's trusted Deno executable, not task code.
		const libraries = await inspect(await executable('ldd'), [deno])
		for (const match of libraries.matchAll(/(?:=>\s+|^\s*)(\/\S+)\s+\(/gm)) {
			allow(await realpath(match[1]!), 'read-file,execute')
		}
		for (const path of [
			'/etc/ld.so.cache',
			'/etc/resolv.conf',
			'/etc/hosts',
			'/etc/nsswitch.conf',
			'/etc/gai.conf',
			'/etc/localtime',
			'/dev/urandom',
			'/dev/random',
		]) {
			if (existsSync(path)) allow(await realpath(path), 'read-file')
		}
		allow('/dev/null', 'read-file,write-file')

		scratch = await mkdtemp(join(scratchRoot, 'thyme-deno-'))
		allow(
			await realpath(scratch),
			'read-file,read-dir,write-file,remove-dir,remove-file,make-dir,make-reg,refer,truncate',
		)
		return {
			readPaths,
			spawn: (flags) =>
				spawn(
					setpriv,
					[
						'--no-new-privs',
						'--landlock-access',
						'fs',
						...rules,
						'--',
						deno,
						...flags,
					],
					{
						cwd: `/proc/${process.pid}/fd/${task.handle.fd}`,
						stdio: [
							'pipe',
							'pipe',
							'pipe',
							...grants.map((handle) => handle.fd),
						],
						env: {
							...launcherEnv,
							HOME: scratch,
							TMPDIR: scratch,
							DENO_DIR: join(scratch!, 'cache'),
						},
					},
				),
			cleanup: async () => {
				await Promise.all(owned.map((handle) => handle.close()))
				await rm(scratch!, { recursive: true, force: true })
			},
		}
	} catch (error) {
		await Promise.all(owned.map((handle) => handle.close()))
		if (scratch) await rm(scratch, { recursive: true, force: true })
		throw error
	}
}
