import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import {
	type Address,
	createPublicClient,
	getAddress,
	type Hex,
	http,
	isAddress,
	type PublicClient,
} from 'viem'
import { sepolia } from 'viem/chains'
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
	customerSafeSaltNonce,
	executorSafeSaltNonce,
	ROLES_CHAIN_ID,
	recomputeRolesProxyAddress,
	recomputeSafeAddress,
	roleKeyFor,
	rolesSaltNonce,
} from '../utils/roles-template'
import {
	type PreparedSponsoredSetup,
	type RolesScopeRule,
	type SponsoredRolesPolicy,
	type SponsoredSetupVerdict,
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
	json?: boolean
}

class UsageError extends Error {}

const HELP_TEXT = `
What this verifies

  A Thyme-created Roles profile is a Safe 1.4.1 whose address is the CREATE2
  of a fixed initializer — setup([you], 1, 0x0, 0x, CompatibilityFallbackHandler,
  0x0, 0, 0x0) — plus a salt derived from the profile id, and a Zodiac Roles
  v2.1.1 proxy bound to that Safe. From Thyme's own documentation of the
  trust model (docs/roles-profiles.md):

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

Post-hoc mode (default)

    thyme verify roles-profile --profile <id> --owner <your wallet> \\
      [--digest <the digest you signed>] [--rpc-url <url>]

  Rows 1-10 mirror the console's activation checks; row 9 additionally proves
  the SafeSetup log sits in the transaction that created the proxy (a log
  emitted later by code the Safe delegatecalled is a "do not fund it"
  failure, not a value). Row 11 derives Thyme's executor Safe from the Roles
  proxy's own AssignRoles logs and its sole owner. Rows 1, 2, 4 and 6 describe
  the Safe at birth; if you added an owner, raised the threshold or enabled a
  module afterwards they will differ, and that is yours to judge.

  Logs are scanned newest-first in --chunk-blocks windows from the chain
  head back to --from-block, or back --max-blocks when --from-block is not
  given. --rpc-url defaults to RPC_URL from .env, then viem's public Sepolia
  endpoint.

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
			'Chain id; only 11155111 (Sepolia) is pinned',
			'11155111',
		)
		.option(
			'--rpc-url <url>',
			'JSON-RPC endpoint (default: RPC_URL, then a public Sepolia endpoint)',
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
		const client = createPublicClient({
			chain: sepolia,
			transport: http(options.rpcUrl ?? getEnv('RPC_URL')),
		})
		const liveChainId = await client.getChainId()
		if (liveChainId !== chainId) {
			throw new UsageError(
				`the RPC endpoint serves chain ${liveChainId}, not ${chainId}`,
			)
		}
		const result =
			options.request === undefined
				? await postHoc(client, { owner, profileId, chainId, options })
				: await preSignature(client, { owner, profileId, chainId, options })
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
	chainId: number
	options: VerifyRolesProfileOptions
}

type Outcome = { ok: boolean; summary: string; report: unknown }

function parseOwner(value: string): Address {
	if (!isAddress(value, { strict: false })) {
		throw new UsageError(`--owner is not an address: ${value}`)
	}
	return getAddress(value)
}

function parseChain(value: string): number {
	if (!DECIMAL.test(value))
		throw new UsageError(`--chain is not a chain id: ${value}`)
	const chainId = Number(value)
	if (chainId !== ROLES_CHAIN_ID) {
		throw new UsageError(
			`only chain ${ROLES_CHAIN_ID} (Sepolia) is pinned; refusing chain ${chainId}`,
		)
	}
	return chainId
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
	if (
		request.proxyCreationCode !== undefined &&
		request.proxyCreationCode.toLowerCase() !== proxyCreationCode.toLowerCase()
	) {
		return {
			ok: false,
			summary:
				"REFUSE TO SIGN: the request carries a proxyCreationCode that is not the factory's",
			report: {
				ok: false,
				check: 1,
				reason:
					"the request's proxyCreationCode differs from SafeProxyFactory.proxyCreationCode() on the chain",
			},
		}
	}

	let liveNonce: bigint | undefined
	const needsNonce = !(mode.kind === 'setup' && mode.ordering === 'sign_first')
	if (needsNonce) {
		const safe = recomputeSafeAddress({
			owner,
			saltNonce: customerSafeSaltNonce(profileId),
			proxyCreationCode,
		})
		try {
			liveNonce = await readSafeNonce(client, safe)
		} catch (caught) {
			if (!options.json)
				warn(caught instanceof Error ? caught.message : String(caught))
		}
	}

	const verdict = verifySponsoredSetup({
		mode,
		connectedAddress: owner,
		chainId,
		profileId,
		policy,
		previousRules,
		proxyCreationCode,
		liveNonce,
		prepared: request.prepared,
	})
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
	const customerSalt = customerSafeSaltNonce(profileId)
	const safe = recomputeSafeAddress({
		owner,
		saltNonce: customerSalt,
		proxyCreationCode,
	})
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

	const rows: CheckRow[] = [await verifyStackPins(client)]
	const result = await runPostHocChecks(client, {
		safe,
		owner,
		rolesProxy,
		roleKey,
		profileId,
		proxyCreationCode,
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
