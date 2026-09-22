import type { Address, Hex } from 'viem'
import {
	getAddress,
	isAddress,
	parseAbiItem,
	toFunctionSelector,
	toFunctionSignature,
} from 'viem'

/**
 * Local copy of the `functions/<task>/permissions.json` rules.
 *
 * The Thyme backend owns the authoritative validator and re-validates every
 * upload. This copy exists so `thyme upload` and `thyme run` fail early with a
 * readable message. Keep it in step with the backend rules:
 *
 * - The file is at most 16 KiB and must parse as JSON.
 * - The top level is an object with exactly one key, `calls`, an array.
 *   Unknown keys anywhere are errors.
 * - Each call is an object with exactly `target` and `function`.
 * - `target` is either `{ "arg": "<name>" }` with a name matching
 *   `^[A-Za-z_][A-Za-z0-9_]*$`, or an object mapping decimal chain ids to
 *   contract addresses with at least one entry.
 * - `function` is a signature `name(type,...)` or a 4-byte selector `0x` + 8
 *   hex characters. A selector-less entry is an error.
 * - At most 50 calls after de-duplication by `(target, selector)`. An empty
 *   `calls` array is valid and declares that the task makes no calls.
 */

export const PERMISSIONS_FILE_NAME = 'permissions.json'
export const PERMISSIONS_MAX_BYTES = 16 * 1024
export const PERMISSIONS_MAX_CALLS = 50

const ARG_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SELECTOR_PATTERN = /^0x[0-9a-fA-F]{8}$/
const CHAIN_ID_PATTERN = /^[1-9][0-9]*$/
const SIGNATURE_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*\(.*\)$/

export type PermissionTarget =
	| { kind: 'fixed'; byChain: Record<string, Address> }
	| { kind: 'arg'; name: string }

export interface PermissionCall {
	target: PermissionTarget
	/** Lowercase 4-byte selector, `0x` + 8 hex. */
	selector: Hex
	/** Normalized signature, present when the file named the function by signature. */
	signature?: string
}

export interface PermissionsManifest {
	version: 1
	calls: PermissionCall[]
}

export type PermissionsParseResult =
	| { ok: true; manifest: PermissionsManifest }
	| { ok: false; errors: string[] }

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	)
}

function unknownKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): string[] {
	return Object.keys(value).filter((key) => !allowed.includes(key))
}

function parseTarget(
	raw: unknown,
	at: string,
	errors: string[],
): PermissionTarget | null {
	if (!isPlainObject(raw)) {
		errors.push(
			`${at}.target must be an object: { "arg": "<name>" } or { "<chainId>": "<address>" }`,
		)
		return null
	}

	if ('arg' in raw) {
		const extra = unknownKeys(raw, ['arg'])
		if (extra.length > 0) {
			errors.push(
				`${at}.target has unknown keys next to "arg": ${extra.join(', ')}`,
			)
			return null
		}
		const name = raw.arg
		if (typeof name !== 'string' || !ARG_NAME_PATTERN.test(name)) {
			errors.push(
				`${at}.target.arg must be a top-level argument name matching ${ARG_NAME_PATTERN.source}`,
			)
			return null
		}
		return { kind: 'arg', name }
	}

	const entries = Object.entries(raw)
	if (entries.length === 0) {
		errors.push(
			`${at}.target must map at least one chain id to an address, or be { "arg": "<name>" }`,
		)
		return null
	}

	const byChain: Record<string, Address> = {}
	let valid = true
	for (const [chainId, address] of entries) {
		if (
			!CHAIN_ID_PATTERN.test(chainId) ||
			!Number.isSafeInteger(Number(chainId))
		) {
			errors.push(
				`${at}.target has an invalid chain id "${chainId}": use a positive decimal integer`,
			)
			valid = false
			continue
		}
		if (typeof address !== 'string' || !isAddress(address)) {
			errors.push(
				`${at}.target["${chainId}"] must be a contract address (a mixed-case address must carry a valid checksum)`,
			)
			valid = false
			continue
		}
		byChain[chainId] = getAddress(address)
	}
	return valid ? { kind: 'fixed', byChain } : null
}

function parseFunction(
	raw: unknown,
	at: string,
	errors: string[],
): { selector: Hex; signature?: string } | null {
	if (typeof raw !== 'string' || raw.length === 0) {
		errors.push(
			`${at}.function is required: a signature such as "approve(address,uint256)" or a selector such as "0x095ea7b3". A call without a selector cannot be granted.`,
		)
		return null
	}

	if (SELECTOR_PATTERN.test(raw)) {
		return { selector: raw.toLowerCase() as Hex }
	}

	if (raw.startsWith('0x')) {
		errors.push(
			`${at}.function "${raw}" is not a 4-byte selector: use 0x followed by exactly 8 hex characters`,
		)
		return null
	}

	if (!SIGNATURE_PATTERN.test(raw)) {
		errors.push(
			`${at}.function "${raw}" must be a signature name(type,...) or a 4-byte selector`,
		)
		return null
	}

	try {
		const item = parseAbiItem(`function ${raw}`)
		if (item.type !== 'function') throw new Error('not a function')
		return {
			selector: toFunctionSelector(item).toLowerCase() as Hex,
			signature: toFunctionSignature(item),
		}
	} catch {
		errors.push(
			`${at}.function "${raw}" is not a valid function signature, for example "approve(address,uint256)"`,
		)
		return null
	}
}

/**
 * Stable key for a target, used to sort and de-duplicate calls.
 */
export function permissionTargetKey(target: PermissionTarget): string {
	if (target.kind === 'arg') return `arg:${target.name}`
	return `fixed:${Object.keys(target.byChain)
		.sort((a, b) => Number(a) - Number(b))
		.map((chainId) => `${chainId}=${target.byChain[chainId]?.toLowerCase()}`)
		.join(',')}`
}

function compareStrings(a: string, b: string): number {
	if (a < b) return -1
	if (a > b) return 1
	return 0
}

/**
 * Validate the raw text of a `permissions.json` and return its canonical form:
 * addresses checksummed, selectors lowercase, calls sorted and de-duplicated
 * by `(target, selector)`.
 *
 * Every problem is reported; nothing invalid is silently dropped.
 */
export function parsePermissionsManifest(text: string): PermissionsParseResult {
	const size = new TextEncoder().encode(text).length
	if (size > PERMISSIONS_MAX_BYTES) {
		return {
			ok: false,
			errors: [
				`${PERMISSIONS_FILE_NAME} is ${size} bytes (max: ${PERMISSIONS_MAX_BYTES})`,
			],
		}
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch (err) {
		return {
			ok: false,
			errors: [
				`${PERMISSIONS_FILE_NAME} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
			],
		}
	}

	if (!isPlainObject(parsed)) {
		return {
			ok: false,
			errors: [
				`${PERMISSIONS_FILE_NAME} must be an object: { "calls": [...] }`,
			],
		}
	}

	const errors: string[] = []
	const extra = unknownKeys(parsed, ['calls'])
	if (extra.length > 0) {
		errors.push(`Unknown top-level keys: ${extra.join(', ')}`)
	}
	if (!Array.isArray(parsed.calls)) {
		errors.push(
			'"calls" is required and must be an array ([] declares no calls)',
		)
		return { ok: false, errors }
	}

	const byKey = new Map<string, PermissionCall>()
	parsed.calls.forEach((rawCall, index) => {
		const at = `calls[${index}]`
		if (!isPlainObject(rawCall)) {
			errors.push(`${at} must be an object with "target" and "function"`)
			return
		}
		const extraCallKeys = unknownKeys(rawCall, ['target', 'function'])
		if (extraCallKeys.length > 0) {
			errors.push(`${at} has unknown keys: ${extraCallKeys.join(', ')}`)
		}
		if (!('target' in rawCall)) {
			errors.push(`${at}.target is required`)
		}
		const target =
			'target' in rawCall ? parseTarget(rawCall.target, at, errors) : null
		const fn = parseFunction(rawCall.function, at, errors)
		if (!target || !fn) return

		const key = `${permissionTargetKey(target)}|${fn.selector}`
		const existing = byKey.get(key)
		// Keep the first entry, but prefer one that carries a signature label.
		if (!existing || (!existing.signature && fn.signature)) {
			byKey.set(key, {
				target,
				selector: fn.selector,
				...(fn.signature ? { signature: fn.signature } : {}),
			})
		}
	})

	if (errors.length > 0) return { ok: false, errors }

	if (byKey.size > PERMISSIONS_MAX_CALLS) {
		return {
			ok: false,
			errors: [
				`${PERMISSIONS_FILE_NAME} declares ${byKey.size} distinct calls (max: ${PERMISSIONS_MAX_CALLS})`,
			],
		}
	}

	const calls = [...byKey.values()].sort(
		(a, b) =>
			compareStrings(
				permissionTargetKey(a.target),
				permissionTargetKey(b.target),
			) || compareStrings(a.selector, b.selector),
	)

	return { ok: true, manifest: { version: 1, calls } }
}

export type PermissionsResolveResult =
	| { ok: true; allowed: Set<string> }
	| { ok: false; reasons: string[] }

/**
 * Key for an allowed `(target, selector)` pair: `lower(target):lower(selector)`.
 */
export function permissionPairKey(target: string, selector: string): string {
	return `${target.toLowerCase()}:${selector.toLowerCase()}`
}

/**
 * Resolve a manifest against a chain and the task's args into the set of
 * allowed pairs. Any target that cannot be resolved is reported; the caller
 * must treat an unresolved manifest as not covering anything.
 */
export function resolvePermissions(
	manifest: PermissionsManifest,
	chainId: number | undefined,
	args: unknown,
): PermissionsResolveResult {
	const allowed = new Set<string>()
	const reasons: string[] = []
	const argsObject = isPlainObject(args) ? args : {}

	for (const call of manifest.calls) {
		if (call.target.kind === 'fixed') {
			if (chainId === undefined) {
				reasons.push(
					'the chain id is unknown, so fixed targets cannot be resolved (set RPC_URL)',
				)
				continue
			}
			const address = call.target.byChain[String(chainId)]
			if (!address) {
				reasons.push(
					`a call to ${call.signature ?? call.selector} declares no address for chain ${chainId}`,
				)
				continue
			}
			allowed.add(permissionPairKey(address, call.selector))
			continue
		}

		const value = Object.hasOwn(argsObject, call.target.name)
			? argsObject[call.target.name]
			: undefined
		if (typeof value !== 'string' || !isAddress(value)) {
			reasons.push(
				`argument \`${call.target.name}\` must be a contract address`,
			)
			continue
		}
		allowed.add(permissionPairKey(value, call.selector))
	}

	if (reasons.length > 0) return { ok: false, reasons: [...new Set(reasons)] }
	return { ok: true, allowed }
}

/**
 * The `(to, first 4 bytes of data)` key of a returned call, or null when the
 * call carries no selector.
 */
export function callPairKey(call: { to: string; data: string }): string | null {
	if (!/^0x[0-9a-fA-F]{8}/.test(call.data)) return null
	return permissionPairKey(call.to, call.data.slice(0, 10))
}
