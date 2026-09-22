import {
	type Address,
	concatHex,
	encodeAbiParameters,
	encodeFunctionData,
	getContractAddress,
	type Hex,
	keccak256,
	pad,
	parseAbi,
	toHex,
} from 'viem'

/**
 * The hard-coded template and pins behind `thyme verify roles-profile`.
 *
 * A Thyme-created ("sponsored") Roles profile Safe is a Safe 1.4.1 proxy whose
 * address is the CREATE2 of a fixed initializer:
 *
 *   setup([owner], 1, 0x0, 0x, CompatibilityFallbackHandler, 0x0, 0, 0x0)
 *
 * `Safe.setup` delegatecalls `to` with `data` as the newborn Safe, so an
 * initializer with a non-empty `to`/`data` can write ANY storage slot —
 * including planting an owner in the `owners` mapping that `getOwners()`,
 * `getThreshold()`, `getModulesPaginated()`, `VERSION()`, the singleton slot
 * and the proxy runtime hash are all blind to. The CREATE2 address is the only
 * complete commitment to the initializer, so the only pre-signature control
 * against a malicious or compromised service is to recompute that address
 * from these literals, on your own machine, and refuse to sign on a mismatch.
 *
 * Every value in this file is typed by hand. Nothing is read from a server,
 * nothing is imported from a private package, and nothing here is a
 * configuration knob. If a value is wrong the command refuses; it never falls
 * back to what the request says. The same literals exist in Thyme's backend
 * and in its web console; Thyme cross-checks the three copies on every change
 * and any drift is a security bug.
 */

/** The only chain these pins were verified on (Ethereum Sepolia). */
export const ROLES_CHAIN_ID = 11155111 as const

export const SAFE_VERSION = '1.4.1' as const

export const ZERO_ADDRESS: Address =
	'0x0000000000000000000000000000000000000000'

/**
 * Pinned contract addresses, all audited third-party deployments:
 * safe-global/safe-smart-account v1.4.1, safe-global/safe-modules
 * (safe-4337 0.3.0), gnosisguild/zodiac-modifier-roles v2.1.1 (the PATCHED
 * release; v2.1.0 at 0x9646fDAD… is vulnerable and never accepted) and
 * gnosisguild/zodiac ModuleProxyFactory 1.2.0.
 */
export const ROLES_PINS = {
	/** SafeProxyFactory 1.4.1 — creates every Safe in this design. */
	SAFE_PROXY_FACTORY: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
	/** SafeL2 1.4.1 — the singleton every proxy delegates to. */
	SAFE_L2_SINGLETON: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
	/** CompatibilityFallbackHandler 1.4.1 — the customer Safe's fallback handler. */
	SAFE_FALLBACK_HANDLER: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
	/** MultiSendCallOnly 1.4.1 — CALL only; the delegatecall MultiSend is never accepted. */
	MULTI_SEND_CALL_ONLY: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
	/** SafeModuleSetup 0.3.0 — the executor Safe's birth delegatecall target. */
	SAFE_MODULE_SETUP: '0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47',
	/** Safe4337Module 0.3.0 — the executor Safe's only module and fallback handler. */
	SAFE_4337_MODULE: '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226',
	/** Zodiac Roles Modifier v2.1.1 mastercopy. */
	ROLES_MASTERCOPY: '0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5',
	/** gnosisguild ModuleProxyFactory 1.2.0 — deploys the Roles proxy. */
	MODULE_PROXY_FACTORY: '0x000000000000aDdB49795b0f9bA5BC298cDda236',
	/**
	 * `keccak256(SafeProxyFactory.proxyCreationCode())`: the 486-byte SafeProxy
	 * 1.4.1 creation code. It is the one CREATE2 input this command cannot
	 * derive, so it is READ FROM THE CHAIN and accepted only when it hashes to
	 * this; a value supplied in a request file is never used.
	 */
	CANONICAL_PROXY_CREATION_CODE_HASH:
		'0x1856e0ee08399d74e0ea0b03adca210aeade6f748969ac023cdcb4dd62dcaf5f',
} as const satisfies Record<string, Hex>

/**
 * `keccak256` of the runtime bytecode deployed at each pinned address on
 * Sepolia. The post-hoc checks re-read every one with `eth_getCode` first: if
 * a pinned address does not hold the audited code, nothing derived from it
 * means anything.
 */
export const ROLES_STACK: readonly {
	name: string
	address: Address
	runtimeHash: Hex
}[] = [
	{
		name: 'SafeProxyFactory 1.4.1',
		address: ROLES_PINS.SAFE_PROXY_FACTORY,
		runtimeHash:
			'0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317',
	},
	{
		name: 'SafeL2 1.4.1',
		address: ROLES_PINS.SAFE_L2_SINGLETON,
		runtimeHash:
			'0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff',
	},
	{
		name: 'CompatibilityFallbackHandler 1.4.1',
		address: ROLES_PINS.SAFE_FALLBACK_HANDLER,
		runtimeHash:
			'0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9',
	},
	{
		name: 'MultiSendCallOnly 1.4.1',
		address: ROLES_PINS.MULTI_SEND_CALL_ONLY,
		runtimeHash:
			'0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939',
	},
	{
		name: 'SafeModuleSetup 0.3.0',
		address: ROLES_PINS.SAFE_MODULE_SETUP,
		runtimeHash:
			'0xaf2d170bb766d2773c3fa88717f5b3599827478074d3767d1dee55e5c2f3fbcb',
	},
	{
		name: 'Safe4337Module 0.3.0',
		address: ROLES_PINS.SAFE_4337_MODULE,
		runtimeHash:
			'0x2aea997c4e3cf0e2f333025372e219abcfde81c21fc2f8fb066414a5685dd3e0',
	},
	{
		name: 'Zodiac Roles 2.1.1',
		address: ROLES_PINS.ROLES_MASTERCOPY,
		runtimeHash:
			'0x471d8b3b419f1eb955230c0326c8812176df49bf3c7b414a563fda5a3c6c10b6',
	},
	{
		name: 'ModuleProxyFactory 1.2.0',
		address: ROLES_PINS.MODULE_PROXY_FACTORY,
		runtimeHash:
			'0x01623cbcf010a1c326230f1b2d5f48a66b440232ee49096102bc84967dc5f21e',
	},
]

/** `keccak256` of a deployed Safe 1.4.1 proxy's runtime bytecode. */
export const SAFE_PROXY_RUNTIME_HASH: Hex =
	'0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c'

/**
 * EIP-1167 minimal-proxy creation code the ModuleProxyFactory emits, split
 * around the mastercopy address, and the runtime it leaves behind (the
 * creation code without its `602d8060093d393df3` constructor).
 */
export const EIP1167_CREATION_PREFIX: Hex =
	'0x602d8060093d393df3363d3d373d3d3d363d73'
export const EIP1167_CREATION_SUFFIX: Hex = '0x5af43d82803e903d91602b57fd5bf3'
export const EIP1167_RUNTIME_PREFIX: Hex = '0x363d3d373d3d3d363d73'
export const EIP1167_RUNTIME_SUFFIX: Hex = '0x5af43d82803e903d91602b57fd5bf3'

/** Start of a Safe's module linked list. */
export const SAFE_MODULE_SENTINEL: Address =
	'0x0000000000000000000000000000000000000001'

/**
 * Safe 1.4.1 storage slots: slot 0 holds the singleton; the other two are the
 * hashed slots Safe's FallbackManager and GuardManager use. Derived, not typed.
 */
export const SAFE_SINGLETON_SLOT: Hex = toHex(0n, { size: 32 })
export const SAFE_FALLBACK_HANDLER_SLOT: Hex = keccak256(
	toHex('fallback_manager.handler.address'),
)
export const SAFE_GUARD_SLOT: Hex = keccak256(
	toHex('guard_manager.guard.address'),
)

/**
 * The customer Safe: sole owner, threshold 1, NO `to`, NO `data`, NO module.
 * Every field is part of the CREATE2 commitment; changing one changes the
 * address.
 */
export const CANONICAL_SAFE_TEMPLATE = {
	factory: ROLES_PINS.SAFE_PROXY_FACTORY,
	singleton: ROLES_PINS.SAFE_L2_SINGLETON,
	fallbackHandler: ROLES_PINS.SAFE_FALLBACK_HANDLER,
	threshold: 1n,
	/** No delegatecall at birth. */
	to: ZERO_ADDRESS,
	data: '0x',
	paymentToken: ZERO_ADDRESS,
	payment: 0n,
	paymentReceiver: ZERO_ADDRESS,
} as const

/**
 * Thyme's executor Safe — the only member of the role. Sole owner is the
 * profile's session key; Safe4337Module is its only module and its fallback
 * handler. Recomputed so the `assignRoles` member inside the signature is
 * provably a Safe of this shape and not an arbitrary address.
 */
export const CANONICAL_EXECUTOR_TEMPLATE = {
	factory: ROLES_PINS.SAFE_PROXY_FACTORY,
	singleton: ROLES_PINS.SAFE_L2_SINGLETON,
	threshold: 1n,
	/** `setup.to`: SafeModuleSetup, delegatecalled with `enableModules(modules)`. */
	moduleSetup: ROLES_PINS.SAFE_MODULE_SETUP,
	modules: [ROLES_PINS.SAFE_4337_MODULE],
	fallbackHandler: ROLES_PINS.SAFE_4337_MODULE,
	paymentToken: ZERO_ADDRESS,
	payment: 0n,
	paymentReceiver: ZERO_ADDRESS,
} as const

/** Safe 1.4.1 `setup`. */
export const safeSetupAbi = parseAbi([
	'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
])

/** SafeModuleSetup 0.3.0. */
const moduleSetupAbi = parseAbi(['function enableModules(address[] modules)'])

/** Zodiac Roles `setUp`. */
const rolesSetUpAbi = parseAbi(['function setUp(bytes initParams)'])

/** CREATE2 salt nonce of the customer Safe for a profile. */
export function customerSafeSaltNonce(profileId: string): bigint {
	return BigInt(keccak256(toHex(`thyme-roles-safe:${profileId}`)))
}

/** CREATE2 salt nonce of Thyme's executor Safe for a profile. */
export function executorSafeSaltNonce(profileId: string): bigint {
	return BigInt(keccak256(toHex(`thyme-lift-executor:${profileId}`)))
}

/** CREATE2 salt nonce of the Roles proxy for a profile. */
export function rolesSaltNonce(profileId: string): bigint {
	return BigInt(keccak256(toHex(`thyme-roles:${profileId}`)))
}

/** The Roles role key of a profile. */
export function roleKeyFor(profileId: string): Hex {
	return keccak256(toHex(`thyme-role:${profileId}`))
}

/** The literal `setup(...)` bytes of the customer Safe for `owner`. */
export function buildCanonicalSafeInitializer(owner: Address): Hex {
	return encodeFunctionData({
		abi: safeSetupAbi,
		functionName: 'setup',
		args: [
			[owner],
			CANONICAL_SAFE_TEMPLATE.threshold,
			CANONICAL_SAFE_TEMPLATE.to,
			CANONICAL_SAFE_TEMPLATE.data,
			CANONICAL_SAFE_TEMPLATE.fallbackHandler,
			CANONICAL_SAFE_TEMPLATE.paymentToken,
			CANONICAL_SAFE_TEMPLATE.payment,
			CANONICAL_SAFE_TEMPLATE.paymentReceiver,
		],
	})
}

/** The literal `setup(...)` bytes of Thyme's executor Safe for `sessionKey`. */
export function buildCanonicalExecutorInitializer(sessionKey: Address): Hex {
	return encodeFunctionData({
		abi: safeSetupAbi,
		functionName: 'setup',
		args: [
			[sessionKey],
			CANONICAL_EXECUTOR_TEMPLATE.threshold,
			CANONICAL_EXECUTOR_TEMPLATE.moduleSetup,
			encodeFunctionData({
				abi: moduleSetupAbi,
				functionName: 'enableModules',
				args: [[...CANONICAL_EXECUTOR_TEMPLATE.modules]],
			}),
			CANONICAL_EXECUTOR_TEMPLATE.fallbackHandler,
			CANONICAL_EXECUTOR_TEMPLATE.paymentToken,
			CANONICAL_EXECUTOR_TEMPLATE.payment,
			CANONICAL_EXECUTOR_TEMPLATE.paymentReceiver,
		],
	})
}

/**
 * `setUp(abi.encode(safe, safe, safe))`: owner = avatar = target = the
 * customer Safe, so only the Safe can rescope its own Roles module.
 */
export function buildRolesProxyInitializer(safe: Address): Hex {
	return encodeFunctionData({
		abi: rolesSetUpAbi,
		functionName: 'setUp',
		args: [
			encodeAbiParameters(
				[{ type: 'address' }, { type: 'address' }, { type: 'address' }],
				[safe, safe, safe],
			),
		],
	})
}

export function isCanonicalProxyCreationCode(proxyCreationCode: Hex): boolean {
	return (
		keccak256(proxyCreationCode) ===
		ROLES_PINS.CANONICAL_PROXY_CREATION_CODE_HASH
	)
}

/**
 * `SafeProxyFactory.createProxyWithNonce`: CREATE2 from the factory with
 * `salt = keccak256(keccak256(initializer) ++ uint256(saltNonce))` and
 * `bytecode = proxyCreationCode ++ abi.encode(singleton)`.
 */
function safeProxyCreate2Address({
	initializer,
	saltNonce,
	proxyCreationCode,
}: {
	initializer: Hex
	saltNonce: bigint
	proxyCreationCode: Hex
}): Address {
	return getContractAddress({
		opcode: 'CREATE2',
		from: ROLES_PINS.SAFE_PROXY_FACTORY,
		salt: keccak256(
			concatHex([keccak256(initializer), pad(toHex(saltNonce), { size: 32 })]),
		),
		bytecode: concatHex([
			proxyCreationCode,
			encodeAbiParameters(
				[{ type: 'uint256' }],
				[BigInt(ROLES_PINS.SAFE_L2_SINGLETON)],
			),
		]),
	})
}

/** The customer Safe's address from the canonical template. */
export function recomputeSafeAddress({
	owner,
	saltNonce,
	proxyCreationCode,
}: {
	owner: Address
	saltNonce: bigint
	proxyCreationCode: Hex
}): Address {
	return safeProxyCreate2Address({
		initializer: buildCanonicalSafeInitializer(owner),
		saltNonce,
		proxyCreationCode,
	})
}

/** Thyme's executor Safe address from the canonical executor template. */
export function recomputeExecutorSafeAddress({
	sessionKey,
	saltNonce,
	proxyCreationCode,
}: {
	sessionKey: Address
	saltNonce: bigint
	proxyCreationCode: Hex
}): Address {
	return safeProxyCreate2Address({
		initializer: buildCanonicalExecutorInitializer(sessionKey),
		saltNonce,
		proxyCreationCode,
	})
}

/** EIP-1167 proxy deployed by `ModuleProxyFactory.deployModule`. */
export function recomputeRolesProxyAddress({
	safe,
	saltNonce,
}: {
	safe: Address
	saltNonce: bigint
}): Address {
	const initializer = buildRolesProxyInitializer(safe)
	return getContractAddress({
		opcode: 'CREATE2',
		from: ROLES_PINS.MODULE_PROXY_FACTORY,
		salt: keccak256(
			concatHex([keccak256(initializer), pad(toHex(saltNonce), { size: 32 })]),
		),
		bytecode: concatHex([
			EIP1167_CREATION_PREFIX,
			ROLES_PINS.ROLES_MASTERCOPY.toLowerCase() as Hex,
			EIP1167_CREATION_SUFFIX,
		]),
	})
}

/** The runtime bytecode a genuine Roles proxy of the pinned mastercopy has. */
export function rolesProxyRuntimeCode(): Hex {
	return concatHex([
		EIP1167_RUNTIME_PREFIX,
		ROLES_PINS.ROLES_MASTERCOPY.toLowerCase() as Hex,
		EIP1167_RUNTIME_SUFFIX,
	])
}
