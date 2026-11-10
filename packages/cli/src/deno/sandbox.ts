import { execFile, spawn } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

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
): Promise<DenoSandbox> {
	const deno = await supportedDenoExecutable()
	const setpriv = await executable('setpriv')
	const root = await realpath(projectRoot)
	const taskRelative = relative(projectRoot, taskDir)
	if (
		taskRelative === '..' ||
		taskRelative.startsWith(`..${sep}`) ||
		isAbsolute(taskRelative) ||
		!taskRelative
	) {
		throw new Error('The task must be in its own directory inside the project')
	}
	const readPaths = [join(root, taskRelative), join(root, 'node_modules')]
	for (const name of [
		'package.json',
		'deno.json',
		'deno.jsonc',
		'tsconfig.json',
	]) {
		const path = join(root, name)
		if (existsSync(path)) readPaths.push(path)
	}

	const rules: string[] = []
	const allow = (path: string, rights: string) => {
		rules.push('--landlock-rule', `path-beneath:${rights}:${path}`)
	}
	for (const [index, path] of readPaths.entries()) {
		// Never turn an out-of-tree symlink into a new filesystem grant. Symlinks
		// *inside* these roots are checked by Landlock when Deno follows them.
		if ((await realpath(path)) !== path) {
			throw new Error(
				'Task, node_modules and project config grant roots must not be symlinks',
			)
		}
		const entry = await stat(path)
		if (index < 2 ? !entry.isDirectory() : !entry.isFile()) {
			throw new Error(
				'Isolation requires task/dependency directories and regular config files',
			)
		}
		allow(path, index < 2 ? 'read-file,read-dir' : 'read-file')
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

	const scratch = await mkdtemp(join(scratchRoot, 'thyme-deno-'))
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
					cwd: resolve(taskDir),
					stdio: ['pipe', 'pipe', 'pipe'],
					env: {
						...launcherEnv,
						HOME: scratch,
						TMPDIR: scratch,
						DENO_DIR: join(scratch, 'cache'),
					},
				},
			),
		cleanup: () => rm(scratch, { recursive: true, force: true }),
	}
}
