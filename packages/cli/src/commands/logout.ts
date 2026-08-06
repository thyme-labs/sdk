import {
	clearAuthToken,
	getAuthToken,
	getStoredCredentials,
	removeCredential,
} from '../utils/config'
import { error, intro, outro } from '../utils/ui'

interface LogoutOptions {
	management?: boolean
	workspace?: string
}

export async function logoutCommand(options: LogoutOptions = {}) {
	intro('Thyme CLI - Logout')
	if (options.management || options.workspace) {
		const credentials = getStoredCredentials().filter(
			(credential) => credential.kind === 'management',
		)
		const workspaceCount = new Set(
			credentials.map((credential) => credential.workspaceId),
		).size
		const matching = options.workspace
			? credentials.filter((item) => item.workspaceId === options.workspace)
			: workspaceCount <= 1
				? credentials
				: []
		const credential = matching.at(-1)

		if (!credential) {
			if (!options.workspace && credentials.length > 1) {
				error('Multiple management credentials exist; pass --workspace <id>.')
				process.exitCode = 1
				return
			}
			outro('No matching management credential is stored.')
			return
		}

		for (const item of matching) removeCredential(item.id)
		outro(
			`Removed local management access for ${credential.workspaceName ?? credential.workspaceId ?? 'the selected workspace'}.`,
		)
		return
	}

	if (!getAuthToken()) {
		outro('You are not logged in.')
		return
	}

	clearAuthToken()
	outro('Logged out successfully.')
}
