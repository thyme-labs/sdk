export const DEFAULT_FUNCTION_VERSION_TAG = 'v1'
export const FUNCTION_VERSION_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/

export type VersionTagValidation =
	| { ok: true; versionTag: string }
	| { ok: false; message: string }

export function normalizeVersionTag(versionTag: string): string {
	return versionTag.trim().toLowerCase()
}

export function validateVersionTag(input: string): VersionTagValidation {
	const versionTag = normalizeVersionTag(input)
	if (!FUNCTION_VERSION_TAG_PATTERN.test(versionTag)) {
		return {
			ok: false,
			message:
				'Use 1-32 lowercase letters, numbers, dots, underscores, or hyphens; start with a letter or number',
		}
	}
	if (versionTag === 'latest') {
		return { ok: false, message: 'The tag "latest" is reserved' }
	}
	return { ok: true, versionTag }
}

export type ResolveUploadVersionOptions = {
	providedTag?: string
	familyExists: boolean
	suggestedVersionTag: string
	isInteractive: boolean
	prompt?: (suggestedVersionTag: string) => Promise<string | null>
}

export async function resolveUploadVersionTag({
	providedTag,
	familyExists,
	suggestedVersionTag,
	isInteractive,
	prompt,
}: ResolveUploadVersionOptions): Promise<string> {
	if (providedTag !== undefined) {
		const validation = validateVersionTag(providedTag)
		if (!validation.ok) throw new Error(validation.message)
		return validation.versionTag
	}

	if (!familyExists) return DEFAULT_FUNCTION_VERSION_TAG
	if (!isInteractive || !prompt) {
		throw new Error(
			`A version tag is required for this function. Rerun with --tag ${suggestedVersionTag}`,
		)
	}

	const value = await prompt(suggestedVersionTag)
	if (value === null) throw new Error('VERSION_TAG_PROMPT_CANCELLED')
	const validation = validateVersionTag(value)
	if (!validation.ok) throw new Error(validation.message)
	return validation.versionTag
}

export type StructuredUploadError = {
	error?: string
	code?: string
	suggestedVersionTag?: string
}

export function formatUploadError(
	status: number,
	payload: StructuredUploadError | null,
): string {
	if (payload?.code === 'version_tag_required') {
		const suffix = payload.suggestedVersionTag
			? ` Rerun with --tag ${payload.suggestedVersionTag}.`
			: ' Rerun with --tag <tag>.'
		return `${payload.error ?? 'A version tag is required.'}${suffix}`
	}
	if (payload?.code === 'version_tag_conflict') {
		return `${payload.error ?? 'That version tag is already reserved.'} Choose a new immutable tag.`
	}
	if (payload?.code === 'invalid_version_tag') {
		return payload.error ?? 'The version tag is invalid.'
	}
	return payload?.error ?? `Upload failed with HTTP ${status}`
}

export function formatUploadSuccess(created: boolean): string {
	return created
		? 'Task uploaded successfully!'
		: 'Version already uploaded; using existing function ID.'
}
