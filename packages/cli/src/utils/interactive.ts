import { clack, error, pc } from './ui'

/**
 * Interactivity resolution for CI and agent runs.
 *
 * Every prompt in this CLI goes through the wrappers below, so a command can
 * only ever block on a TTY when one is actually attached. When there is no TTY
 * — `--ci`, a CI environment variable, or a piped stdin/stdout — prompts are
 * replaced by either the flag value the caller already passed, an assumed
 * "yes" for confirmations, or a hard error naming the flag to pass instead.
 */

export type NonInteractiveReason = 'flag' | 'env' | 'tty' | null

export interface Interactivity {
	interactive: boolean
	assumeYes: boolean
	reason: NonInteractiveReason
}

export interface InteractivityInput {
	ci?: boolean
	yes?: boolean
	env?: Record<string, string | undefined>
	tty?: boolean
}

/**
 * Environment variables that mark a non-interactive run. `CI` is the de-facto
 * standard (GitHub Actions, GitLab, CircleCI, Buildkite, …); the `THYME_*`
 * variables let a user opt in from anywhere, including agent harnesses that do
 * attach a pseudo-TTY.
 */
const NON_INTERACTIVE_ENV_VARS = [
	'THYME_CI',
	'THYME_NON_INTERACTIVE',
	'CI',
	'CONTINUOUS_INTEGRATION',
] as const

const FALSY_ENV_VALUES = new Set(['', '0', 'false', 'off', 'no'])

export function isNonInteractiveEnv(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return NON_INTERACTIVE_ENV_VARS.some((name) => {
		const value = env[name]
		return value !== undefined && !FALSY_ENV_VALUES.has(value.toLowerCase())
	})
}

/** Pure resolver — the exported state below is just this applied to the process. */
export function resolveInteractivity(input: InteractivityInput): Interactivity {
	const reason: NonInteractiveReason = input.ci
		? 'flag'
		: isNonInteractiveEnv(input.env ?? process.env)
			? 'env'
			: input.tty === false
				? 'tty'
				: null
	const interactive = reason === null
	return {
		interactive,
		assumeYes: input.yes === true || !interactive,
		reason,
	}
}

function currentTty(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

let state: Interactivity = resolveInteractivity({ tty: currentTty() })

/** Called once from the commander `preAction` hook with the merged options. */
export function configureInteractivity(options: {
	ci?: boolean
	yes?: boolean
}): Interactivity {
	state = resolveInteractivity({
		ci: options.ci,
		yes: options.yes,
		tty: currentTty(),
	})
	return state
}

export function getInteractivity(): Interactivity {
	return state
}

export function isInteractive(): boolean {
	return state.interactive
}

export function shouldAssumeYes(): boolean {
	return state.assumeYes
}

export function describeNonInteractive(
	reason: NonInteractiveReason = state.reason,
): string {
	switch (reason) {
		case 'flag':
			return '--ci was passed'
		case 'env':
			return 'a CI environment variable is set'
		case 'tty':
			return 'stdin/stdout is not a terminal'
		default:
			return 'non-interactive mode'
	}
}

export function buildNonInteractiveMessage(
	what: string,
	hint: string,
	reason: NonInteractiveReason = state.reason,
): string {
	return `${what} is required when prompts are unavailable (${describeNonInteractive(reason)}).\n${hint}`
}

/**
 * Exit code 2 marks a usage error — the run is missing input a flag could have
 * supplied — so a script can tell it apart from a genuine runtime failure (1).
 */
export function failNonInteractive(what: string, hint: string): never {
	error(buildNonInteractiveMessage(what, hint))
	process.exit(2)
}

export interface PromptFallback {
	/** What the prompt would have collected, e.g. `A task name`. */
	what: string
	/** How to supply it without a prompt, e.g. ``Pass it as an argument: `thyme run <task>` ``. */
	hint: string
}

function cancelled(): never {
	clack.cancel('Operation cancelled')
	process.exit(0)
}

export async function promptText(
	options: {
		message: string
		placeholder?: string
		initialValue?: string
		defaultValue?: string
		validate?: (value: string) => string | undefined
	},
	fallback: PromptFallback,
): Promise<string> {
	if (!isInteractive()) failNonInteractive(fallback.what, fallback.hint)

	const value = await clack.text({
		message: options.message,
		placeholder: options.placeholder,
		initialValue: options.initialValue,
		defaultValue: options.defaultValue,
		validate: options.validate
			? (input) => options.validate?.(input ?? '')
			: undefined,
	})
	if (clack.isCancel(value)) cancelled()
	return value as string
}

export async function promptPassword(
	options: {
		message: string
		validate?: (value: string) => string | undefined
	},
	fallback: PromptFallback,
): Promise<string> {
	if (!isInteractive()) failNonInteractive(fallback.what, fallback.hint)

	const value = await clack.password({
		message: options.message,
		validate: options.validate
			? (input) => options.validate?.(input ?? '')
			: undefined,
	})
	if (clack.isCancel(value)) cancelled()
	return value as string
}

export async function promptSelect<Value extends string>(
	options: {
		message: string
		options: Array<{ value: Value; label: string }>
	},
	fallback: PromptFallback,
): Promise<Value> {
	if (!isInteractive()) failNonInteractive(fallback.what, fallback.hint)

	// Widen to `string` so clack's conditional `Option<Value>` type resolves;
	// `Value extends string` guarantees the narrowing back on return.
	const value = await clack.select({
		message: options.message,
		options: options.options as Array<{ value: string; label: string }>,
	})
	if (clack.isCancel(value)) cancelled()
	return value as Value
}

/**
 * Confirmations are the one prompt that has a safe default: the caller already
 * asked for the operation. `--yes`, `--ci`, and a missing TTY all answer yes,
 * and the answer is echoed so CI logs still record what was confirmed.
 */
export async function promptConfirm(options: {
	message: string
}): Promise<boolean> {
	if (shouldAssumeYes()) {
		clack.log.info(`${options.message} ${pc.dim('yes (assumed)')}`)
		return true
	}

	const value = await clack.confirm({ message: options.message })
	if (clack.isCancel(value)) cancelled()
	return value === true
}

export interface Spinner {
	start(message?: string): void
	message(message?: string): void
	stop(message?: string): void
}

/**
 * A spinner animates with cursor escapes, which turns CI logs into noise. Off a
 * TTY, fall back to one plain line per state change.
 */
export function spinner(): Spinner {
	if (isInteractive()) return clack.spinner()

	let last = ''
	const write = (message?: string) => {
		if (!message || message === last) return
		last = message
		clack.log.step(message)
	}
	return {
		start: write,
		message: write,
		stop: write,
	}
}
