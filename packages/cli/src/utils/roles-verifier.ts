import {
	type Address,
	concatHex,
	decodeFunctionData,
	encodeFunctionData,
	encodePacked,
	getAddress,
	type Hex,
	hashTypedData,
	hexToBigInt,
	hexToNumber,
	isAddress,
	isHex,
	parseAbi,
	size,
	sliceHex,
} from 'viem'
import {
	buildCanonicalExecutorInitializer,
	buildCanonicalSafeInitializer,
	buildRolesProxyInitializer,
	customerSafeSaltNonce,
	executorSafeSaltNonce,
	isCanonicalProxyCreationCode,
	ROLES_CHAIN_ID,
	ROLES_PINS,
	recomputeExecutorSafeAddress,
	recomputeRolesProxyAddress,
	recomputeSafeAddress,
	roleKeyFor,
	rolesSaltNonce,
	ZERO_ADDRESS,
} from './roles-template'

/**
 * The pre-signature verifier: everything a wallet is about to sign for a
 * sponsored Roles profile, rebuilt from hard-coded constants, the owner
 * address, the profile id and the allowlist the customer typed, and compared
 * byte for byte with the request the service produced. `ok: false` means
 * DO NOT SIGN. There is no warning level and no fallback to a request value.
 *
 * Pure: no network. The caller reads `proxyCreationCode` and (when needed)
 * the live Safe nonce from the chain and passes them in.
 *
 * The only request fields that are ACCEPTED rather than recomputed are
 * `sessionKeyAddress` (Thyme's key; bound by recomputing the executor Safe
 * from it with the audited executor template) and the profile id, which the
 * caller supplies on the command line and every salt and the role key derive
 * from.
 */

export type VerifierMode =
	| { kind: 'setup'; ordering: 'sign_first' | 'deploy_first' }
	| { kind: 'scope_update' }
	| { kind: 'revocation' }

export type RolesScopeRule = { target: string; selector: string }

export type SponsoredRolesPolicy =
	| { mode: 'allow_all' }
	| { mode: 'allowlist'; rules: readonly RolesScopeRule[] }

/**
 * What the service hands back. Every field is INPUT to the verifier, never a
 * value it trusts.
 */
export type PreparedSponsoredSetup = {
	ownerAddress: string
	safeAddress: string
	sessionKeyAddress: string
	rolesProxyAddress: string
	executorSafeAddress: string
	roleKey: string
	/** The digest the service claims the wallet will sign. */
	setupDigest: string
	/** `JSON.stringify` of the EIP-712 typed data, bigints as decimal strings. */
	typedDataJson: string
	/** Required on creation payloads; optional (checked when present) otherwise. */
	customerSaltNonce?: string
	/** Required on creation payloads; optional (checked when present) otherwise. */
	customerSafeInitializer?: string
	/** Required for setup and scope updates; ignored for revocations. */
	scopeRules?: readonly RolesScopeRule[]
}

export type DecodedRolesCall = {
	to: Address
	functionName: RolesCallName
	args: readonly unknown[]
	data: Hex
}

export type SponsoredSetupVerdict =
	| {
			ok: true
			mode: VerifierMode
			ownerAddress: Address
			safeAddress: Address
			rolesProxyAddress: Address
			executorSafeAddress: Address
			sessionKeyAddress: Address
			roleKey: Hex
			customerSaltNonce: bigint
			rolesSaltNonce: bigint
			executorSaltNonce: bigint
			initializer: Hex
			rolesInitializer: Hex
			executorInitializer: Hex
			digest: Hex
			safeTx: { to: Address; operation: 0 | 1; nonce: bigint; data: Hex }
			calls: readonly DecodedRolesCall[]
	  }
	| {
			ok: false
			check: number
			reason: string
			expected?: string
			received?: string
	  }

/** Safe 1.4.1 SafeTx typed data. The domain carries ONLY chainId and verifyingContract. */
export const SAFE_TX_TYPES = {
	SafeTx: [
		{ name: 'to', type: 'address' },
		{ name: 'value', type: 'uint256' },
		{ name: 'data', type: 'bytes' },
		{ name: 'operation', type: 'uint8' },
		{ name: 'safeTxGas', type: 'uint256' },
		{ name: 'baseGas', type: 'uint256' },
		{ name: 'gasPrice', type: 'uint256' },
		{ name: 'gasToken', type: 'address' },
		{ name: 'refundReceiver', type: 'address' },
		{ name: 'nonce', type: 'uint256' },
	],
} as const

const EIP712_DOMAIN_TYPE = [
	{ name: 'chainId', type: 'uint256' },
	{ name: 'verifyingContract', type: 'address' },
] as const

export type SafeTxFields = {
	to: Address
	value: bigint
	data: Hex
	operation: 0 | 1
	safeTxGas: bigint
	baseGas: bigint
	gasPrice: bigint
	gasToken: Address
	refundReceiver: Address
	nonce: bigint
}

export function safeTxTypedData({
	safe,
	chainId,
	tx,
}: {
	safe: Address
	chainId: number
	tx: SafeTxFields
}) {
	return {
		domain: { chainId, verifyingContract: getAddress(safe) },
		types: SAFE_TX_TYPES,
		primaryType: 'SafeTx' as const,
		message: {
			to: tx.to,
			value: tx.value,
			data: tx.data,
			operation: tx.operation,
			safeTxGas: tx.safeTxGas,
			baseGas: tx.baseGas,
			gasPrice: tx.gasPrice,
			gasToken: tx.gasToken,
			refundReceiver: tx.refundReceiver,
			nonce: tx.nonce,
		},
	}
}

export function hashSafeTx(parameters: {
	safe: Address
	chainId: number
	tx: SafeTxFields
}): Hex {
	return hashTypedData(safeTxTypedData(parameters))
}

export type SafeCall = { to: Address; value: bigint; data: Hex }

/** MultiSend packing — CALL only, ever. */
export function packMultiSend(calls: readonly SafeCall[]): Hex {
	return concatHex(
		calls.map((call) =>
			encodePacked(
				['uint8', 'address', 'uint256', 'uint256', 'bytes'],
				[
					0,
					getAddress(call.to),
					call.value,
					BigInt(size(call.data)),
					call.data,
				],
			),
		),
	)
}

const multiSendAbi = parseAbi(['function multiSend(bytes transactions)'])

/**
 * Every inner call this verifier will accept. An unknown selector is fatal;
 * the allowed subset depends on the mode. `deployModule`, `setUp`,
 * `disableModule`, owner changes and everything else are absent on purpose.
 */
const rolesCallAbi = parseAbi([
	'function enableModule(address module)',
	'function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)',
	'function scopeTarget(bytes32 roleKey, address targetAddress)',
	'function allowFunction(bytes32 roleKey, address targetAddress, bytes4 selector, uint8 options)',
	'function revokeTarget(bytes32 roleKey, address targetAddress)',
	'function revokeFunction(bytes32 roleKey, address targetAddress, bytes4 selector)',
])

export type RolesCallName = (typeof rolesCallAbi)[number]['name']

/** Roles `ExecutionOptions.None`: no native value, no delegatecall. */
const EXECUTION_OPTIONS_NONE = 0

const MULTISEND_ENTRY_HEADER_BYTES = 1 + 20 + 32 + 32
const DECIMAL_UINT = /^(0|[1-9][0-9]*)$/
const HASH32 = /^0x[0-9a-f]{64}$/i
const SELECTOR = /^0x[0-9a-f]{8}$/i

class VerificationFailure extends Error {
	constructor(
		readonly check: number,
		reason: string,
		readonly expected?: string,
		readonly received?: string,
	) {
		super(reason)
	}
}

function fail(
	check: number,
	reason: string,
	expected?: string,
	received?: string,
): never {
	throw new VerificationFailure(check, reason, expected, received)
}

export function sameAddress(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase()
}

function sameHex(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A uint as the service serializes it (decimal string for bigints, plain
 * number for `operation` and `chainId`). Hex quantities, negatives, fractions
 * and anything non-canonical are refused.
 */
function asUint(value: unknown): bigint | undefined {
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value) || value < 0) return undefined
		return BigInt(value)
	}
	if (typeof value === 'string' && DECIMAL_UINT.test(value)) {
		return BigInt(value)
	}
	return undefined
}

function requireAddress(check: number, value: unknown, label: string): Address {
	if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
		fail(check, `${label} is not an address`, undefined, String(value))
	}
	return getAddress(value)
}

function requireHex(check: number, value: unknown, label: string): Hex {
	if (typeof value !== 'string' || !isHex(value, { strict: true })) {
		fail(check, `${label} is not hex`, undefined, String(value))
	}
	return value
}

function ruleKey(target: string, selector: string): string {
	return `${target.toLowerCase()}:${selector.toLowerCase()}`
}

/** Lower-cased, validated, deduplicated `target:selector` keys. */
function normalizeRules(
	check: number,
	rules: readonly RolesScopeRule[],
	label: string,
): Set<string> {
	const keys = new Set<string>()
	for (const rule of rules) {
		if (
			typeof rule?.target !== 'string' ||
			!isAddress(rule.target, { strict: false })
		) {
			fail(
				check,
				`${label}: target is not an address`,
				undefined,
				String(rule?.target),
			)
		}
		if (typeof rule.selector !== 'string' || !SELECTOR.test(rule.selector)) {
			fail(
				check,
				`${label}: selector is not 4 bytes`,
				undefined,
				String(rule.selector),
			)
		}
		keys.add(ruleKey(rule.target, rule.selector))
	}
	return keys
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
	if (left.size !== right.size) return false
	for (const key of left) if (!right.has(key)) return false
	return true
}

function describeSet(keys: Set<string>): string {
	return [...keys].sort().join(', ') || '(empty)'
}

function typedFieldsEqual(
	actual: unknown,
	expected: readonly { name: string; type: string }[],
): boolean {
	if (!Array.isArray(actual) || actual.length !== expected.length) return false
	return expected.every((field, index) => {
		const entry: unknown = actual[index]
		if (!isPlainObject(entry)) return false
		const keys = Object.keys(entry).sort()
		return (
			keys.length === 2 &&
			keys[0] === 'name' &&
			keys[1] === 'type' &&
			entry.name === field.name &&
			entry.type === field.type
		)
	})
}

type ParsedSafeTx = {
	typedData: unknown
	to: Address
	data: Hex
	operation: bigint
	nonce: bigint
}

/**
 * Check 7: the typed data's structure. Only the two-key Safe 1.4.1 domain,
 * only the ten-field SafeTx type (optionally the matching EIP712Domain type),
 * every gas field zero, no gas token, no refund receiver.
 */
function parseTypedData(
	json: string,
	chainId: number,
	safe: Address,
): ParsedSafeTx {
	let typedData: unknown
	try {
		typedData = JSON.parse(json)
	} catch {
		fail(7, 'typedDataJson is not valid JSON')
	}
	if (!isPlainObject(typedData)) fail(7, 'typedDataJson is not an object')

	const domain = typedData.domain
	if (!isPlainObject(domain)) fail(7, 'domain is missing')
	const domainKeys = Object.keys(domain).sort()
	if (domainKeys.join(',') !== 'chainId,verifyingContract') {
		fail(
			7,
			'domain must carry exactly chainId and verifyingContract (Safe 1.4.1 has no name or version)',
			'chainId,verifyingContract',
			domainKeys.join(','),
		)
	}
	if (chainId !== ROLES_CHAIN_ID) {
		fail(
			7,
			'sponsored Roles onboarding is pinned to Sepolia only',
			String(ROLES_CHAIN_ID),
			String(chainId),
		)
	}
	const domainChainId = asUint(domain.chainId)
	if (domainChainId === undefined || domainChainId !== BigInt(chainId)) {
		fail(7, 'domain.chainId differs', String(chainId), String(domain.chainId))
	}
	const verifyingContract = requireAddress(
		7,
		domain.verifyingContract,
		'domain.verifyingContract',
	)
	if (!sameAddress(verifyingContract, safe)) {
		fail(
			7,
			'domain.verifyingContract is not the recomputed Safe',
			safe,
			verifyingContract,
		)
	}

	if (typedData.primaryType !== 'SafeTx') {
		fail(
			7,
			'primaryType is not SafeTx',
			'SafeTx',
			String(typedData.primaryType),
		)
	}
	const types = typedData.types
	if (!isPlainObject(types)) fail(7, 'types is missing')
	for (const key of Object.keys(types)) {
		if (key !== 'SafeTx' && key !== 'EIP712Domain') {
			fail(7, 'types carries an unexpected type', 'SafeTx', key)
		}
	}
	if (!typedFieldsEqual(types.SafeTx, SAFE_TX_TYPES.SafeTx)) {
		fail(7, 'types.SafeTx is not the Safe 1.4.1 ten-field SafeTx type')
	}
	if (
		'EIP712Domain' in types &&
		!typedFieldsEqual(types.EIP712Domain, EIP712_DOMAIN_TYPE)
	) {
		fail(
			7,
			'types.EIP712Domain is not (uint256 chainId, address verifyingContract)',
		)
	}

	const message = typedData.message
	if (!isPlainObject(message)) fail(7, 'message is missing')
	const expectedKeys = SAFE_TX_TYPES.SafeTx.map((field) => field.name)
		.sort()
		.join(',')
	const messageKeys = Object.keys(message).sort().join(',')
	if (messageKeys !== expectedKeys) {
		fail(
			7,
			'message does not carry exactly the SafeTx fields',
			expectedKeys,
			messageKeys,
		)
	}
	for (const field of ['value', 'safeTxGas', 'baseGas', 'gasPrice'] as const) {
		if (asUint(message[field]) !== 0n) {
			fail(7, `message.${field} must be 0`, '0', String(message[field]))
		}
	}
	for (const field of ['gasToken', 'refundReceiver'] as const) {
		const address = requireAddress(7, message[field], `message.${field}`)
		if (!sameAddress(address, ZERO_ADDRESS)) {
			fail(
				7,
				`message.${field} must be the zero address`,
				ZERO_ADDRESS,
				address,
			)
		}
	}
	const operation = asUint(message.operation)
	if (operation === undefined || (operation !== 0n && operation !== 1n)) {
		fail(
			7,
			'message.operation must be 0 or 1',
			'0 | 1',
			String(message.operation),
		)
	}
	const nonce = asUint(message.nonce)
	if (nonce === undefined) {
		fail(7, 'message.nonce is not a uint', undefined, String(message.nonce))
	}
	return {
		typedData,
		to: requireAddress(7, message.to, 'message.to'),
		data: requireHex(7, message.data, 'message.data'),
		operation,
		nonce,
	}
}

/**
 * Check 10: the packed `(uint8 operation, address to, uint256 value,
 * uint256 length, bytes data)` entries, unpacked by hand. Every entry must be
 * a CALL with zero value, and the entries must consume the bytes exactly.
 */
function unpackMultiSend(packed: Hex): SafeCall[] {
	const total = size(packed)
	const calls: SafeCall[] = []
	let offset = 0
	while (offset < total) {
		if (total - offset < MULTISEND_ENTRY_HEADER_BYTES) {
			fail(10, 'multiSend batch has trailing bytes that are not a full entry')
		}
		const operation = hexToNumber(sliceHex(packed, offset, offset + 1))
		const to = getAddress(sliceHex(packed, offset + 1, offset + 21))
		const value = hexToBigInt(sliceHex(packed, offset + 21, offset + 53))
		const length = hexToBigInt(sliceHex(packed, offset + 53, offset + 85))
		const dataStart = offset + MULTISEND_ENTRY_HEADER_BYTES
		if (operation !== 0) {
			fail(
				10,
				`multiSend entry ${calls.length} is not a CALL (delegatecall inside the batch)`,
				'0',
				String(operation),
			)
		}
		if (value !== 0n) {
			fail(
				10,
				`multiSend entry ${calls.length} carries native value`,
				'0',
				value.toString(),
			)
		}
		if (length > BigInt(total - dataStart)) {
			fail(
				10,
				`multiSend entry ${calls.length} declares more data than the batch holds`,
			)
		}
		const dataEnd = dataStart + Number(length)
		const data = length === 0n ? '0x' : sliceHex(packed, dataStart, dataEnd)
		calls.push({ to, value, data })
		offset = dataEnd
	}
	if (offset !== total) fail(10, 'multiSend batch was not consumed exactly')
	if (calls.length === 0) fail(10, 'multiSend batch is empty')
	return calls
}

type Decoded = ReturnType<typeof decodeRolesCall>

function decodeRolesCall(data: Hex) {
	return decodeFunctionData({ abi: rolesCallAbi, data })
}

/**
 * Check 11: decode each inner call against the hard-coded fragments, prove
 * the bytes are the canonical encoding of what was decoded, and apply the
 * per-mode shape rules.
 */
function verifyCalls({
	mode,
	calls,
	safe,
	rolesProxy,
	executorSafe,
	roleKey,
}: {
	mode: VerifierMode
	calls: readonly SafeCall[]
	safe: Address
	rolesProxy: Address
	executorSafe: Address
	roleKey: Hex
}): {
	decoded: DecodedRolesCall[]
	allowed: { target: Address; selector: Hex; options: number }[]
	scoped: Set<string>
	revokedFunctions: Set<string>
	revokedTargets: Set<string>
} {
	const decoded: DecodedRolesCall[] = []
	const allowed: { target: Address; selector: Hex; options: number }[] = []
	const scoped = new Set<string>()
	const revokedFunctions = new Set<string>()
	const revokedTargets = new Set<string>()
	let enableModuleCount = 0
	let assignRolesCount = 0

	const requireRoleKey = (index: number, key: Hex) => {
		if (!sameHex(key, roleKey)) {
			fail(
				11,
				`call ${index} uses a role key other than this profile's`,
				roleKey,
				key,
			)
		}
	}
	const requireRolesProxy = (index: number, to: Address, name: string) => {
		if (!sameAddress(to, rolesProxy)) {
			fail(
				11,
				`call ${index} (${name}) is not sent to your Roles proxy`,
				rolesProxy,
				to,
			)
		}
	}
	const refuse = (index: number, name: string): never =>
		fail(11, `call ${index} (${name}) is not allowed in ${mode.kind} mode`)

	for (const [index, call] of calls.entries()) {
		let parsed: Decoded
		try {
			parsed = decodeRolesCall(call.data)
		} catch {
			fail(
				11,
				`call ${index} has an unknown selector`,
				'enableModule | assignRoles | scopeTarget | allowFunction | revokeTarget | revokeFunction',
				size(call.data) >= 4 ? sliceHex(call.data, 0, 4) : call.data,
			)
		}
		const canonical = encodeFunctionData({
			abi: rolesCallAbi,
			functionName: parsed.functionName,
			args: parsed.args,
		} as Parameters<typeof encodeFunctionData>[0])
		if (!sameHex(canonical, call.data)) {
			fail(
				11,
				`call ${index} (${parsed.functionName}) is not the canonical encoding of its arguments`,
			)
		}

		switch (parsed.functionName) {
			case 'enableModule': {
				if (mode.kind !== 'setup') refuse(index, parsed.functionName)
				if (!sameAddress(call.to, safe)) {
					fail(
						11,
						`call ${index} (enableModule) is not sent to your Safe`,
						safe,
						call.to,
					)
				}
				const [module] = parsed.args
				if (!sameAddress(module, rolesProxy)) {
					fail(
						11,
						`call ${index} enables a module other than your Roles proxy`,
						rolesProxy,
						module,
					)
				}
				enableModuleCount += 1
				break
			}
			case 'assignRoles': {
				if (mode.kind === 'scope_update') refuse(index, parsed.functionName)
				requireRolesProxy(index, call.to, parsed.functionName)
				const [member, keys, memberOf] = parsed.args
				if (!sameAddress(member, executorSafe)) {
					fail(
						11,
						`call ${index} assigns the role to an address other than the recomputed executor Safe`,
						executorSafe,
						member,
					)
				}
				const [onlyKey] = keys
				const [onlyMembership] = memberOf
				if (
					keys.length !== 1 ||
					memberOf.length !== 1 ||
					onlyKey === undefined ||
					onlyMembership === undefined
				) {
					fail(11, `call ${index} (assignRoles) must name exactly one role`)
				}
				requireRoleKey(index, onlyKey)
				const expectedMembership = mode.kind === 'setup'
				if (onlyMembership !== expectedMembership) {
					fail(
						11,
						`call ${index} (assignRoles) membership flag is wrong`,
						String(expectedMembership),
						String(onlyMembership),
					)
				}
				assignRolesCount += 1
				break
			}
			case 'scopeTarget': {
				if (mode.kind === 'revocation') refuse(index, parsed.functionName)
				requireRolesProxy(index, call.to, parsed.functionName)
				const [key, target] = parsed.args
				requireRoleKey(index, key)
				scoped.add(target.toLowerCase())
				break
			}
			case 'allowFunction': {
				if (mode.kind === 'revocation') refuse(index, parsed.functionName)
				requireRolesProxy(index, call.to, parsed.functionName)
				const [key, target, selector, options] = parsed.args
				requireRoleKey(index, key)
				allowed.push({ target, selector, options })
				break
			}
			case 'revokeTarget': {
				if (mode.kind === 'setup') refuse(index, parsed.functionName)
				requireRolesProxy(index, call.to, parsed.functionName)
				const [key, target] = parsed.args
				requireRoleKey(index, key)
				revokedTargets.add(target.toLowerCase())
				break
			}
			case 'revokeFunction': {
				if (mode.kind === 'setup') refuse(index, parsed.functionName)
				requireRolesProxy(index, call.to, parsed.functionName)
				const [key, target, selector] = parsed.args
				requireRoleKey(index, key)
				revokedFunctions.add(ruleKey(target, selector))
				break
			}
			default: {
				const unreachable: never = parsed
				fail(
					11,
					`call ${index} decoded to an unexpected function`,
					undefined,
					String(unreachable),
				)
			}
		}
		decoded.push({
			to: call.to,
			functionName: parsed.functionName,
			args: parsed.args,
			data: canonical,
		})
	}

	if (mode.kind === 'setup' && enableModuleCount !== 1) {
		fail(
			11,
			'setup must enable your Roles proxy exactly once',
			'1',
			String(enableModuleCount),
		)
	}
	if (mode.kind !== 'scope_update' && assignRolesCount !== 1) {
		fail(
			11,
			`${mode.kind} must contain exactly one assignRoles`,
			'1',
			String(assignRolesCount),
		)
	}
	return { decoded, allowed, scoped, revokedFunctions, revokedTargets }
}

function targetsOf(keys: Set<string>): Set<string> {
	const targets = new Set<string>()
	for (const key of keys) targets.add(key.slice(0, key.indexOf(':')))
	return targets
}

function missingFrom(required: Set<string>, present: Set<string>): string[] {
	return [...required].filter((key) => !present.has(key)).sort()
}

/**
 * The second half of check 12, for the two modes in which the batch takes
 * permission AWAY: every rule known to be live that is not in the new
 * allowlist must be revoked EXPLICITLY inside the signed batch. Roles v2
 * keeps per-function scope entries until `revokeFunction` deletes them and
 * has no per-function getter, so no post-hoc read can catch an omission;
 * this pre-sign check is the only control. Superset semantics: the service
 * may revoke more (rules it remembers that the customer cannot see).
 */
function verifyRevocations({
	previousRules,
	typed,
	revokedFunctions,
	revokedTargets,
}: {
	previousRules: readonly RolesScopeRule[]
	typed: Set<string>
	revokedFunctions: Set<string>
	revokedTargets: Set<string>
}): void {
	const previous = normalizeRules(12, previousRules, 'the current allowlist')
	const dropped = new Set([...previous].filter((key) => !typed.has(key)))
	const missingFunctions = missingFrom(dropped, revokedFunctions)
	if (missingFunctions.length > 0) {
		fail(
			12,
			`the signature request does not revoke ${missingFunctions.length} function(s) you are removing, so Thyme would keep them: ${missingFunctions.join(', ')}`,
			describeSet(dropped),
			describeSet(revokedFunctions),
		)
	}
	const typedTargets = targetsOf(typed)
	const droppedTargets = new Set(
		[...targetsOf(previous)].filter((target) => !typedTargets.has(target)),
	)
	const missingTargets = missingFrom(droppedTargets, revokedTargets)
	if (missingTargets.length > 0) {
		fail(
			12,
			`the signature request does not revoke ${missingTargets.length} contract(s) you are removing, so they would stay scoped: ${missingTargets.join(', ')}`,
			describeSet(droppedTargets),
			describeSet(revokedTargets),
		)
	}
}

/**
 * Check 12: the allowlist inside the signature is the one you typed — as a
 * set, so ordering never matters — and equals the service's own
 * `scopeRules`; every scoped target is allowed something; every
 * `allowFunction` carries `ExecutionOptions.None`. Revocations must allow
 * nothing. Scope updates must also revoke, explicitly, every rule of
 * `previousRules` the new allowlist drops (`verifyRevocations`), so
 * `previousRules` is REQUIRED and non-empty in `scope_update` mode.
 */
function verifyPolicy({
	mode,
	policy,
	previousRules,
	scopeRules,
	allowed,
	scoped,
	revokedFunctions,
	revokedTargets,
}: {
	mode: VerifierMode
	policy: SponsoredRolesPolicy
	previousRules: readonly RolesScopeRule[] | undefined
	scopeRules: PreparedSponsoredSetup['scopeRules']
	allowed: readonly { target: Address; selector: Hex; options: number }[]
	scoped: Set<string>
	revokedFunctions: Set<string>
	revokedTargets: Set<string>
}): void {
	for (const entry of allowed) {
		if (entry.options !== EXECUTION_OPTIONS_NONE) {
			fail(
				12,
				`allowFunction for ${entry.target} ${entry.selector} is not ExecutionOptions.None`,
				'0',
				String(entry.options),
			)
		}
	}
	const allowedSet = new Set(
		allowed.map((entry) => ruleKey(entry.target, entry.selector)),
	)
	if (mode.kind === 'revocation') {
		if (allowedSet.size !== 0 || scoped.size !== 0) {
			fail(12, 'a revocation must not allow or scope anything')
		}
		if (previousRules !== undefined) {
			verifyRevocations({
				previousRules,
				typed: new Set(),
				revokedFunctions,
				revokedTargets,
			})
		}
		return
	}
	if (policy.mode !== 'allowlist') {
		fail(
			12,
			'Roles profiles need an explicit allowlist',
			'allowlist',
			policy.mode,
		)
	}
	if (policy.rules.length === 0) {
		fail(12, 'the allowlist you typed is empty')
	}
	const typed = normalizeRules(12, policy.rules, 'your allowlist')
	if (!sameSet(allowedSet, typed)) {
		fail(
			12,
			'the allowlist inside the signature request differs from the one you typed',
			describeSet(typed),
			describeSet(allowedSet),
		)
	}
	if (!scopeRules)
		fail(12, 'the request carries no scopeRules to compare against')
	const server = normalizeRules(12, scopeRules, 'request scopeRules')
	if (!sameSet(allowedSet, server)) {
		fail(
			12,
			"the request's scopeRules differ from the calls it asks you to sign",
			describeSet(server),
			describeSet(allowedSet),
		)
	}
	const allowedTargets = new Set(
		allowed.map((entry) => entry.target.toLowerCase()),
	)
	for (const target of scoped) {
		if (!allowedTargets.has(target)) {
			fail(
				12,
				'a scopeTarget names a contract with no allowed function',
				undefined,
				target,
			)
		}
	}
	if (mode.kind === 'scope_update') {
		if (previousRules === undefined) {
			fail(
				12,
				'the current allowlist was not supplied (--previous-allowlist), so the functions you are removing cannot be checked for explicit revocation',
			)
		}
		if (previousRules.length === 0) {
			fail(
				12,
				'the current allowlist is empty; a Roles profile being updated always has one',
			)
		}
		verifyRevocations({
			previousRules,
			typed,
			revokedFunctions,
			revokedTargets,
		})
	}
}

/**
 * Rebuilds, from hard-coded constants, the owner address, the profile id and
 * the allowlist the customer typed, everything the wallet is about to sign,
 * and compares it byte for byte with what the service sent. Fourteen numbered
 * checks (0-13), every failure fatal, one verdict.
 */
export function verifySponsoredSetup(input: {
	mode: VerifierMode
	/** The wallet that will sign — from the command line, never the request. */
	connectedAddress: string | undefined
	chainId: number
	profileId: string
	/** The allowlist the customer typed. */
	policy: SponsoredRolesPolicy
	/** The rules live on chain BEFORE this batch; required for scope updates. */
	previousRules?: readonly RolesScopeRule[]
	/** `SafeProxyFactory.proxyCreationCode()` read from the chain. */
	proxyCreationCode: Hex
	/** `safe.nonce()` read from the chain; unused for sign-first setup. */
	liveNonce?: bigint
	prepared: PreparedSponsoredSetup
}): SponsoredSetupVerdict {
	const { mode, prepared, profileId } = input
	const creation = mode.kind === 'setup'
	let check = 0
	try {
		// 0. The wallet that signs is the wallet the Safe is for.
		if (
			input.connectedAddress === undefined ||
			!isAddress(input.connectedAddress, { strict: false })
		) {
			fail(0, 'no owner address was supplied')
		}
		const owner = getAddress(input.connectedAddress)
		const claimedOwner = requireAddress(
			0,
			prepared.ownerAddress,
			'ownerAddress',
		)
		if (!sameAddress(owner, claimedOwner)) {
			fail(
				0,
				'the owner you named is not the owner this Safe is being built for',
				claimedOwner,
				owner,
			)
		}

		// 1. The one CREATE2 input that cannot be derived is pinned by hash.
		check = 1
		const proxyCreationCode = requireHex(
			1,
			input.proxyCreationCode,
			'proxyCreationCode',
		)
		if (!isCanonicalProxyCreationCode(proxyCreationCode)) {
			fail(
				1,
				'proxyCreationCode does not hash to the pinned SafeProxy 1.4.1 creation code',
				ROLES_PINS.CANONICAL_PROXY_CREATION_CODE_HASH,
			)
		}

		// 2. The salt derives from the profile id.
		check = 2
		if (typeof profileId !== 'string' || profileId.length === 0) {
			fail(2, 'profile id is empty')
		}
		const saltNonce = customerSafeSaltNonce(profileId)
		if (prepared.customerSaltNonce === undefined) {
			if (creation) fail(2, 'the request carries no customerSaltNonce')
		} else {
			if (!DECIMAL_UINT.test(prepared.customerSaltNonce)) {
				fail(
					2,
					'customerSaltNonce is not a decimal uint',
					saltNonce.toString(),
					prepared.customerSaltNonce,
				)
			}
			if (BigInt(prepared.customerSaltNonce) !== saltNonce) {
				fail(
					2,
					'customerSaltNonce does not derive from this profile id',
					saltNonce.toString(),
					prepared.customerSaltNonce,
				)
			}
		}

		// 3. The literal initializer is the canonical template for the OWNER.
		check = 3
		const initializer = buildCanonicalSafeInitializer(owner)
		if (prepared.customerSafeInitializer === undefined) {
			if (creation) fail(3, 'the request carries no customerSafeInitializer')
		} else {
			const claimed = requireHex(
				3,
				prepared.customerSafeInitializer,
				'customerSafeInitializer',
			)
			if (!sameHex(claimed, initializer)) {
				fail(
					3,
					'customerSafeInitializer is not the canonical setup([you], 1, 0x0, 0x, handler, 0x0, 0, 0x0)',
					initializer,
					claimed,
				)
			}
		}

		// 4. The Safe address is the CREATE2 of that initializer.
		check = 4
		const safe = recomputeSafeAddress({ owner, saltNonce, proxyCreationCode })
		const claimedSafe = requireAddress(4, prepared.safeAddress, 'safeAddress')
		if (!sameAddress(safe, claimedSafe)) {
			fail(
				4,
				'safeAddress is not the CREATE2 address of the canonical initializer',
				safe,
				claimedSafe,
			)
		}
		if (sameAddress(safe, ZERO_ADDRESS) || sameAddress(safe, owner)) {
			fail(4, 'recomputed Safe address is degenerate', undefined, safe)
		}

		// 5. The Roles proxy and role key derive from the Safe and the profile id.
		check = 5
		const rolesSalt = rolesSaltNonce(profileId)
		const rolesProxy = recomputeRolesProxyAddress({
			safe,
			saltNonce: rolesSalt,
		})
		const claimedProxy = requireAddress(
			5,
			prepared.rolesProxyAddress,
			'rolesProxyAddress',
		)
		if (!sameAddress(rolesProxy, claimedProxy)) {
			fail(
				5,
				'rolesProxyAddress is not the Roles proxy bound to your Safe',
				rolesProxy,
				claimedProxy,
			)
		}
		const roleKey = roleKeyFor(profileId)
		if (
			typeof prepared.roleKey !== 'string' ||
			!HASH32.test(prepared.roleKey)
		) {
			fail(5, 'roleKey is not 32 bytes', roleKey, String(prepared.roleKey))
		}
		if (!sameHex(prepared.roleKey, roleKey)) {
			fail(
				5,
				'roleKey does not derive from this profile id',
				roleKey,
				prepared.roleKey,
			)
		}

		// 6. The role member is a Safe of the audited executor shape.
		check = 6
		const sessionKey = requireAddress(
			6,
			prepared.sessionKeyAddress,
			'sessionKeyAddress',
		)
		const executorSalt = executorSafeSaltNonce(profileId)
		const executorSafe = recomputeExecutorSafeAddress({
			sessionKey,
			saltNonce: executorSalt,
			proxyCreationCode,
		})
		const claimedExecutor = requireAddress(
			6,
			prepared.executorSafeAddress,
			'executorSafeAddress',
		)
		if (!sameAddress(executorSafe, claimedExecutor)) {
			fail(
				6,
				'executorSafeAddress is not the executor Safe derived from the session key',
				executorSafe,
				claimedExecutor,
			)
		}

		// 7. The typed data's structure.
		check = 7
		const parsed = parseTypedData(prepared.typedDataJson, input.chainId, safe)

		// 8. The outer shape: MultiSendCallOnly + delegatecall, or a single CALL to the Roles proxy.
		check = 8
		const isBatch = sameAddress(parsed.to, ROLES_PINS.MULTI_SEND_CALL_ONLY)
		const isSingle = !creation && sameAddress(parsed.to, rolesProxy)
		if (isBatch) {
			if (parsed.operation !== 1n) {
				fail(
					8,
					'a MultiSendCallOnly batch must use operation 1',
					'1',
					parsed.operation.toString(),
				)
			}
		} else if (isSingle) {
			if (parsed.operation !== 0n) {
				fail(
					8,
					'a direct call to your Roles proxy must use operation 0',
					'0',
					parsed.operation.toString(),
				)
			}
		} else {
			fail(
				8,
				creation
					? 'message.to is not the pinned MultiSendCallOnly'
					: 'message.to is neither the pinned MultiSendCallOnly nor your Roles proxy',
				creation
					? ROLES_PINS.MULTI_SEND_CALL_ONLY
					: `${ROLES_PINS.MULTI_SEND_CALL_ONLY} | ${rolesProxy}`,
				parsed.to,
			)
		}

		// 9. The nonce.
		check = 9
		if (mode.kind === 'setup' && mode.ordering === 'sign_first') {
			if (parsed.nonce !== 0n) {
				fail(
					9,
					"a sign-first setup must be the Safe's nonce-0 transaction",
					'0',
					parsed.nonce.toString(),
				)
			}
		} else {
			if (input.liveNonce === undefined) {
				fail(9, 'the live Safe nonce was not read from the chain')
			}
			if (parsed.nonce !== input.liveNonce) {
				fail(
					9,
					"message.nonce differs from the Safe's live nonce",
					input.liveNonce.toString(),
					parsed.nonce.toString(),
				)
			}
		}

		// 10. The inner calls.
		check = 10
		let calls: SafeCall[]
		if (isBatch) {
			let packed: Hex
			try {
				const outer = decodeFunctionData({
					abi: multiSendAbi,
					data: parsed.data,
				})
				;[packed] = outer.args
			} catch {
				fail(10, 'message.data is not multiSend(bytes)')
			}
			const canonicalOuter = encodeFunctionData({
				abi: multiSendAbi,
				functionName: 'multiSend',
				args: [packed],
			})
			if (!sameHex(canonicalOuter, parsed.data)) {
				fail(10, 'message.data is not the canonical multiSend encoding')
			}
			calls = unpackMultiSend(packed)
		} else {
			calls = [{ to: rolesProxy, value: 0n, data: parsed.data }]
		}

		// 11. Every call is one of the allowed shapes and nothing else.
		check = 11
		const { decoded, allowed, scoped, revokedFunctions, revokedTargets } =
			verifyCalls({
				mode,
				calls,
				safe,
				rolesProxy,
				executorSafe,
				roleKey,
			})

		// 12. The policy is the one you typed, and (scope updates) every rule
		//     it drops is revoked explicitly inside the batch.
		check = 12
		verifyPolicy({
			mode,
			policy: input.policy,
			previousRules: input.previousRules,
			scopeRules: prepared.scopeRules,
			allowed,
			scoped,
			revokedFunctions,
			revokedTargets,
		})

		// 13. The digest: re-pack in the request's order and hash it ourselves.
		check = 13
		const canonicalCalls: SafeCall[] = decoded.map((call) => ({
			to: call.to,
			value: 0n,
			data: call.data,
		}))
		const [singleCall] = canonicalCalls
		if (singleCall === undefined) fail(13, 'no inner call was decoded')
		const tx: SafeTxFields = {
			to: isBatch ? ROLES_PINS.MULTI_SEND_CALL_ONLY : rolesProxy,
			value: 0n,
			data: isBatch
				? encodeFunctionData({
						abi: multiSendAbi,
						functionName: 'multiSend',
						args: [packMultiSend(canonicalCalls)],
					})
				: singleCall.data,
			operation: isBatch ? 1 : 0,
			safeTxGas: 0n,
			baseGas: 0n,
			gasPrice: 0n,
			gasToken: ZERO_ADDRESS,
			refundReceiver: ZERO_ADDRESS,
			nonce: parsed.nonce,
		}
		const digest = hashSafeTx({ safe, chainId: input.chainId, tx })
		if (
			typeof prepared.setupDigest !== 'string' ||
			!HASH32.test(prepared.setupDigest)
		) {
			fail(
				13,
				'setupDigest is not 32 bytes',
				digest,
				String(prepared.setupDigest),
			)
		}
		if (!sameHex(digest, prepared.setupDigest)) {
			fail(
				13,
				'the digest the request claims differs from the one rebuilt here',
				digest,
				prepared.setupDigest,
			)
		}
		let serverDigest: Hex
		try {
			serverDigest = hashTypedData(
				parsed.typedData as Parameters<typeof hashTypedData>[0],
			)
		} catch (error) {
			fail(
				13,
				`the request's typed data cannot be hashed: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		if (!sameHex(digest, serverDigest)) {
			fail(
				13,
				"hashing the request's typed data as sent does not give the rebuilt digest",
				digest,
				serverDigest,
			)
		}

		return {
			ok: true,
			mode,
			ownerAddress: owner,
			safeAddress: safe,
			rolesProxyAddress: rolesProxy,
			executorSafeAddress: executorSafe,
			sessionKeyAddress: sessionKey,
			roleKey,
			customerSaltNonce: saltNonce,
			rolesSaltNonce: rolesSalt,
			executorSaltNonce: executorSalt,
			initializer,
			rolesInitializer: buildRolesProxyInitializer(safe),
			executorInitializer: buildCanonicalExecutorInitializer(sessionKey),
			digest,
			safeTx: {
				to: tx.to,
				operation: tx.operation,
				nonce: tx.nonce,
				data: tx.data,
			},
			calls: decoded,
		}
	} catch (error) {
		if (error instanceof VerificationFailure) {
			return {
				ok: false,
				check: error.check,
				reason: error.message,
				...(error.expected === undefined ? {} : { expected: error.expected }),
				...(error.received === undefined ? {} : { received: error.received }),
			}
		}
		return {
			ok: false,
			check,
			reason: error instanceof Error ? error.message : String(error),
		}
	}
}
