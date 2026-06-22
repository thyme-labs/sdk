import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createLogger, Logger } from '../src/logger'

const LOG_PREFIX = '__THYME_LOG__'

afterEach(() => {
	// Restore any console.log spy created within a test.
	;(console.log as unknown as { mockRestore?: () => void }).mockRestore?.()
})

describe('Logger', () => {
	test('createLogger returns a Logger instance', () => {
		expect(createLogger()).toBeInstanceOf(Logger)
	})

	test('collects info / warn / error entries in order', () => {
		const logger = new Logger()
		logger.info('a')
		logger.warn('b')
		logger.error('c')
		expect(logger.getLogs()).toEqual([
			{ type: 'info', message: 'a' },
			{ type: 'warn', message: 'b' },
			{ type: 'error', message: 'c' },
		])
	})

	test('getLogs returns a copy that cannot mutate internal state', () => {
		const logger = new Logger()
		logger.info('a')
		const logs = logger.getLogs()
		logs.push({ type: 'error', message: 'injected' })
		expect(logger.getLogs()).toHaveLength(1)
	})

	test('clear() empties collected logs', () => {
		const logger = new Logger()
		logger.info('a')
		logger.clear()
		expect(logger.getLogs()).toEqual([])
	})

	test('emits each entry to console.log with the capture prefix + JSON', () => {
		const spy = spyOn(console, 'log').mockImplementation(() => {})
		const logger = new Logger()
		logger.info('hello')
		expect(spy).toHaveBeenCalledTimes(1)
		const line = spy.mock.calls[0]?.[0] as string
		expect(line.startsWith(LOG_PREFIX)).toBe(true)
		expect(JSON.parse(line.slice(LOG_PREFIX.length))).toEqual({
			type: 'info',
			message: 'hello',
		})
	})

	test('serialises messages containing newlines/quotes safely as JSON', () => {
		const spy = spyOn(console, 'log').mockImplementation(() => {})
		const logger = new Logger()
		const tricky = 'line1\nline2 "quoted" \t tab'
		logger.error(tricky)
		const line = spy.mock.calls[0]?.[0] as string
		expect(JSON.parse(line.slice(LOG_PREFIX.length)).message).toBe(tricky)
	})
})
