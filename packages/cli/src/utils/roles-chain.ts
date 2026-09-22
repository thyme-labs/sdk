import {
	type Address,
	getAddress,
	type Hex,
	keccak256,
	type PublicClient,
	parseAbi,
	parseAbiItem,
	parseEventLogs,
	toEventSelector,
} from 'viem'
import {
	executorSafeSaltNonce,
	isCanonicalProxyCreationCode,
	ROLES_PINS,
	ROLES_STACK,
	recomputeExecutorSafeAddress,
	rolesProxyRuntimeCode,
	SAFE_FALLBACK_HANDLER_SLOT,
	SAFE_GUARD_SLOT,
	SAFE_MODULE_SENTINEL,
	SAFE_PROXY_RUNTIME_HASH,
	SAFE_SINGLETON_SLOT,
	SAFE_VERSION,
	ZERO_ADDRESS,
} from './roles-template'
import { sameAddress } from './roles-verifier'

/**
 * Post-hoc verification of a Thyme-created Roles profile, read from the chain
 * through whatever RPC the caller points at. Nothing here trusts a value the
 * service produced: the Safe and Roles proxy addresses are recomputed by the
 * caller from the template, and every row below compares a chain read with a
 * pinned constant or with an address the caller derived.
 *
 * On logs: the Safe proxy runtime and the singleton are pinned, but a Safe
 * DELEGATECALLs whatever an owner's `execTransaction(operation = 1)` or a
 * module names, and that code runs AS the Safe — its `LOG` opcodes carry the
 * Safe's address. Any event read from the Safe can therefore be forged by
 * anyone holding owner or module power over it, including a hidden owner
 * planted at birth. The birth record is never identified by "the newest
 * log": `findSafeSetup` requires the log's transaction to be the one that
 * created the proxy (see `proveBirthLog`).
 */

/**
 * Emitted by the Safe itself at the end of `setup()`; `initializer` is the
 * `to` the birth delegatecall ran against, so `0x0` proves no delegatecall
 * happened at birth. Signature from Safe 1.4.1 `Safe.sol`.
 */
export const SAFE_SETUP_EVENT = parseAbiItem(
	'event SafeSetup(address indexed initiator, address[] owners, uint256 threshold, address initializer, address fallbackHandler)',
)

/**
 * Emitted by the Safe on every successful `execTransaction` with the SafeTx
 * hash INDEXED — byte for byte the digest the owner signed. Safe 1.3.0 emits
 * the same topic with the hash un-indexed; that layout never matches here.
 */
export const EXECUTION_SUCCESS_EVENT = parseAbiItem(
	'event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)',
)

/**
 * Emitted by the SafeProxyFactory — from the FACTORY's address — once the
 * proxy exists and `setup()` has returned. Only the factory's code can emit
 * from the factory's address, and CREATE2 succeeds at an address once, so
 * exactly one `ProxyCreation(proxy = safe)` exists for a Safe and it sits in
 * the transaction that created it.
 */
export const PROXY_CREATION_EVENT = parseAbiItem(
	'event ProxyCreation(address indexed proxy, address singleton)',
)

/** Zodiac Roles v2: emitted on every `assignRoles`; none of its fields is indexed. */
export const ASSIGN_ROLES_EVENT = parseAbiItem(
	'event AssignRoles(address module, bytes32[] roleKeys, bool[] memberOf)',
)

const SAFE_SETUP_TOPIC = toEventSelector(SAFE_SETUP_EVENT).toLowerCase()

/** Many RPCs cap `eth_getLogs` ranges; 2,000 blocks is widely accepted. */
export const DEFAULT_LOG_SCAN_CHUNK_BLOCKS = 2_000n

const safeReadAbi = parseAbi([
	'function VERSION() view returns (string)',
	'function getOwners() view returns (address[])',
	'function getThreshold() view returns (uint256)',
	'function nonce() view returns (uint256)',
	'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
])

const rolesReadAbi = parseAbi([
	'function owner() view returns (address)',
	'function avatar() view returns (address)',
	'function target() view returns (address)',
	'function isModuleEnabled(address module) view returns (bool)',
])

const safeProxyFactoryAbi = parseAbi([
	'function proxyCreationCode() pure returns (bytes)',
])

const MODULE_PAGE_SIZE = 10n

export type CheckStatus = 'pass' | 'fail' | 'skipped'

export type CheckRow = {
	id: string
	label: string
	status: CheckStatus
	/** The raw value read from the chain, or the reason it could not be. */
	value: string
	expected?: string
}

export type ScanWindow = {
	fromBlock: bigint
	toBlock: bigint
	chunkBlocks: bigint
}

/**
 * `SafeProxyFactory.proxyCreationCode()` read from the chain and accepted only
 * when it hashes to the pin. Throws otherwise: nothing can be derived from an
 * unknown creation code.
 */
export async function readPinnedProxyCreationCode(
	client: PublicClient,
): Promise<Hex> {
	const code = await client.readContract({
		address: ROLES_PINS.SAFE_PROXY_FACTORY,
		abi: safeProxyFactoryAbi,
		functionName: 'proxyCreationCode',
	})
	if (!isCanonicalProxyCreationCode(code)) {
		throw new Error(
			`SafeProxyFactory.proxyCreationCode() on this chain hashes to ${keccak256(code)}, not the pinned ${ROLES_PINS.CANONICAL_PROXY_CREATION_CODE_HASH}; this is not the audited Safe 1.4.1 factory`,
		)
	}
	return code
}

/** `safe.nonce()`; throws when the Safe has no code. */
export async function readSafeNonce(
	client: PublicClient,
	safe: Address,
): Promise<bigint> {
	const code = await client.getCode({ address: safe })
	if (!code || code === '0x') {
		throw new Error(
			`${safe} has no code on this chain, so its nonce cannot be read; a deploy-first, scope-update or revocation request needs a deployed Safe`,
		)
	}
	return client.readContract({
		address: safe,
		abi: safeReadAbi,
		functionName: 'nonce',
	})
}

/**
 * Newest-first over fixed-size chunks between `fromBlock` and `toBlock`.
 * Returns the newest match or `null` once the whole window is covered.
 */
async function scanLogs<T>(
	window: ScanWindow,
	fetch: (range: { fromBlock: bigint; toBlock: bigint }) => Promise<T[]>,
): Promise<T | null> {
	let toBlock = window.toBlock
	while (toBlock >= window.fromBlock) {
		const lower = toBlock - (window.chunkBlocks - 1n)
		const chunkFrom = lower > window.fromBlock ? lower : window.fromBlock
		const matches = await fetch({ fromBlock: chunkFrom, toBlock })
		const newest = matches[matches.length - 1]
		if (newest !== undefined) return newest
		toBlock = chunkFrom - 1n
	}
	return null
}

/** Oldest-first over the whole window, collecting every match. */
async function collectLogs<T>(
	window: ScanWindow,
	fetch: (range: { fromBlock: bigint; toBlock: bigint }) => Promise<T[]>,
): Promise<T[]> {
	const all: T[] = []
	let fromBlock = window.fromBlock
	while (fromBlock <= window.toBlock) {
		const upper = fromBlock + (window.chunkBlocks - 1n)
		const chunkTo = upper < window.toBlock ? upper : window.toBlock
		all.push(...(await fetch({ fromBlock, toBlock: chunkTo })))
		fromBlock = chunkTo + 1n
	}
	return all
}

export type SafeSetupLog = {
	initiator: Address
	owners: readonly Address[]
	threshold: bigint
	initializer: Address
	fallbackHandler: Address
	transactionHash: Hex
	blockNumber: bigint
	logIndex: number
}

export type SafeSetupLookup =
	| { status: 'absent' }
	| { status: 'canonical'; log: SafeSetupLog }
	| {
			status: 'not_canonical'
			transactionHash: Hex
			blockNumber: bigint
			reason: string
	  }

/**
 * Proves that `log` is the Safe's birth log or explains why it is not: the
 * transaction holding it must carry `ProxyCreation(proxy = safe)` from the
 * pinned factory and exactly one `SafeSetup` from the Safe, with the
 * factory's log AFTER the Safe's (the factory emits only once `setup()` has
 * returned). A forged log fails the first test; a forgery emitted by the
 * birth initializer itself fails the second. `SafeSetup` logs are counted by
 * raw topic so a malformed forgery still counts.
 */
async function proveBirthLog(
	client: PublicClient,
	safe: Address,
	log: { transactionHash: Hex; blockHash: Hex; logIndex: number },
): Promise<string | null> {
	const receipt = await client.getTransactionReceipt({
		hash: log.transactionHash,
	})
	if (receipt.blockHash.toLowerCase() !== log.blockHash.toLowerCase()) {
		throw new Error(
			`Transaction ${log.transactionHash} moved between blocks while its receipt was read (chain reorganisation); retry`,
		)
	}
	const setupLogs = receipt.logs.filter(
		(entry) =>
			sameAddress(entry.address, safe) &&
			entry.topics[0]?.toLowerCase() === SAFE_SETUP_TOPIC,
	)
	const [onlySetup] = setupLogs
	if (setupLogs.length !== 1 || onlySetup === undefined) {
		return `the Safe emitted ${setupLogs.length} SafeSetup logs in transaction ${log.transactionHash}; a genuine Safe emits exactly one, so code the Safe delegatecalled has run as the Safe — do not fund it`
	}
	const creations = parseEventLogs({
		abi: [PROXY_CREATION_EVENT],
		logs: receipt.logs,
		strict: true,
	}).filter(
		(entry) =>
			sameAddress(entry.address, ROLES_PINS.SAFE_PROXY_FACTORY) &&
			sameAddress(entry.args.proxy, safe),
	)
	const [creation] = creations
	if (creations.length !== 1 || creation === undefined) {
		return `the newest SafeSetup log of ${safe} (transaction ${log.transactionHash}) is not in the transaction that created the Safe through the SafeProxyFactory ${ROLES_PINS.SAFE_PROXY_FACTORY}; it was emitted by code the Safe delegatecalled — do not fund it`
	}
	if (creation.logIndex <= onlySetup.logIndex) {
		return `the SafeSetup log of ${safe} (transaction ${log.transactionHash}, log ${onlySetup.logIndex}) was emitted after the SafeProxyFactory's ProxyCreation (log ${creation.logIndex}), which the genuine setup() cannot do — do not fund it`
	}
	return null
}

/** The Safe's genuine `SafeSetup` log, proven to be the birth log. */
export async function findSafeSetup(
	client: PublicClient,
	safe: Address,
	window: ScanWindow,
): Promise<SafeSetupLookup> {
	const log = await scanLogs(window, async ({ fromBlock, toBlock }) => {
		const logs = await client.getLogs({
			address: safe,
			event: SAFE_SETUP_EVENT,
			fromBlock,
			toBlock,
			strict: true,
		})
		return logs.filter((entry) => !entry.removed)
	})
	if (!log) return { status: 'absent' }
	const reason = await proveBirthLog(client, safe, log)
	if (reason) {
		return {
			status: 'not_canonical',
			transactionHash: log.transactionHash,
			blockNumber: log.blockNumber,
			reason,
		}
	}
	return {
		status: 'canonical',
		log: {
			initiator: getAddress(log.args.initiator),
			owners: log.args.owners.map((owner) => getAddress(owner)),
			threshold: log.args.threshold,
			initializer: getAddress(log.args.initializer),
			fallbackHandler: getAddress(log.args.fallbackHandler),
			transactionHash: log.transactionHash,
			blockNumber: log.blockNumber,
			logIndex: log.logIndex,
		},
	}
}

export type ExecutionSuccessLog = {
	digest: Hex
	transactionHash: Hex
	blockNumber: bigint
}

/** The Safe's `ExecutionSuccess` log for one digest, or `null`. */
export async function findExecutionSuccess(
	client: PublicClient,
	parameters: { safe: Address; digest: Hex },
	window: ScanWindow,
): Promise<ExecutionSuccessLog | null> {
	// Topic filters go to the node byte for byte and viem re-filters `args`
	// case-sensitively, so the filter is always the lower-case form.
	const digest = parameters.digest.toLowerCase() as Hex
	const log = await scanLogs(window, async ({ fromBlock, toBlock }) => {
		const logs = await client.getLogs({
			address: parameters.safe,
			event: EXECUTION_SUCCESS_EVENT,
			args: { txHash: digest },
			fromBlock,
			toBlock,
			strict: true,
		})
		return logs.filter(
			(entry) => !entry.removed && entry.args.txHash.toLowerCase() === digest,
		)
	})
	if (!log) return null
	return {
		digest: log.args.txHash,
		transactionHash: log.transactionHash,
		blockNumber: log.blockNumber,
	}
}

/** Every `ExecutionSuccess` the Safe emitted in the window, oldest first. */
export async function listExecutionSuccess(
	client: PublicClient,
	safe: Address,
	window: ScanWindow,
): Promise<ExecutionSuccessLog[]> {
	const logs = await collectLogs(window, async ({ fromBlock, toBlock }) => {
		const entries = await client.getLogs({
			address: safe,
			event: EXECUTION_SUCCESS_EVENT,
			fromBlock,
			toBlock,
			strict: true,
		})
		return entries.filter((entry) => !entry.removed)
	})
	return logs.map((log) => ({
		digest: log.args.txHash,
		transactionHash: log.transactionHash,
		blockNumber: log.blockNumber,
	}))
}

/**
 * The addresses currently assigned to `roleKey` on the Roles proxy, replayed
 * from every `AssignRoles` log in the window in chain order. Roles v2 has no
 * member enumeration, and `isModuleEnabled` stays true after a role is
 * removed, so the logs are the only source.
 */
export async function findRoleMembers(
	client: PublicClient,
	parameters: { rolesProxy: Address; roleKey: Hex },
	window: ScanWindow,
): Promise<Address[]> {
	const roleKey = parameters.roleKey.toLowerCase()
	const logs = await collectLogs(window, async ({ fromBlock, toBlock }) => {
		const entries = await client.getLogs({
			address: parameters.rolesProxy,
			event: ASSIGN_ROLES_EVENT,
			fromBlock,
			toBlock,
			strict: true,
		})
		return entries.filter((entry) => !entry.removed)
	})
	logs.sort((left, right) => {
		if (left.blockNumber !== right.blockNumber) {
			return left.blockNumber < right.blockNumber ? -1 : 1
		}
		return left.logIndex - right.logIndex
	})
	const members = new Map<string, Address>()
	for (const log of logs) {
		const module = getAddress(log.args.module)
		for (const [index, key] of log.args.roleKeys.entries()) {
			if (key.toLowerCase() !== roleKey) continue
			if (log.args.memberOf[index] === true) {
				members.set(module.toLowerCase(), module)
			} else {
				members.delete(module.toLowerCase())
			}
		}
	}
	return [...members.values()]
}

function slotAddress(word: Hex | undefined): Address | undefined {
	if (!word) return undefined
	const padded = word.slice(2).padStart(64, '0')
	if (!/^0{24}[0-9a-fA-F]{40}$/.test(padded)) return undefined
	return getAddress(`0x${padded.slice(24)}`)
}

function describeAddresses(addresses: readonly Address[]): string {
	return `[${addresses.join(', ')}]`
}

type RowRead = () => Promise<Omit<CheckRow, 'id' | 'label'>>

async function attempt(
	id: string,
	label: string,
	read: RowRead,
): Promise<CheckRow> {
	try {
		return { id, label, ...(await read()) }
	} catch (error) {
		return {
			id,
			label,
			status: 'fail',
			value: `could not read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
		}
	}
}

/** Every pinned address must hold the audited runtime before anything else means anything. */
export async function verifyStackPins(client: PublicClient): Promise<CheckRow> {
	return attempt(
		'stack',
		'pinned contracts hold the audited runtime',
		async () => {
			const mismatches: string[] = []
			for (const entry of ROLES_STACK) {
				const code = await client.getCode({ address: entry.address })
				const hash = code ? keccak256(code) : '(no code)'
				if (hash !== entry.runtimeHash) {
					mismatches.push(`${entry.name} at ${entry.address}: ${hash}`)
				}
			}
			return mismatches.length === 0
				? {
						status: 'pass',
						value: `${ROLES_STACK.length} contracts match their pinned keccak256`,
					}
				: {
						status: 'fail',
						value: mismatches.join('; '),
						expected: ROLES_STACK.map(
							(entry) => `${entry.name}: ${entry.runtimeHash}`,
						).join('; '),
					}
		},
	)
}

export type PostHocInput = {
	safe: Address
	owner: Address
	rolesProxy: Address
	roleKey: Hex
	profileId: string
	proxyCreationCode: Hex
	/** Expect an `ExecutionSuccess` log carrying this digest. */
	digest?: Hex
	window: ScanWindow
}

export type PostHocResult = {
	rows: CheckRow[]
	safeSetup: SafeSetupLookup
	executionSuccess: ExecutionSuccessLog | null
	roleMembers: Address[]
}

/**
 * The ten checks the Thyme console shows after activation, read here through
 * the caller's RPC and compared against the caller's own derivations, plus
 * the executor-Safe derivation from the Roles proxy's own logs.
 */
export async function runPostHocChecks(
	client: PublicClient,
	input: PostHocInput,
): Promise<PostHocResult> {
	const { safe, owner, rolesProxy, roleKey, window } = input
	const rows: CheckRow[] = []

	rows.push(
		await attempt('1', 'getOwners() == [owner]', async () => {
			const owners = await client.readContract({
				address: safe,
				abi: safeReadAbi,
				functionName: 'getOwners',
			})
			const [only] = owners
			const ok =
				owners.length === 1 && only !== undefined && sameAddress(only, owner)
			return {
				status: ok ? 'pass' : 'fail',
				value: describeAddresses(owners),
				expected: describeAddresses([owner]),
			}
		}),
	)
	rows.push(
		await attempt('2', 'getThreshold() == 1', async () => {
			const threshold = await client.readContract({
				address: safe,
				abi: safeReadAbi,
				functionName: 'getThreshold',
			})
			return {
				status: threshold === 1n ? 'pass' : 'fail',
				value: threshold.toString(),
				expected: '1',
			}
		}),
	)
	rows.push(
		await attempt('3', `VERSION() == '${SAFE_VERSION}'`, async () => {
			const version = await client.readContract({
				address: safe,
				abi: safeReadAbi,
				functionName: 'VERSION',
			})
			return {
				status: version === SAFE_VERSION ? 'pass' : 'fail',
				value: version,
				expected: SAFE_VERSION,
			}
		}),
	)
	rows.push(
		await attempt('4', 'exactly one module: the Roles proxy', async () => {
			const [modules, next] = await client.readContract({
				address: safe,
				abi: safeReadAbi,
				functionName: 'getModulesPaginated',
				args: [SAFE_MODULE_SENTINEL, MODULE_PAGE_SIZE],
			})
			const [only] = modules
			const ok =
				modules.length === 1 &&
				only !== undefined &&
				sameAddress(only, rolesProxy) &&
				sameAddress(next, SAFE_MODULE_SENTINEL)
			return {
				status: ok ? 'pass' : 'fail',
				value: `${describeAddresses(modules)} next ${next}`,
				expected: `${describeAddresses([rolesProxy])} next ${SAFE_MODULE_SENTINEL}`,
			}
		}),
	)
	rows.push(
		await attempt(
			'5',
			'Safe proxy runtime and singleton are the pinned 1.4.1',
			async () => {
				const [code, singletonWord] = await Promise.all([
					client.getCode({ address: safe }),
					client.getStorageAt({ address: safe, slot: SAFE_SINGLETON_SLOT }),
				])
				const codeHash = code && code !== '0x' ? keccak256(code) : undefined
				const singleton = slotAddress(singletonWord)
				const ok =
					codeHash === SAFE_PROXY_RUNTIME_HASH &&
					singleton !== undefined &&
					sameAddress(singleton, ROLES_PINS.SAFE_L2_SINGLETON)
				return {
					status: ok ? 'pass' : 'fail',
					value: `code ${codeHash ?? '(none)'}; singleton ${singleton ?? singletonWord ?? '(none)'}`,
					expected: `code ${SAFE_PROXY_RUNTIME_HASH}; singleton ${ROLES_PINS.SAFE_L2_SINGLETON}`,
				}
			},
		),
	)
	rows.push(
		await attempt('6', 'fallback handler pinned, guard empty', async () => {
			const [handlerWord, guardWord] = await Promise.all([
				client.getStorageAt({
					address: safe,
					slot: SAFE_FALLBACK_HANDLER_SLOT,
				}),
				client.getStorageAt({ address: safe, slot: SAFE_GUARD_SLOT }),
			])
			const handler = slotAddress(handlerWord)
			const guard = slotAddress(guardWord)
			const ok =
				handler !== undefined &&
				sameAddress(handler, ROLES_PINS.SAFE_FALLBACK_HANDLER) &&
				guard !== undefined &&
				sameAddress(guard, ZERO_ADDRESS)
			return {
				status: ok ? 'pass' : 'fail',
				value: `handler ${handler ?? handlerWord ?? '(none)'}; guard ${guard ?? guardWord ?? '(none)'}`,
				expected: `handler ${ROLES_PINS.SAFE_FALLBACK_HANDLER}; guard ${ZERO_ADDRESS}`,
			}
		}),
	)
	rows.push(
		await attempt(
			'7',
			'Roles proxy is an EIP-1167 proxy of Roles v2.1.1',
			async () => {
				const code = await client.getCode({ address: rolesProxy })
				const expected = rolesProxyRuntimeCode()
				const ok = (code ?? '0x').toLowerCase() === expected.toLowerCase()
				return {
					status: ok ? 'pass' : 'fail',
					value: code && code !== '0x' ? code : '(no code)',
					expected,
				}
			},
		),
	)
	rows.push(
		await attempt(
			'8',
			'Roles owner == avatar == target == the Safe',
			async () => {
				const [rolesOwner, avatar, target] = await Promise.all([
					client.readContract({
						address: rolesProxy,
						abi: rolesReadAbi,
						functionName: 'owner',
					}),
					client.readContract({
						address: rolesProxy,
						abi: rolesReadAbi,
						functionName: 'avatar',
					}),
					client.readContract({
						address: rolesProxy,
						abi: rolesReadAbi,
						functionName: 'target',
					}),
				])
				const ok =
					sameAddress(rolesOwner, safe) &&
					sameAddress(avatar, safe) &&
					sameAddress(target, safe)
				return {
					status: ok ? 'pass' : 'fail',
					value: `owner ${rolesOwner}; avatar ${avatar}; target ${target}`,
					expected: safe,
				}
			},
		),
	)

	// 9. The birth log, proven to be the birth log.
	let safeSetup: SafeSetupLookup
	try {
		safeSetup = await findSafeSetup(client, safe, window)
	} catch (error) {
		safeSetup = { status: 'absent' }
		rows.push({
			id: '9',
			label: 'SafeSetup log: canonical birth',
			status: 'fail',
			value: `could not scan: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
		})
	}
	if (rows.length === 8) {
		rows.push(describeSafeSetup(safeSetup, owner, window))
	}
	const birthBlock =
		safeSetup.status === 'canonical' ? safeSetup.log.blockNumber : undefined
	const sinceBirth: ScanWindow = {
		...window,
		fromBlock: birthBlock ?? window.fromBlock,
	}

	// 10. The ExecutionSuccess log for the digest, when one was given.
	let executionSuccess: ExecutionSuccessLog | null = null
	if (input.digest === undefined) {
		rows.push(
			await attempt(
				'10',
				'ExecutionSuccess log carries the signed digest',
				async () => {
					const seen = await listExecutionSuccess(client, safe, sinceBirth)
					const digests = seen.slice(-10).map((entry) => entry.digest)
					return {
						status: 'skipped',
						value: `no --digest given; the Safe emitted ${seen.length} ExecutionSuccess log(s) in the window${digests.length > 0 ? `: ${digests.join(', ')}` : ''}`,
					}
				},
			),
		)
	} else {
		const digest = input.digest
		rows.push(
			await attempt(
				'10',
				'ExecutionSuccess log carries the signed digest',
				async () => {
					executionSuccess = await findExecutionSuccess(
						client,
						{ safe, digest },
						sinceBirth,
					)
					if (!executionSuccess) {
						return {
							status: 'fail',
							value: `no ExecutionSuccess log for ${digest} from the Safe between block ${sinceBirth.fromBlock} and ${sinceBirth.toBlock}`,
							expected: digest,
						}
					}
					return {
						status: 'pass',
						value: `block ${executionSuccess.blockNumber}; tx ${executionSuccess.transactionHash}; txHash ${executionSuccess.digest}`,
					}
				},
			),
		)
	}

	// 11. The role member is an executor Safe of the audited shape.
	let roleMembers: Address[] = []
	rows.push(
		await attempt(
			'11',
			'role member is the executor Safe derived from its session key',
			async () => {
				roleMembers = await findRoleMembers(
					client,
					{ rolesProxy, roleKey },
					sinceBirth,
				)
				const [member] = roleMembers
				if (roleMembers.length !== 1 || member === undefined) {
					return {
						status: 'fail',
						value: `AssignRoles logs between block ${sinceBirth.fromBlock} and ${sinceBirth.toBlock} leave ${roleMembers.length} member(s) on the role: ${describeAddresses(roleMembers)}`,
						expected: 'exactly one member',
					}
				}
				const [code, owners, enabled] = await Promise.all([
					client.getCode({ address: member }),
					client.readContract({
						address: member,
						abi: safeReadAbi,
						functionName: 'getOwners',
					}),
					client.readContract({
						address: rolesProxy,
						abi: rolesReadAbi,
						functionName: 'isModuleEnabled',
						args: [member],
					}),
				])
				const codeHash = code && code !== '0x' ? keccak256(code) : undefined
				const [sessionKey] = owners
				const derived =
					owners.length === 1 && sessionKey !== undefined
						? recomputeExecutorSafeAddress({
								sessionKey,
								saltNonce: executorSafeSaltNonce(input.profileId),
								proxyCreationCode: input.proxyCreationCode,
							})
						: undefined
				const ok =
					codeHash === SAFE_PROXY_RUNTIME_HASH &&
					derived !== undefined &&
					sameAddress(derived, member) &&
					enabled
				return {
					status: ok ? 'pass' : 'fail',
					value: `member ${member}; code ${codeHash ?? '(none)'}; owners ${describeAddresses(owners)}; derived ${derived ?? '(not derivable)'}; isModuleEnabled ${enabled}`,
					expected: `member == executor Safe of its sole owner (session key) with the audited executor template; code ${SAFE_PROXY_RUNTIME_HASH}; isModuleEnabled true`,
				}
			},
		),
	)

	return { rows, safeSetup, executionSuccess, roleMembers }
}

function describeSafeSetup(
	lookup: SafeSetupLookup,
	owner: Address,
	window: ScanWindow,
): CheckRow {
	const id = '9'
	const label = 'SafeSetup log: canonical birth'
	const expected = `initiator ${ROLES_PINS.SAFE_PROXY_FACTORY}; owners ${describeAddresses([owner])}; threshold 1; initializer ${ZERO_ADDRESS}; handler ${ROLES_PINS.SAFE_FALLBACK_HANDLER}; in the factory creation transaction`
	if (lookup.status === 'absent') {
		return {
			id,
			label,
			status: 'fail',
			value: `no SafeSetup log from the Safe between block ${window.fromBlock} and ${window.toBlock} (widen --max-blocks or set --from-block if the Safe is older)`,
			expected,
		}
	}
	if (lookup.status === 'not_canonical') {
		return {
			id,
			label,
			status: 'fail',
			value: `${lookup.reason} (block ${lookup.blockNumber}, tx ${lookup.transactionHash})`,
			expected,
		}
	}
	const log = lookup.log
	const problems: string[] = []
	if (!sameAddress(log.initiator, ROLES_PINS.SAFE_PROXY_FACTORY)) {
		problems.push('initiator is not the SafeProxyFactory')
	}
	const [onlyOwner] = log.owners
	if (
		log.owners.length !== 1 ||
		onlyOwner === undefined ||
		!sameAddress(onlyOwner, owner)
	) {
		problems.push('owners are not [owner]')
	}
	if (log.threshold !== 1n) problems.push('threshold is not 1')
	if (!sameAddress(log.initializer, ZERO_ADDRESS)) {
		problems.push(
			`born with a delegatecall initializer ${log.initializer} — do not fund it`,
		)
	}
	if (!sameAddress(log.fallbackHandler, ROLES_PINS.SAFE_FALLBACK_HANDLER)) {
		problems.push(
			'fallback handler is not the pinned CompatibilityFallbackHandler',
		)
	}
	const value = `block ${log.blockNumber}; tx ${log.transactionHash}; initiator ${log.initiator}; owners ${describeAddresses(log.owners)}; threshold ${log.threshold}; initializer ${log.initializer}; handler ${log.fallbackHandler}`
	return problems.length === 0
		? { id, label, status: 'pass', value }
		: {
				id,
				label,
				status: 'fail',
				value: `${value}; ${problems.join('; ')}`,
				expected,
			}
}
