// Declare console for environments that don't have DOM types
declare const console: {
	log: (...args: unknown[]) => void
}

/**
 * Log entry with type and message
 */
export interface LogEntry {
	type: 'info' | 'warn' | 'error'
	message: string
}

/**
 * Logger for Thyme tasks
 *
 * Use this logger to output messages that will be captured and displayed
 * in the Thyme dashboard. Regular console.log calls will not be captured.
 *
 * @example
 * ```typescript
 * export default defineTask({
 *   schema: z.object({ ... }),
 *   async run(ctx) {
 *     ctx.logger.info('Starting task execution')
 *     ctx.logger.warn('Low balance detected')
 *     ctx.logger.error('Failed to fetch price')
 *     return { canExec: false, message: 'Error occurred' }
 *   }
 * })
 * ```
 */
export class Logger {
	private logs: LogEntry[]
	private static readonly LOG_PREFIX = '__THYME_LOG__'

	constructor() {
		this.logs = []
	}

	/**
	 * Log an info message
	 */
	info(message: string): void {
		this.log('info', message)
	}

	/**
	 * Log a warning message
	 */
	warn(message: string): void {
		this.log('warn', message)
	}

	/**
	 * Log an error message
	 */
	error(message: string): void {
		this.log('error', message)
	}

	private log(type: LogEntry['type'], message: string): void {
		const entry: LogEntry = { type, message }
		this.logs.push(entry)
		// Output with special prefix so it can be captured by the runner
		console.log(`${Logger.LOG_PREFIX}${JSON.stringify(entry)}`)
	}

	/**
	 * Get all collected logs
	 */
	getLogs(): LogEntry[] {
		return [...this.logs]
	}

	/**
	 * Clear all collected logs
	 */
	clear(): void {
		this.logs = []
	}
}

/**
 * Create a new logger instance
 */
export function createLogger(): Logger {
	return new Logger()
}
