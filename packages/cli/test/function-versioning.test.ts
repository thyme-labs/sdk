import { describe, expect, test } from 'bun:test'
import {
	formatUploadError,
	formatUploadSuccess,
	normalizeVersionTag,
	resolveUploadVersionTag,
	validateVersionTag,
} from '../src/utils/function-versioning'

describe('function version tags', () => {
	test('normalizes and validates the backend contract', () => {
		expect(normalizeVersionTag(' V1.1.0 ')).toBe('v1.1.0')
		for (const tag of ['v2', 'v1.1.0', 'beta', 'hotfix-3']) {
			expect(validateVersionTag(tag)).toEqual({ ok: true, versionTag: tag })
		}
		for (const tag of ['', '-v1', 'two words', 'latest', 'a'.repeat(33)]) {
			expect(validateVersionTag(tag).ok).toBe(false)
		}
	})

	test('defaults a new family to v1 and accepts --tag', async () => {
		expect(
			await resolveUploadVersionTag({
				familyExists: false,
				suggestedVersionTag: 'v1',
				isInteractive: false,
			}),
		).toBe('v1')
		expect(
			await resolveUploadVersionTag({
				providedTag: ' BETA ',
				familyExists: true,
				suggestedVersionTag: 'v2',
				isInteractive: false,
			}),
		).toBe('beta')
	})

	test('prompts for an existing family with the API suggestion', async () => {
		let suggested = ''
		const versionTag = await resolveUploadVersionTag({
			familyExists: true,
			suggestedVersionTag: 'v3',
			isInteractive: true,
			prompt: async (value) => {
				suggested = value
				return 'HOTFIX-3'
			},
		})
		expect(suggested).toBe('v3')
		expect(versionTag).toBe('hotfix-3')
	})

	test('gives an actionable non-interactive error', async () => {
		expect(
			resolveUploadVersionTag({
				familyExists: true,
				suggestedVersionTag: 'v2',
				isInteractive: false,
			}),
		).rejects.toThrow('Rerun with --tag v2')
	})

	test('formats conflicts and idempotency-facing API errors', () => {
		expect(
			formatUploadError(409, {
				code: 'version_tag_conflict',
				error: 'Tag beta conflicts',
			}),
		).toContain('Choose a new immutable tag')
		expect(
			formatUploadError(409, {
				code: 'version_tag_required',
				suggestedVersionTag: 'v4',
			}),
		).toContain('--tag v4')
		expect(formatUploadSuccess(true)).toBe('Task uploaded successfully!')
		expect(formatUploadSuccess(false)).toBe(
			'Version already uploaded; using existing function ID.',
		)
	})
})
