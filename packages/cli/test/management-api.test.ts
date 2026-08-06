import { describe, expect, test } from 'bun:test'
import type { StoredCredential } from '../src/utils/config'
import {
	buildManagementApiUrl,
	selectManagementCredential,
} from '../src/utils/management-api'

function credential(
	id: string,
	workspaceId: string,
	kind: 'standard' | 'management' = 'management',
): StoredCredential {
	return {
		id,
		workspaceId,
		kind,
		keyPrefix: id,
		token: `token-${id}`,
		scopes: [],
	}
}

describe('management API credential selection', () => {
	test('selects the credential bound to an explicit workspace', () => {
		expect(
			selectManagementCredential(
				[credential('a', 'workspace-a'), credential('b', 'workspace-b')],
				'workspace-b',
			)?.id,
		).toBe('b')
	})

	test('uses a sole management credential and ignores standard credentials', () => {
		expect(
			selectManagementCredential([
				credential('standard', 'workspace-a', 'standard'),
				credential('management', 'workspace-b'),
			])?.id,
		).toBe('management')
	})

	test('requires an explicit workspace when several management keys exist', () => {
		expect(() =>
			selectManagementCredential([
				credential('a', 'workspace-a'),
				credential('b', 'workspace-b'),
			]),
		).toThrow('pass --workspace')
	})

	test('uses the newest duplicate credential for one workspace', () => {
		expect(
			selectManagementCredential([
				credential('old', 'workspace-a'),
				credential('new', 'workspace-a'),
			])?.id,
		).toBe('new')
	})
})

describe('management API URL construction', () => {
	test('preserves the configured Convex HTTP base path', () => {
		expect(
			buildManagementApiUrl(
				'https://functions.example/http/',
				'/api/v1/projects?limit=5',
			),
		).toBe('https://functions.example/http/api/v1/projects?limit=5')
	})

	test('rejects absolute raw API targets', () => {
		expect(() =>
			buildManagementApiUrl(
				'https://functions.example/http',
				'https://evil.test',
			),
		).toThrow('must be relative')
	})

	test('rejects non-management and traversal targets', () => {
		expect(() =>
			buildManagementApiUrl(
				'https://functions.example/http',
				'/api/auth/verify',
			),
		).toThrow('versioned management route')
		expect(() =>
			buildManagementApiUrl(
				'https://functions.example/http',
				'/api/v1/../auth/verify',
			),
		).toThrow('versioned management route')
	})
})
