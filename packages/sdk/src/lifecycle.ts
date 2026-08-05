/** Lifecycle hooks supported by every Thyme task runtime. */
export const LIFECYCLE_CALLBACK_NAMES = [
	'onSuccess',
	'onSkip',
	'onError',
	'onFail',
] as const

export type LifecycleCallbackName = (typeof LIFECYCLE_CALLBACK_NAMES)[number]

export function isLifecycleCallbackName(
	value: string,
): value is LifecycleCallbackName {
	return (LIFECYCLE_CALLBACK_NAMES as readonly string[]).includes(value)
}

export function normalizeLifecycleCallbackNames(
	callbacks: readonly string[],
): LifecycleCallbackName[] {
	return callbacks.filter(isLifecycleCallbackName)
}
