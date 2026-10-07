import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import {
	type Address,
	type Chain,
	createPublicClient,
	getAddress,
	type Hex,
	http,
	isAddress,
	type PublicClient,
} from 'viem'
import {
	bsc,
	optimism,
	polygon,
	polygonAmoy,
	sepolia,
	unichainSepolia,
} from 'viem/chains'
import { getEnv, loadEnv } from '../utils/env'
import {
	type CheckRow,
	DEFAULT_LOG_SCAN_CHUNK_BLOCKS,
	readPinnedProxyCreationCode,
	readSafeNonce,
	runPostHocChecks,
	type ScanWindow,
	verifyStackPins,
} from '../utils/roles-chain'
import {
	CUSTOMER_SAFE_TEMPLATES,
	customerSafeSaltNonce,
	describeRolesChains,
	executorSafeSaltNonce,
	isRolesChainId,
	isSafeVersion,
	type RolesChainId,
	recomputeRolesProxyAddress,
	recomputeSafeAddress,
	roleKeyFor,
	rolesSaltNonce,
	SAFE_SINGLETON_SLOT,
	SAFE_VERSIONS,
	type SafeVersion,
} from '../utils/roles-template'
import {
	type PreparedSponsoredSetup,
	type RolesScopeRule,
	type SponsoredRolesPolicy,
	type SponsoredSetupVerdict,
	sameAddress,
	type VerifierMode,
	verifySponsoredSetup,
} from '../utils/roles-verifier'
import { error, intro, log, outro, pc, step, warn } from '../utils/ui'

/**
 * `thyme verify roles-profile`: the public, MIT-licensed copy of the two
 * controls a sponsored Roles profile rests on, so that neither verifier is
 * Thyme-controlled and hidden.
 *
 * - Pre-signature (`--request`): rebuild, from hard-coded constants, the
 *   owner address, the profile id and the allowlist YOU typed, everything the
 *   wallet is about to sign, and compare it byte for byte with the request
 *   the console produced. Refuses on any mismatch. Needs no Thyme account.
 * - Post-hoc (default): recompute the Safe and Roles proxy addresses the same
 *   way, then read the chain and print the checks the console shows after
 *   activation, including the Safe's own `SafeSetup` birth log proven to sit
 *   in the factory's creation transaction.
 *
 * Nothing here talks to Thyme. The only network access is the JSON-RPC
 * endpoint you choose.
 */

const DEFAULT_MAX_BLOCKS = 400_000n
const HASH32 = /^0x[0-9a-f]{64}$/i
const DECIMAL = /^(0|[1-9][0-9]*)$/

type VerifyRolesProfileOptions = {
	profile: string
	owner: string
	chain: string
	rpcUrl?: string
	digest?: string
	fromBlock?: string
	maxBlocks: string
	chunkBlocks: string
	request?: string
	allowlist?: string
	previousAllowlist?: string
	mode: string
	ordering?: string
	safeVersion: string
	saltProfile?: string
	json?: boolean
}

class UsageError extends Error {}

const HELP_TEXT = `
What this verifies

  A Thyme-created Roles profile is a Safe 1.4.1 or 1.5.0 whose address is the
  CREATE2 of a fixed initializer — setup([you], 1, 0x0, 0x,
  CompatibilityFallbackHandler, 0x0, 0, 0x0) — through that version's
  SafeProxyFactory and SafeL2 singleton, plus a salt derived from the profile
  id, and a Zodiac Roles v2.1.1 proxy bound to that Safe. From Thyme's own
  documentation of the trust model (docs/roles-profiles.md):

    "Thyme can only send the batch the customer signed, on the Safe the
    signature names, at the nonce it names. But Thyme builds that batch and
    chooses the account the signature binds to: it writes the Safe's
    initializer and it assembles the typed-data request the wallet displays.
    Before the customer signs, the only thing constraining both is the
    recomputation the customer's own browser performs — of the Safe address
    from the standard template and of every field of the signature request
    from the allowlist the customer typed."

    "No owner, threshold, module, version, singleton or bytecode read can
    detect a substituted initializer after the fact; the Safe's own
    SafeSetup log can."

  This command is the copy of both checks that does not run in Thyme's
  console. Every constant it uses is typed in its source; nothing is read
  from Thyme.

Pre-signature mode (--request)

  Download the signature request from the console before you sign, save the
  allowlist you typed as JSON ([{ "target": "0x…", "selector": "0x…" }]), then:

    thyme verify roles-profile --profile <id> --owner <your wallet> \\
      --request request.json --allowlist allowlist.json

  Checks 0-13: owner, pinned proxyCreationCode (read from the chain, never
  from the file), salt, canonical initializer, Safe address, Roles proxy and
  role key, executor Safe from the session key, typed-data structure, outer
  shape (MultiSendCallOnly + delegatecall, or one CALL to your Roles proxy),
  nonce, CALL-only inner calls, allowed selectors, allowlist equality, and
  the digest rebuilt here equal to both the request's digest and the hash of
  its typed data. Any failure means: do not sign.

  For a scope update pass --mode scope-update and --previous-allowlist with
  the allowlist live before the change; the request must revoke every rule
  you drop explicitly. For a revocation pass --mode revocation (no allowlist).

Safe versions (--safe-version)

  The template is never taken from the request or from Thyme. By default
  (auto) the command derives the Safe address from both pinned templates:
  before signing, the request's Safe must be exactly one of them; after
  activation, exactly one of them must have code. Pass --safe-version 1.4.1
  or 1.5.0 to require one. A 1.4.1 Safe upgraded in place to 1.5.0 from
  Safe{Wallet} is still a 1.4.1-born Safe: rows 3, 5 and 6 accept the
  SafeL2 1.5.0 singleton and handler, and row 9 still proves the 1.4.1 birth.

Same Safe on another chain (--salt-profile)

  A profile can recreate, at the same address, a Safe another profile has on
  a different chain. Its Safe's salt then derives from THAT profile's id:
  pass it as --salt-profile. The Roles proxy, role key and executor Safe
  still derive from --profile. The copy is born with its original owner and
  nothing else, so check that you still control that owner key.

Post-hoc mode (default)

    thyme verify roles-profile --profile <id> --owner <your wallet> \\
      [--digest <the digest you signed>] [--rpc-url <url>]

  Rows 1-10 mirror the console's activation checks; row 9 additionally proves
  the SafeSetup log sits in the transaction that created the proxy (a log
  emitted later by code the Safe delegatecalled is a "do not fund it"
  failure, not a value). Row 11 derives Thyme's executor Safe from the Roles
  proxy's own AssignRoles logs and its sole owner. Rows 1, 2, 4 and 6 describe
  the Safe at birth; if you added an owner, raised the threshold, enabled a
  module or set a guard or module guard afterwards they will differ, and that
  is yours to judge.

  Logs are scanned newest-first in --chunk-blocks windows from the chain
  head back to --from-block, or back --max-blocks when --from-block is not
  given. --rpc-url defaults to RPC_URL from .env, then viem's public
  endpoint for --chain.

Exit codes: 0 all checks passed, 1 a check failed, 2 usage or input error.
`

export function registerVerifyCommand(program: Command): void {
	const verify = program
		.command('verify')
		.description('Independently verify what Thyme asks you to sign or created')
	verify
		.command('roles-profile')
		.description(
			'Recompute a sponsored Roles profile Safe and check a signature request or the chain against it',
		)
		.requiredOption('--profile <id>', 'The profile id every salt derives from')
		.requiredOption(
			'--owner <address>',
			'The wallet that owns (or will own) the Safe — stands in for the connected wallet',
		)
		.option(
			'--chain <id>',
			`Chain id; pinned on ${describeRolesChains()}`,
			'11155111',
		)
		.option(
			'--rpc-url <url>',
			"JSON-RPC endpoint (default: RPC_URL, then viem's public endpoint for --chain)",
		)
		.option(
			'--digest <hex>',
			'Post-hoc: expect an ExecutionSuccess log for this SafeTx digest',
		)
		.option(
			'--from-block <n>',
			'Post-hoc: oldest block to scan for logs (default: head minus --max-blocks)',
		)
		.option(
			'--max-blocks <n>',
			'Post-hoc: how far back to scan when --from-block is not given',
			'400000',
		)
		.option('--chunk-blocks <n>', 'Blocks per eth_getLogs request', '2000')
		.option(
			'--request <file>',
			'Pre-signature: the signature request JSON downloaded from the console',
		)
		.option(
			'--allowlist <file>',
			'Pre-signature: the allowlist you typed, as JSON',
		)
		.option(
			'--previous-allowlist <file>',
			'Pre-signature scope updates: the allowlist live before this change',
		)
		.option(
			'--mode <mode>',
			'Pre-signature: setup | scope-update | revocation',
			'setup',
		)
		.option(
			'--ordering <ordering>',
			'Pre-signature setup: sign_first | deploy_first (default: from the request)',
		)
		.option(
			'--safe-version <version>',
			`The template the Safe was born on: auto | ${SAFE_VERSIONS.join(' | ')}`,
			'auto',
		)
		.option(
			'--salt-profile <id>',
			"The profile whose Safe this profile recreates on a new chain; the Safe's salt derives from it",
		)
		.option('--json', 'Print a machine-readable result instead of text')
		.addHelpText('after', HELP_TEXT)
		.action((options: VerifyRolesProfileOptions) =>
			verifyRolesProfileCommand(options),
		)
}

export async function verifyRolesProfileCommand(
	options: VerifyRolesProfileOptions,
): Promise<void> {
	const json = options.json === true
	if (!json) intro('Thyme CLI - Verify Roles profile')
	try {
		loadEnv(process.cwd())
		const owner = parseOwner(options.owner)
		const profileId = options.profile.trim()
		if (profileId.length === 0)
			throw new UsageError('--profile must not be empty')
		const chainId = parseChain(options.chain)
		const safeVersion = parseSafeVersion(options.safeVersion)
		const client = createPublicClient({
			chain: VIEM_CHAINS[chainId],
			transport: http(options.rpcUrl ?? getEnv('RPC_URL')),
		})
		const liveChainId = await client.getChainId()
		if (liveChainId !== chainId) {
			throw new UsageError(
				`the RPC endpoint serves chain ${liveChainId}, not ${chainId}`,
			)
		}
		const saltProfileId = options.saltProfile?.trim()
		if (saltProfileId !== undefined && saltProfileId.length === 0)
			throw new UsageError('--salt-profile must not be empty')
		const context: Context = {
			owner,
			profileId,
			saltProfileId,
			chainId,
			safeVersion,
			options,
		}
		const result =
			options.request === undefined
				? await postHoc(client, context)
				: await preSignature(client, context)
		if (json) {
			process.stdout.write(`${stringify(result.report)}\n`)
		}
		process.exitCode = result.ok ? 0 : 1
		if (!json) {
			outro(result.ok ? pc.green(result.summary) : pc.red(result.summary))
		}
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught)
		if (json) {
			process.stdout.write(`${stringify({ ok: false, error: message })}\n`)
		} else {
			error(message)
			outro(pc.red('Verification did not complete'))
		}
		process.exitCode = caught instanceof UsageError ? 2 : 1
	}
}

type Client = PublicClient

type Context = {
	owner: Address
	profileId: string
	/** The id the customer Safe's salt derives from (`--salt-profile`). */
	saltProfileId?: string
	chainId: number
	/** `undefined` means auto. */
	safeVersion?: SafeVersion
	options: VerifyRolesProfileOptions
}

type Outcome = { ok: boolean; summary: string; report: unknown }

function parseOwner(value: string): Address {
	if (!isAddress(value, { strict: false })) {
		throw new UsageError(`--owner is not an address: ${value}`)
	}
	return getAddress(value)
}

/**
 * viem's chain definitions, used only for the default public RPC endpoint when
 * neither --rpc-url nor RPC_URL is given. Nothing about the pins comes from here.
 */
const VIEM_CHAINS: Record<RolesChainId, Chain> = {
	11155111: sepolia,
	80002: polygonAmoy,
	1301: unichainSepolia,
	137: polygon,
	10: optimism,
	56: bsc,
}

function parseChain(value: string): RolesChainId {
	if (!DECIMAL.test(value))
		throw new UsageError(`--chain is not a chain id: ${value}`)
	const chainId = Number(value)
	if (!isRolesChainId(chainId)) {
		throw new UsageError(
			`chain ${chainId} is not pinned; this command supports ${describeRolesChains()}`,
		)
	}
	return chainId
}

function parseSafeVersion(value: string): SafeVersion | undefined {
	if (value === 'auto') return undefined
	if (!isSafeVersion(value)) {
		throw new UsageError(
			`--safe-version must be auto, ${SAFE_VERSIONS.join(' or ')}, got ${value}`,
		)
	}
	return value
}

/**
 * SafeProxyFactory 1.5.0's creation code, or `undefined` with a warning when
 * the chain does not hold the pinned factory: only the 1.4.1 template is then
 * considered, and a 1.5.0 Safe fails to match instead of being trusted.
 */
async function readOptionalProxyCreationCode150(
	client: Client,
	json: boolean | undefined,
): Promise<Hex | undefined> {
	try {
		return await readPinnedProxyCreationCode(client, '1.5.0')
	} catch (caught) {
		if (!json) {
			warn(
				`SafeProxyFactory 1.5.0 unavailable; only the 1.4.1 template is considered: ${caught instanceof Error ? caught.message.split('\n')[0] : String(caught)}`,
			)
		}
		return undefined
	}
}

/** The customer Safe address each template derives, for the codes given. */
function candidateSafes(
	owner: Address,
	saltProfileId: string,
	codes: Partial<Record<SafeVersion, Hex>>,
): { version: SafeVersion; address: Address }[] {
	const saltNonce = customerSafeSaltNonce(saltProfileId)
	return SAFE_VERSIONS.flatMap((version) => {
		const proxyCreationCode = codes[version]
		return proxyCreationCode === undefined
			? []
			: [
					{
						version,
						address: recomputeSafeAddress({
							owner,
							saltNonce,
							proxyCreationCode,
							version,
						}),
					},
				]
	})
}

function describeCandidates(
	candidates: readonly { version: SafeVersion; address: Address }[],
): string {
	return candidates
		.map((candidate) => `${candidate.version} → ${candidate.address}`)
		.join(', ')
}

function parseBigint(
	value: string | undefined,
	flag: string,
): bigint | undefined {
	if (value === undefined) return undefined
	if (!DECIMAL.test(value))
		throw new UsageError(`${flag} must be a decimal integer`)
	return BigInt(value)
}

function parseDigest(value: string | undefined): Hex | undefined {
	if (value === undefined) return undefined
	if (!HASH32.test(value))
		throw new UsageError('--digest must be a 32-byte hex value')
	return value.toLowerCase() as Hex
}

function readJsonFile(path: string, label: string): unknown {
	let text: string
	try {
		text = readFileSync(path, 'utf-8')
	} catch (caught) {
		throw new UsageError(
			`${label}: cannot read ${path}: ${caught instanceof Error ? caught.message : String(caught)}`,
		)
	}
	try {
		return JSON.parse(text)
	} catch (caught) {
		throw new UsageError(
			`${label}: ${path} is not valid JSON: ${caught instanceof Error ? caught.message : String(caught)}`,
		)
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key]
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'string')
		throw new UsageError(`request.${key} must be a string`)
	return value
}

function requireString(record: Record<string, unknown>, key: string): string {
	const value = optionalString(record, key)
	if (value === undefined) throw new UsageError(`request.${key} is missing`)
	return value
}

function parseRules(value: unknown, label: string): RolesScopeRule[] {
	const list = Array.isArray(value)
		? value
		: isRecord(value) && Array.isArray(value.rules)
			? value.rules
			: undefined
	if (list === undefined) {
		throw new UsageError(
			`${label} must be a JSON array of { target, selector } or an object with a rules array`,
		)
	}
	return list.map((entry, index) => {
		if (
			!isRecord(entry) ||
			typeof entry.target !== 'string' ||
			typeof entry.selector !== 'string'
		) {
			throw new UsageError(
				`${label}: rule ${index} must have string target and selector`,
			)
		}
		return { target: entry.target, selector: entry.selector }
	})
}

function parseMode(
	options: VerifyRolesProfileOptions,
	requestOrdering: string | undefined,
): VerifierMode {
	switch (options.mode) {
		case 'setup': {
			const ordering = options.ordering ?? requestOrdering ?? 'sign_first'
			if (ordering !== 'sign_first' && ordering !== 'deploy_first') {
				throw new UsageError(
					`--ordering must be sign_first or deploy_first, got ${ordering}`,
				)
			}
			return { kind: 'setup', ordering }
		}
		case 'scope-update':
			return { kind: 'scope_update' }
		case 'revocation':
			return { kind: 'revocation' }
		default:
			throw new UsageError(
				`--mode must be setup, scope-update or revocation, got ${options.mode}`,
			)
	}
}

/** The signature request as the console downloads it: the prepare response, verbatim. */
function parseRequest(
	raw: unknown,
	context: Context,
): {
	prepared: PreparedSponsoredSetup
	ordering?: string
	proxyCreationCode?: string
} {
	if (!isRecord(raw))
		throw new UsageError('the request file must contain a JSON object')
	const fileProfile = optionalString(raw, 'profileId')
	if (fileProfile !== undefined && fileProfile !== context.profileId) {
		throw new UsageError(
			`the request names profile ${fileProfile} but --profile is ${context.profileId}; every salt derives from --profile, so decide which one you are verifying`,
		)
	}
	const fileChain = raw.chainId
	if (fileChain !== undefined && Number(fileChain) !== context.chainId) {
		throw new UsageError(
			`the request names chain ${String(fileChain)} but --chain is ${context.chainId}`,
		)
	}
	const typedDataJson =
		optionalString(raw, 'typedDataJson') ??
		(isRecord(raw.typedData) ? JSON.stringify(raw.typedData) : undefined)
	if (typedDataJson === undefined) {
		throw new UsageError(
			'request.typedDataJson is missing (nothing to sign yet?)',
		)
	}
	const setupDigest =
		optionalString(raw, 'setupDigest') ?? optionalString(raw, 'digest')
	if (setupDigest === undefined)
		throw new UsageError('request.setupDigest (or digest) is missing')
	const scopeRules =
		raw.scopeRules === undefined
			? undefined
			: parseRules(raw.scopeRules, 'request.scopeRules')
	return {
		prepared: {
			ownerAddress: requireString(raw, 'ownerAddress'),
			safeAddress: requireString(raw, 'safeAddress'),
			sessionKeyAddress: requireString(raw, 'sessionKeyAddress'),
			rolesProxyAddress: requireString(raw, 'rolesProxyAddress'),
			executorSafeAddress: requireString(raw, 'executorSafeAddress'),
			roleKey: requireString(raw, 'roleKey'),
			setupDigest,
			typedDataJson,
			customerSaltNonce: optionalString(raw, 'customerSaltNonce'),
			customerSafeInitializer: optionalString(raw, 'customerSafeInitializer'),
			customerSafeTemplate: optionalString(raw, 'customerSafeTemplate'),
			customerSafeSaltProfileId: optionalString(
				raw,
				'customerSafeSaltProfileId',
			),
			scopeRules,
		},
		ordering: optionalString(raw, 'ordering'),
		proxyCreationCode: optionalString(raw, 'proxyCreationCode'),
	}
}

async function preSignature(
	client: Client,
	context: Context,
): Promise<Outcome> {
	const { options, owner, profileId, chainId } = context
	const request = parseRequest(
		readJsonFile(options.request as string, '--request'),
		context,
	)
	const mode = parseMode(options, request.ordering)

	let policy: SponsoredRolesPolicy
	if (mode.kind === 'revocation') {
		policy = { mode: 'allowlist', rules: [] }
	} else {
		if (options.allowlist === undefined) {
			throw new UsageError(
				'--allowlist <file> is required for setup and scope-update requests',
			)
		}
		policy = {
			mode: 'allowlist',
			rules: parseRules(
				readJsonFile(options.allowlist, '--allowlist'),
				'--allowlist',
			),
		}
	}
	const previousRules =
		options.previousAllowlist === undefined
			? undefined
			: parseRules(
					readJsonFile(options.previousAllowlist, '--previous-allowlist'),
					'--previous-allowlist',
				)
	if (mode.kind === 'scope_update' && previousRules === undefined) {
		throw new UsageError(
			'--previous-allowlist <file> is required for a scope update',
		)
	}

	if (!options.json) {
		step(`Reading SafeProxyFactory.proxyCreationCode() from the chain`)
	}
	const proxyCreationCode = await readPinnedProxyCreationCode(client)
	const proxyCreationCode150 =
		context.safeVersion === '1.4.1'
			? undefined
			: await readOptionalProxyCreationCode150(client, options.json)
	if (
		request.proxyCreationCode !== undefined &&
		![proxyCreationCode, proxyCreationCode150].some(
			(code) =>
				code !== undefined &&
				request.proxyCreationCode?.toLowerCase() === code.toLowerCase(),
		)
	) {
		return {
			ok: false,
			summary:
				"REFUSE TO SIGN: the request carries a proxyCreationCode that is not a pinned factory's",
			report: {
				ok: false,
				check: 1,
				reason:
					"the request's proxyCreationCode differs from every pinned SafeProxyFactory.proxyCreationCode() on the chain",
			},
		}
	}

	let liveNonce: bigint | undefined
	const needsNonce = !(mode.kind === 'setup' && mode.ordering === 'sign_first')
	if (needsNonce) {
		// The nonce is read from whichever derived Safe the request names; the
		// verifier still requires the request's Safe to be one of them.
		const named = candidateSafes(owner, context.saltProfileId ?? profileId, {
			'1.4.1': proxyCreationCode,
			'1.5.0': proxyCreationCode150,
		}).find((candidate) =>
			sameAddress(candidate.address, request.prepared.safeAddress),
		)
		if (named === undefined) {
			if (!options.json) {
				warn(
					'the request names a Safe neither template derives, so its nonce was not read',
				)
			}
		} else {
			try {
				liveNonce = await readSafeNonce(client, named.address)
			} catch (caught) {
				if (!options.json)
					warn(caught instanceof Error ? caught.message : String(caught))
			}
		}
	}

	const verified = verifySponsoredSetup({
		mode,
		connectedAddress: owner,
		chainId,
		profileId,
		saltProfileId: context.saltProfileId,
		policy,
		previousRules,
		proxyCreationCode,
		proxyCreationCode150,
		liveNonce,
		prepared: request.prepared,
	})
	const verdict: SponsoredSetupVerdict =
		verified.ok &&
		context.safeVersion !== undefined &&
		verified.safeVersion !== context.safeVersion
			? {
					ok: false,
					check: 4,
					reason: `the request's Safe derives from the ${verified.safeVersion} template, not the --safe-version you required`,
					expected: context.safeVersion,
					received: verified.safeVersion,
				}
			: verified
	if (!options.json) printVerdict(verdict, mode)
	return {
		ok: verdict.ok,
		summary: verdict.ok
			? 'The request matches what this machine rebuilt. You may sign it.'
			: `REFUSE TO SIGN: check ${verdict.check} failed — ${verdict.reason}`,
		report: verdict,
	}
}

function printVerdict(
	verdict: SponsoredSetupVerdict,
	mode: VerifierMode,
): void {
	if (!verdict.ok) {
		error(`Check ${verdict.check} failed: ${verdict.reason}`)
		if (verdict.expected !== undefined) log(`  expected  ${verdict.expected}`)
		if (verdict.received !== undefined) log(`  received  ${verdict.received}`)
		return
	}
	step('Recomputed on this machine, from hard-coded constants')
	log(`  mode               ${describeMode(mode)}`)
	log(`  owner              ${verdict.ownerAddress}`)
	log(`  Safe template      ${verdict.safeVersion}`)
	log(`  Safe               ${verdict.safeAddress}`)
	log(`  Roles proxy        ${verdict.rolesProxyAddress}`)
	log(`  role key           ${verdict.roleKey}`)
	log(`  executor Safe      ${verdict.executorSafeAddress}`)
	log(`  session key        ${verdict.sessionKeyAddress}`)
	log(`  customer salt      ${verdict.customerSaltNonce}`)
	log(`  Roles salt         ${verdict.rolesSaltNonce}`)
	log(`  executor salt      ${verdict.executorSaltNonce}`)
	step('The SafeTx your wallet will be asked to sign')
	log(`  to                 ${verdict.safeTx.to}`)
	log(
		`  operation          ${verdict.safeTx.operation === 1 ? '1 (delegatecall into MultiSendCallOnly)' : '0 (call)'}`,
	)
	log(`  nonce              ${verdict.safeTx.nonce}`)
	log(`  digest             ${verdict.digest}`)
	step(`Inner calls (${verdict.calls.length})`)
	for (const [index, call] of verdict.calls.entries()) {
		log(
			`  ${index}. ${call.functionName}(${call.args.map(formatArg).join(', ')})`,
		)
		log(`     to ${call.to}`)
	}
}

function describeMode(mode: VerifierMode): string {
	return mode.kind === 'setup' ? `setup (${mode.ordering})` : mode.kind
}

function formatArg(value: unknown): string {
	if (typeof value === 'bigint') return value.toString()
	if (Array.isArray(value)) return `[${value.map(formatArg).join(', ')}]`
	return String(value)
}

async function postHoc(client: Client, context: Context): Promise<Outcome> {
	const { options, owner, profileId } = context
	const digest = parseDigest(options.digest)
	const fromBlock = parseBigint(options.fromBlock, '--from-block')
	const maxBlocks =
		parseBigint(options.maxBlocks, '--max-blocks') ?? DEFAULT_MAX_BLOCKS
	const chunkBlocks =
		parseBigint(options.chunkBlocks, '--chunk-blocks') ??
		DEFAULT_LOG_SCAN_CHUNK_BLOCKS
	if (chunkBlocks === 0n)
		throw new UsageError('--chunk-blocks must be at least 1')

	if (!options.json)
		step('Reading SafeProxyFactory.proxyCreationCode() from the chain')
	const proxyCreationCode = await readPinnedProxyCreationCode(client)
	const proxyCreationCode150 =
		context.safeVersion === '1.4.1'
			? undefined
			: await readOptionalProxyCreationCode150(client, options.json)
	const candidates = candidateSafes(owner, context.saltProfileId ?? profileId, {
		'1.4.1': proxyCreationCode,
		'1.5.0': proxyCreationCode150,
	})
	const { address: safe, version: safeVersion } = await chooseSafe(
		client,
		candidates,
		context.safeVersion,
	)
	const singletonWord = await client.getStorageAt({
		address: safe,
		slot: SAFE_SINGLETON_SLOT,
	})
	const runs150 =
		singletonWord
			?.toLowerCase()
			.endsWith(
				CUSTOMER_SAFE_TEMPLATES['1.5.0'].singleton.slice(2).toLowerCase(),
			) === true
	const customerSalt = customerSafeSaltNonce(context.saltProfileId ?? profileId)
	const rolesSalt = rolesSaltNonce(profileId)
	const rolesProxy = recomputeRolesProxyAddress({ safe, saltNonce: rolesSalt })
	const roleKey = roleKeyFor(profileId)
	const executorSalt = executorSafeSaltNonce(profileId)

	const head = await client.getBlockNumber()
	const lowerBound = fromBlock ?? (head > maxBlocks ? head - maxBlocks : 0n)
	if (lowerBound > head)
		throw new UsageError(
			`--from-block ${lowerBound} is beyond the chain head ${head}`,
		)
	const window: ScanWindow = {
		fromBlock: lowerBound,
		toBlock: head,
		chunkBlocks,
	}

	if (!options.json) {
		step('Recomputed on this machine, from hard-coded constants')
		log(`  owner              ${owner}`)
		log(`  profile            ${profileId}`)
		if (context.saltProfileId) {
			log(`  Safe salt from     ${context.saltProfileId}`)
		}
		log(
			`  Safe template      ${safeVersion}${runs150 && safeVersion !== '1.5.0' ? ' (upgraded in place to 1.5.0)' : ''}`,
		)
		log(`  Safe               ${safe}`)
		log(`  Roles proxy        ${rolesProxy}`)
		log(`  role key           ${roleKey}`)
		log(`  customer salt      ${customerSalt}`)
		log(`  Roles salt         ${rolesSalt}`)
		log(`  executor salt      ${executorSalt}`)
		step(
			`Reading the chain (blocks ${lowerBound} to ${head}, ${chunkBlocks} per request)`,
		)
	}

	const stackVersions: SafeVersion[] =
		safeVersion === '1.5.0' || runs150 ? ['1.4.1', '1.5.0'] : ['1.4.1']
	const rows: CheckRow[] = [await verifyStackPins(client, stackVersions)]
	const result = await runPostHocChecks(client, {
		safe,
		owner,
		rolesProxy,
		roleKey,
		profileId,
		proxyCreationCode,
		safeVersion,
		digest,
		window,
	})
	rows.push(...result.rows)
	if (!options.json) for (const row of rows) printRow(row)

	const failed = rows.filter((row) => row.status === 'fail')
	const skipped = rows.filter((row) => row.status === 'skipped')
	const summary =
		failed.length === 0
			? `All ${rows.length - skipped.length} checks passed${skipped.length > 0 ? ` (${skipped.length} skipped)` : ''}`
			: `${failed.length} check(s) failed: ${failed.map((row) => row.id).join(', ')}`
	return {
		ok: failed.length === 0,
		summary,
		report: {
			ok: failed.length === 0,
			derived: {
				owner,
				profileId,
				saltProfileId: context.saltProfileId,
				safeVersion,
				candidates,
				safe,
				rolesProxy,
				roleKey,
				customerSalt,
				rolesSalt,
				executorSalt,
			},
			window,
			rows,
			safeSetup: result.safeSetup,
			executionSuccess: result.executionSuccess,
			roleMembers: result.roleMembers,
		},
	}
}

/**
 * The derived Safe to verify: the one `--safe-version` names, or else the
 * only candidate with code. Both with code is ambiguous (anyone can deploy
 * either through its factory), so the caller must choose.
 */
async function chooseSafe(
	client: Client,
	candidates: readonly { version: SafeVersion; address: Address }[],
	required: SafeVersion | undefined,
): Promise<{ version: SafeVersion; address: Address }> {
	if (required !== undefined) {
		const named = candidates.find((candidate) => candidate.version === required)
		if (named === undefined) {
			throw new Error(
				`--safe-version ${required} needs the pinned SafeProxyFactory ${required}, which this chain does not hold`,
			)
		}
		return named
	}
	const codes = await Promise.all(
		candidates.map((candidate) =>
			client.getCode({ address: candidate.address }),
		),
	)
	const deployed = candidates.filter((_, index) => {
		const code = codes[index]
		return code !== undefined && code !== '0x'
	})
	const [only] = deployed
	if (deployed.length === 1 && only !== undefined) return only
	if (deployed.length === 0) {
		throw new Error(
			`neither template's Safe has code on this chain (${describeCandidates(candidates)}); check --profile, --owner and --chain`,
		)
	}
	throw new UsageError(
		`both templates' Safes have code (${describeCandidates(deployed)}); pass --safe-version`,
	)
}

function printRow(row: CheckRow): void {
	const marker =
		row.status === 'pass'
			? pc.green('PASS')
			: row.status === 'fail'
				? pc.red('FAIL')
				: pc.yellow('SKIP')
	log(`${marker}  ${row.id.padStart(5)}  ${row.label}`)
	log(`             ${pc.dim('value')}     ${row.value}`)
	if (row.expected !== undefined && row.status !== 'pass') {
		log(`             ${pc.dim('expected')}  ${row.expected}`)
	}
}

function stringify(value: unknown): string {
	return JSON.stringify(
		value,
		(_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry),
		2,
	)
}
