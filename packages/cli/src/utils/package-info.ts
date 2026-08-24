import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface PackageManifest {
	version?: string
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
}

export interface ScaffoldDependencyVersions {
	sdk: string
	cli: string
	viem: string
	zod: string
	typescript: string
}

let cachedManifest: PackageManifest | null | undefined

function readCliPackageManifest(): PackageManifest | null {
	if (cachedManifest !== undefined) return cachedManifest

	const moduleDir = dirname(fileURLToPath(import.meta.url))
	for (const candidate of [
		join(moduleDir, '../package.json'),
		join(moduleDir, '../../package.json'),
	]) {
		try {
			cachedManifest = JSON.parse(
				readFileSync(candidate, 'utf-8'),
			) as PackageManifest
			return cachedManifest
		} catch {
			// Source modules and the bundled executable sit at different depths.
		}
	}

	cachedManifest = null
	return cachedManifest
}

export function getCliVersion(): string {
	return readCliPackageManifest()?.version || '0.0.0'
}

/**
 * Keep generated projects compatible with the CLI that created them. Package
 * versions are read from the installed CLI manifest instead of being copied
 * into the scaffold, where they previously drifted for several releases.
 */
export function getScaffoldDependencyVersions(): ScaffoldDependencyVersions {
	const manifest = readCliPackageManifest()
	const dependencies = manifest?.dependencies
	const devDependencies = manifest?.devDependencies
	const versions = {
		sdk: dependencies?.['@thyme-labs/sdk'],
		cli: manifest?.version,
		viem: dependencies?.viem,
		zod: dependencies?.zod,
		typescript: devDependencies?.typescript,
	}

	for (const [name, version] of Object.entries(versions)) {
		if (!version) {
			throw new Error(
				`Cannot scaffold a project: the CLI package manifest is missing ${name}`,
			)
		}
	}

	return versions as ScaffoldDependencyVersions
}
