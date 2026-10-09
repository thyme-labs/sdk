import { strToU8, zipSync } from 'fflate'

/** Runtime-neutral serialization shared by the CLI and hosted upload paths. */
export function buildTaskArchive({
	source,
	bundle,
	permissions,
}: {
	source: string
	bundle: string
	permissions?: string
}): Uint8Array {
	return zipSync(
		{
			'source.ts': strToU8(source),
			'bundle.js': strToU8(bundle),
			...(permissions === undefined
				? {}
				: { 'permissions.json': strToU8(permissions) }),
		},
		{
			level: 6,
			// fflate writes local date fields. This produces the same DOS
			// timestamp in every timezone and keeps upload checksums stable.
			mtime: new Date(1980, 0, 1, 0, 0, 0),
		},
	)
}
