import {
	encodeAbiParameters,
	getAddress,
	type Hex,
	isAddress,
	isHex,
	keccak256,
	pad,
	size,
	toHex,
} from 'viem'

/**
 * Parameter conditions and spending allowances for a Roles profile.
 *
 * Everything here is pure: no I/O. It is a copy of the builder the Thyme
 * console's pre-signature verifier carries, duplicated on purpose so that
 * `thyme verify roles-profile` rebuilds every condition tree and allowance from
 * the policy you typed without trusting the service; keep the two identical.
 *
 * The on-chain objects are Zodiac Roles v2.1.1's `ConditionFlat[]` trees
 * (`scopeFunction`) and allowances (`setAllowance`).
 */

/** Conditions a single rule may carry (one per parameter). */
export const MAX_ROLES_CONDITIONS_PER_RULE = 8
/** Values one `oneOf` may list. */
export const MAX_ROLES_ONEOF_VALUES = 20
/** Allowances one policy may declare; each costs one `setAllowance` call. */
export const MAX_ROLES_ALLOWANCES = 10
/** Ten years. Bounds nonsense values; Roles itself takes any uint64. */
export const MAX_ALLOWANCE_PERIOD_SECONDS = 315_360_000

/** Every refusal starts with "Invalid policy:", so callers can recognise it. */
function invalid(message: string): Error {
	return new Error(`Invalid policy: ${message}`)
}

const UINT128_MAX = (1n << 128n) - 1n
const ALLOWANCE_NAME = /^[a-z0-9][a-z0-9_-]{0,30}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const SIGNED_DECIMAL = /^(0|-?[1-9][0-9]*)$/

export type ParamCondition =
	| { param: number; op: 'equalTo'; value: string }
	| { param: number; op: 'oneOf'; values: string[] }
	| { param: number; op: 'lessThan'; value: string }
	| { param: number; op: 'greaterThan'; value: string }
	| { param: number; op: 'withinAllowance'; allowance: string }

/** As typed by a user or sent over the API; every omitted field has a default. */
export type PolicyAllowanceInput = {
	name: string
	refill: string
	period: number
	maxRefill?: string
	balance?: string
}

/**
 * Normalised: every field explicit so a verifier can compare it
 * byte for byte with the `setAllowance` call, with no defaults to reproduce.
 * Amounts are decimal strings of at most 128 bits.
 */
export type PolicyAllowance = {
	name: string
	refill: string
	maxRefill: string
	balance: string
	period: number
}

export type ConditionedRule = {
	functionSignature?: string
	conditions?: ParamCondition[]
	callAllowance?: string
}

/** What `setAllowance` carries, with the key derived for the scoped role. */
export type RolesAllowance = {
	name: string
	key: Hex
	refill: bigint
	maxRefill: bigint
	balance: bigint
	period: bigint
}

export type ConditionFlat = {
	parent: number
	paramType: number
	operator: number
	compValue: Hex
}

// Zodiac Roles v2.1.1 `Types.sol`.
const PARAMETER_TYPE = {
	None: 0,
	Static: 1,
	Dynamic: 2,
	Calldata: 5,
} as const
const OPERATOR = {
	Pass: 0,
	Or: 2,
	Matches: 5,
	EqualTo: 16,
	GreaterThan: 17,
	LessThan: 18,
	WithinAllowance: 28,
	CallWithinAllowance: 30,
} as const

export type ParamType =
	| { kind: 'address'; solidity: string }
	| { kind: 'bool'; solidity: string }
	| { kind: 'uint'; solidity: string; bits: number }
	| { kind: 'int'; solidity: string; bits: number }
	| { kind: 'bytesN'; solidity: string; length: number }
	| { kind: 'dynamic'; solidity: string }

function parseParamType(raw: string): ParamType {
	if (raw === 'address') return { kind: 'address', solidity: raw }
	if (raw === 'bool') return { kind: 'bool', solidity: raw }
	if (raw === 'bytes' || raw === 'string') {
		return { kind: 'dynamic', solidity: raw }
	}
	const integer = /^(uint|int)([0-9]{1,3})$/.exec(raw)
	if (integer) {
		const bits = Number(integer[2])
		if (bits >= 8 && bits <= 256 && bits % 8 === 0) {
			return integer[1] === 'uint'
				? { kind: 'uint', solidity: raw, bits }
				: { kind: 'int', solidity: raw, bits }
		}
	}
	const fixed = /^bytes([0-9]{1,2})$/.exec(raw)
	if (fixed) {
		const length = Number(fixed[1])
		if (length >= 1 && length <= 32) {
			return { kind: 'bytesN', solidity: raw, length }
		}
	}
	throw invalid(
		`Parameter type ${raw} is not supported in a condition; use address, bool, uintN, intN, bytesN, bytes or string`,
	)
}

/**
 * The parameter types of a compact signature such as `transfer(address,uint256)`.
 * Tuples and arrays are refused: Roles needs a typed child for each of their
 * members, which this version does not model.
 */
export function parseSignatureParams(signature: string): ParamType[] {
	const open = signature.indexOf('(')
	if (open < 1 || !signature.endsWith(')')) {
		throw invalid(`Not a function signature: ${signature}`)
	}
	const inner = signature.slice(open + 1, -1)
	if (inner === '') return []
	if (/[()[\]]/.test(inner)) {
		throw invalid(
			'Conditions do not support tuple or array parameters; remove the conditions or use a function without them',
		)
	}
	return inner.split(',').map(parseParamType)
}

function parseUint(value: unknown, bits: number, label: string): bigint {
	if (typeof value !== 'string' || !DECIMAL.test(value)) {
		throw invalid(`${label} must be a decimal integer string`)
	}
	const parsed = BigInt(value)
	if (parsed >= 1n << BigInt(bits)) {
		throw invalid(`${label} does not fit in ${bits} bits`)
	}
	return parsed
}

type Canonical = { value: string; word: Hex }

/** One value of a parameter, canonicalised and as its 32-byte ABI word. */
function canonicalValue(
	type: ParamType,
	value: unknown,
	label: string,
): Canonical {
	switch (type.kind) {
		case 'address': {
			if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
				throw invalid(`${label} is not an address`)
			}
			const address = getAddress(value)
			if (/^0x0{40}$/.test(address)) {
				throw invalid(`${label} cannot be the zero address`)
			}
			return {
				value: address,
				word: encodeAbiParameters([{ type: 'address' }], [address]),
			}
		}
		case 'bool': {
			if (value !== 'true' && value !== 'false') {
				throw invalid(`${label} must be "true" or "false"`)
			}
			return {
				value,
				word: encodeAbiParameters([{ type: 'bool' }], [value === 'true']),
			}
		}
		case 'uint': {
			const parsed = parseUint(value, type.bits, label)
			return {
				value: parsed.toString(),
				word: encodeAbiParameters([{ type: type.solidity }], [parsed]),
			}
		}
		case 'int': {
			if (typeof value !== 'string' || !SIGNED_DECIMAL.test(value)) {
				throw invalid(`${label} must be a decimal integer string`)
			}
			const parsed = BigInt(value)
			const limit = 1n << BigInt(type.bits - 1)
			if (parsed < -limit || parsed >= limit) {
				throw invalid(`${label} does not fit in ${type.bits} bits`)
			}
			return {
				value: parsed.toString(),
				word: encodeAbiParameters([{ type: type.solidity }], [parsed]),
			}
		}
		case 'bytesN': {
			if (
				typeof value !== 'string' ||
				!isHex(value) ||
				size(value) !== type.length
			) {
				throw invalid(`${label} must be ${type.length} bytes of hex`)
			}
			return {
				value: value.toLowerCase(),
				word: encodeAbiParameters(
					[{ type: type.solidity }],
					[value.toLowerCase() as Hex],
				),
			}
		}
		case 'dynamic':
			throw invalid(`${label}: bytes and string parameters cannot be matched`)
	}
}

function describeType(type: ParamType): string {
	return type.solidity
}

export type NormalizedRuleConditions = {
	conditions?: ParamCondition[]
	callAllowance?: string
	/** Allowance names drawn on by `withinAllowance`, in condition order. */
	amountAllowances: string[]
}

/**
 * Validates and canonicalises one rule's conditions against its signature.
 * Output ordering is fixed (conditions by parameter, `oneOf` values by word) so
 * stored policy JSON compares equal whenever the policies are equal.
 */
export function normalizeRuleConditions(
	rule: {
		functionSignature?: string
		conditions?: unknown
		callAllowance?: unknown
	},
	label: string,
): NormalizedRuleConditions {
	const hasConditions = rule.conditions !== undefined
	const hasCall = rule.callAllowance !== undefined
	if (!hasConditions && !hasCall) return { amountAllowances: [] }
	if (!rule.functionSignature) {
		throw invalid(
			`${label}: conditions need the full function signature, not a bare selector`,
		)
	}
	const params = parseSignatureParams(rule.functionSignature)

	let callAllowance: string | undefined
	if (hasCall) {
		if (
			typeof rule.callAllowance !== 'string' ||
			!ALLOWANCE_NAME.test(rule.callAllowance)
		) {
			throw invalid(`${label}: callAllowance must be an allowance name`)
		}
		callAllowance = rule.callAllowance
	}

	const amountAllowances: string[] = []
	let conditions: ParamCondition[] | undefined
	if (hasConditions) {
		if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) {
			throw invalid(`${label}: conditions must be a non-empty list`)
		}
		if (rule.conditions.length > MAX_ROLES_CONDITIONS_PER_RULE) {
			throw invalid(
				`${label}: a rule allows at most ${MAX_ROLES_CONDITIONS_PER_RULE} conditions`,
			)
		}
		const seen = new Set<number>()
		const normalized: ParamCondition[] = []
		for (const raw of rule.conditions as unknown[]) {
			if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
				throw invalid(`${label}: a condition is malformed`)
			}
			const condition = raw as Record<string, unknown>
			const index = condition.param
			if (
				typeof index !== 'number' ||
				!Number.isInteger(index) ||
				index < 0 ||
				index >= params.length
			) {
				throw invalid(
					`${label}: condition names parameter ${String(index)}, but the function has ${params.length}`,
				)
			}
			if (seen.has(index)) {
				throw invalid(`${label}: parameter ${index} has two conditions`)
			}
			seen.add(index)
			const type = params[index]
			if (!type) throw invalid(`${label}: parameter ${index} does not exist`)
			const where = `${label}, parameter ${index} (${describeType(type)})`
			switch (condition.op) {
				case 'equalTo': {
					normalized.push({
						param: index,
						op: 'equalTo',
						value: canonicalValue(type, condition.value, where).value,
					})
					break
				}
				case 'oneOf': {
					if (
						!Array.isArray(condition.values) ||
						condition.values.length < 2 ||
						condition.values.length > MAX_ROLES_ONEOF_VALUES
					) {
						throw invalid(
							`${where}: oneOf needs between 2 and ${MAX_ROLES_ONEOF_VALUES} values`,
						)
					}
					const byWord = new Map<string, string>()
					for (const value of condition.values as unknown[]) {
						const canonical = canonicalValue(type, value, where)
						byWord.set(canonical.word, canonical.value)
					}
					if (byWord.size < 2) {
						throw invalid(
							`${where}: oneOf lists the same value twice; use equalTo`,
						)
					}
					normalized.push({
						param: index,
						op: 'oneOf',
						values: [...byWord.entries()]
							.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
							.map(([, value]) => value),
					})
					break
				}
				case 'lessThan':
				case 'greaterThan': {
					if (type.kind !== 'uint') {
						throw invalid(`${where}: ${condition.op} needs an unsigned integer`)
					}
					const value = parseUint(condition.value, type.bits, where)
					const max = (1n << BigInt(type.bits)) - 1n
					if (condition.op === 'lessThan' && value === 0n) {
						throw invalid(`${where}: lessThan 0 would refuse every call`)
					}
					if (condition.op === 'greaterThan' && value === max) {
						throw invalid(
							`${where}: greaterThan the maximum refuses every call`,
						)
					}
					normalized.push({
						param: index,
						op: condition.op,
						value: value.toString(),
					})
					break
				}
				case 'withinAllowance': {
					if (type.kind !== 'uint') {
						throw invalid(`${where}: withinAllowance needs an unsigned integer`)
					}
					if (
						typeof condition.allowance !== 'string' ||
						!ALLOWANCE_NAME.test(condition.allowance)
					) {
						throw invalid(`${where}: allowance must be an allowance name`)
					}
					amountAllowances.push(condition.allowance)
					normalized.push({
						param: index,
						op: 'withinAllowance',
						allowance: condition.allowance,
					})
					break
				}
				default:
					throw invalid(`${where}: unknown condition ${String(condition.op)}`)
			}
		}
		conditions = normalized.sort((a, b) => a.param - b.param)
	}
	return {
		...(conditions ? { conditions } : {}),
		...(callAllowance ? { callAllowance } : {}),
		amountAllowances,
	}
}

function parseAmount(value: unknown, label: string): bigint {
	const parsed = parseUint(value, 128, label)
	if (parsed > UINT128_MAX) throw invalid(`${label} does not fit in 128 bits`)
	return parsed
}

/**
 * Normalises declared allowances. A recurring budget (`period > 0`) adds
 * `refill` per period up to `maxRefill` (default `refill`: no carry-over) and
 * starts at `balance` (default `refill`). A one-time budget (`period === 0`)
 * has `refill` 0 and is spent from `balance` alone.
 */
export function normalizePolicyAllowances(input: unknown): PolicyAllowance[] {
	if (input === undefined) return []
	if (!Array.isArray(input)) {
		throw invalid('Policy allowances must be a list')
	}
	if (input.length > MAX_ROLES_ALLOWANCES) {
		throw invalid(
			`A Roles profile allows at most ${MAX_ROLES_ALLOWANCES} allowances`,
		)
	}
	const names = new Set<string>()
	const normalized = input.map((raw: unknown): PolicyAllowance => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			throw invalid('An allowance is malformed')
		}
		const item = raw as Record<string, unknown>
		const name = item.name
		if (typeof name !== 'string' || !ALLOWANCE_NAME.test(name)) {
			throw invalid(
				`Allowance name ${String(name)} must be 1 to 31 characters of a-z, 0-9, _ or -`,
			)
		}
		if (names.has(name)) throw invalid(`Duplicate allowance name: ${name}`)
		names.add(name)
		const label = `Allowance ${name}`
		const period = item.period
		if (
			typeof period !== 'number' ||
			!Number.isInteger(period) ||
			period < 0 ||
			period > MAX_ALLOWANCE_PERIOD_SECONDS
		) {
			throw invalid(
				`${label}: period must be 0 (one-time) or a number of seconds up to ${MAX_ALLOWANCE_PERIOD_SECONDS}`,
			)
		}
		const refill = parseAmount(item.refill, `${label} refill`)
		if (period === 0) {
			if (refill !== 0n) {
				throw invalid(`${label}: a one-time allowance has refill "0"`)
			}
			if (item.balance === undefined) {
				throw invalid(`${label}: a one-time allowance needs a balance`)
			}
			const balance = parseAmount(item.balance, `${label} balance`)
			if (balance === 0n) throw invalid(`${label}: balance must be above 0`)
			// Accept the canonical form too: the editor sends it and stored policies
			// are normalised again when setup, execution or scope edits read them.
			if (
				item.maxRefill !== undefined &&
				parseAmount(item.maxRefill, `${label} maxRefill`) !== balance
			) {
				throw invalid(
					`${label}: a one-time allowance maxRefill must equal balance`,
				)
			}
			return {
				name,
				refill: '0',
				maxRefill: balance.toString(),
				balance: balance.toString(),
				period: 0,
			}
		}
		if (refill === 0n) {
			throw invalid(`${label}: a recurring allowance needs a refill above 0`)
		}
		const maxRefill =
			item.maxRefill === undefined
				? refill
				: parseAmount(item.maxRefill, `${label} maxRefill`)
		if (maxRefill < refill) {
			throw invalid(`${label}: maxRefill cannot be below refill`)
		}
		const balance =
			item.balance === undefined
				? refill
				: parseAmount(item.balance, `${label} balance`)
		return {
			name,
			refill: refill.toString(),
			maxRefill: maxRefill.toString(),
			balance: balance.toString(),
			period,
		}
	})
	return normalized.sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	)
}

/**
 * Cross-checks the rules against the declared allowances: every name a rule
 * draws on is declared, every declared allowance is drawn on (so a batch never
 * carries dead state), and no allowance is spent as both an amount and a call
 * count.
 */
export function assertAllowancesUsed(
	allowances: readonly PolicyAllowance[],
	usage: { amount: ReadonlySet<string>; calls: ReadonlySet<string> },
): void {
	const declared = new Set(allowances.map((item) => item.name))
	for (const name of [...usage.amount, ...usage.calls]) {
		if (!declared.has(name)) {
			throw invalid(`Allowance ${name} is used but not declared`)
		}
	}
	for (const name of usage.amount) {
		if (usage.calls.has(name)) {
			throw invalid(
				`Allowance ${name} cannot count both amounts and calls; declare two`,
			)
		}
	}
	for (const name of declared) {
		if (!usage.amount.has(name) && !usage.calls.has(name)) {
			throw invalid(`Allowance ${name} is declared but no rule uses it`)
		}
	}
}

/**
 * Deterministic per role, so a verifier recomputes it from the role key and the
 * typed name. A scope change rotates the role, which gives every allowance a
 * fresh key and a clean balance, and strands the old ones with no member.
 */
export function allowanceKey(roleKey: Hex, name: string): Hex {
	return keccak256(toHex(`thyme-allowance:${roleKey.toLowerCase()}:${name}`))
}

export function toRolesAllowances(
	allowances: readonly PolicyAllowance[],
	roleKey: Hex,
): RolesAllowance[] {
	return allowances.map((item) => ({
		name: item.name,
		key: allowanceKey(roleKey, item.name),
		refill: BigInt(item.refill),
		maxRefill: BigInt(item.maxRefill),
		balance: BigInt(item.balance),
		period: BigInt(item.period),
	}))
}

/**
 * The `ConditionFlat[]` for one rule, in the breadth-first order Roles'
 * Integrity check requires, or `undefined` when the rule has no conditions
 * (the caller then uses `allowFunction`).
 *
 * Layout: a `Matches` root over the calldata, one child per function
 * parameter in order (`Pass` when unconstrained, so every parameter has a typed
 * child), then the call-count node, which takes no parameter slot, then the
 * members of each `oneOf`.
 */
export function buildConditionTree(
	rule: ConditionedRule,
	keys: Readonly<Record<string, Hex>>,
): ConditionFlat[] | undefined {
	if (!rule.conditions && !rule.callAllowance) return undefined
	if (!rule.functionSignature) {
		throw invalid('A rule with conditions needs its function signature')
	}
	const params = parseSignatureParams(rule.functionSignature)
	const keyOf = (name: string): Hex => {
		const key = keys[name]
		if (!key) throw invalid(`Allowance ${name} has no key`)
		return key
	}
	const byParam = new Map<number, ParamCondition>()
	for (const condition of rule.conditions ?? []) {
		byParam.set(condition.param, condition)
	}
	const nodes: ConditionFlat[] = [
		{
			parent: 0,
			paramType: PARAMETER_TYPE.Calldata,
			operator: OPERATOR.Matches,
			compValue: '0x',
		},
	]
	const orMembers: { parent: number; words: Hex[] }[] = []
	params.forEach((type, index) => {
		const paramType =
			type.kind === 'dynamic' ? PARAMETER_TYPE.Dynamic : PARAMETER_TYPE.Static
		const condition = byParam.get(index)
		if (!condition) {
			nodes.push({
				parent: 0,
				paramType,
				operator: OPERATOR.Pass,
				compValue: '0x',
			})
			return
		}
		switch (condition.op) {
			case 'equalTo':
				nodes.push({
					parent: 0,
					paramType,
					operator: OPERATOR.EqualTo,
					compValue: canonicalValue(type, condition.value, 'value').word,
				})
				break
			case 'oneOf':
				orMembers.push({
					parent: nodes.length,
					words: condition.values.map(
						(value) => canonicalValue(type, value, 'value').word,
					),
				})
				nodes.push({
					parent: 0,
					paramType: PARAMETER_TYPE.None,
					operator: OPERATOR.Or,
					compValue: '0x',
				})
				break
			case 'lessThan':
			case 'greaterThan':
				nodes.push({
					parent: 0,
					paramType,
					operator:
						condition.op === 'lessThan'
							? OPERATOR.LessThan
							: OPERATOR.GreaterThan,
					compValue: pad(toHex(BigInt(condition.value)), { size: 32 }),
				})
				break
			case 'withinAllowance':
				nodes.push({
					parent: 0,
					paramType,
					operator: OPERATOR.WithinAllowance,
					compValue: keyOf(condition.allowance),
				})
				break
		}
	})
	if (rule.callAllowance) {
		nodes.push({
			parent: 0,
			paramType: PARAMETER_TYPE.None,
			operator: OPERATOR.CallWithinAllowance,
			compValue: keyOf(rule.callAllowance),
		})
	}
	for (const member of orMembers) {
		for (const word of member.words) {
			nodes.push({
				parent: member.parent,
				paramType: PARAMETER_TYPE.Static,
				operator: OPERATOR.EqualTo,
				compValue: word,
			})
		}
	}
	return nodes
}

/** The tuple `allowances(key)` returns, as bigints. */
export type OnChainAllowance = {
	refill: bigint
	maxRefill: bigint
	period: bigint
	balance: bigint
	timestamp: bigint
}

/**
 * What Roles' `AllowanceTracker` would hold at `now` (unix seconds): one
 * `refill` per full elapsed period, only while the balance is below
 * `maxRefill`, never above it. `nextRefillAt` is absent for a one-time budget.
 */
export function accruedAllowance(
	allowance: OnChainAllowance,
	now: bigint,
): { balance: bigint; nextRefillAt?: bigint } {
	if (allowance.period === 0n) return { balance: allowance.balance }
	let balance = allowance.balance
	let timestamp = allowance.timestamp
	if (now >= timestamp + allowance.period) {
		const elapsed = (now - timestamp) / allowance.period
		if (balance < allowance.maxRefill) {
			balance = balance + allowance.refill * elapsed
			if (balance > allowance.maxRefill) balance = allowance.maxRefill
		}
		timestamp = timestamp + elapsed * allowance.period
	}
	return { balance, nextRefillAt: timestamp + allowance.period }
}

/** Roles v2.1.1 `Status`, indexed by its on-chain value. */
const STATUS_MESSAGES: Record<number, string> = {
	2: 'the target contract is not allowed',
	3: 'the function is not allowed on this contract',
	5: 'a parameter is not one of the allowed values',
	7: 'a parameter does not equal the allowed value',
	8: 'a parameter is at or below its allowed minimum',
	9: 'a parameter is at or above its allowed maximum',
	17: 'the amount exceeds the remaining budget',
	18: 'the call limit for this period is used up',
}

/**
 * Plain-language reason for a Roles `ConditionViolation(status, info)`. For the
 * allowance statuses `info` is the allowance key, which `names` maps back to the
 * name the owner typed.
 */
export function describeConditionViolation(
	status: number,
	info: Hex,
	names: ReadonlyMap<string, string>,
): string {
	const base = STATUS_MESSAGES[status] ?? `Roles refused it (status ${status})`
	if (status === 17 || status === 18) {
		const name = names.get(info.toLowerCase())
		return name ? `the "${name}" budget: ${base}` : base
	}
	return base
}
