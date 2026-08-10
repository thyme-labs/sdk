import { LIFECYCLE_CALLBACK_NAMES } from './lifecycle'

/** Stable stdout markers shared by local and cloud task runners. */
export const TASK_RUNTIME_OUTPUT_PREFIXES = {
	namespace: '__THYME_',
	log: '__THYME_LOG__',
	result: '__THYME_RESULT__',
	storage: '__THYME_STORAGE__',
	stats: '__THYME_STATS__',
	callbacks: '__THYME_CALLBACKS__',
} as const

const CLOUD_LIFECYCLE_CALLBACKS_SOURCE = `[${LIFECYCLE_CALLBACK_NAMES.map(
	(name) => `'${name}'`,
).join(', ')}]`

/**
 * Deno wrapper uploaded by the Thyme backend next to a compiled `task.js`.
 *
 * This intentionally contains no private application imports or configuration:
 * the backend passes execution inputs through environment variables and the
 * wrapper communicates results through the public protocol constants above.
 */
export const CLOUD_TASK_RUNNER_SOURCE = `
import task from './task.js';
import { createPublicClient, getAddress, http, isAddress } from 'npm:viem@2.46.3';

// BigInt-safe JSON.stringify
const originalStringify = JSON.stringify;
JSON.stringify = (value, replacer, space) => {
  const toStr = (val) => typeof val === 'bigint' ? val.toString() : val;
  if (Array.isArray(replacer)) {
    return originalStringify(value, replacer, space);
  }
  if (typeof replacer === 'function') {
    return originalStringify(value, (key, val) => toStr(replacer(key, val)), space);
  }
  return originalStringify(value, (key, val) => toStr(val), space);
};

class Logger {
  static LOG_PREFIX = '${TASK_RUNTIME_OUTPUT_PREFIXES.log}';

  info(message) {
    console.log(Logger.LOG_PREFIX + JSON.stringify({ type: 'info', message, timestamp: Date.now() }));
  }

  warn(message) {
    console.log(Logger.LOG_PREFIX + JSON.stringify({ type: 'warn', message, timestamp: Date.now() }));
  }

  error(message) {
    console.log(Logger.LOG_PREFIX + JSON.stringify({ type: 'error', message, timestamp: Date.now() }));
  }
}

const phase = Deno.env.get('THYME_PHASE') ?? 'run';

const client = createPublicClient({
  transport: http(Deno.env.get('RPC_URL'))
});

const args = JSON.parse(Deno.env.get('TASK_ARGS') ?? '{}');
const rawAccount = Deno.env.get('THYME_ACCOUNT');
if (!rawAccount || !isAddress(rawAccount)) {
  throw new Error('THYME_ACCOUNT must be a valid Ethereum address');
}
const account = getAddress(rawAccount);

function readSecrets() {
  try {
    const parsed = JSON.parse(Deno.env.get('THYME_SECRETS_JSON') ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Invalid secret JSON should not hide the task's own error handling.
  }
  return {};
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function readStorage() {
  const inputPath = Deno.env.get('THYME_STORAGE_INPUT_PATH');
  const raw = inputPath
    ? await Deno.readTextFile(inputPath)
    : Deno.env.get('THYME_STORAGE_JSON') ?? '{}';
  const parsed = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error('Executable storage must be a JSON object');
  }
  return parsed;
}

const forbiddenStorageKeys = new Set(['__proto__', 'constructor', 'prototype']);

function assertJsonStorage(value, path = '$') {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error('Storage contains an invalid number at ' + path);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === undefined) {
        throw new Error('Storage contains undefined at ' + path + '[' + index + ']');
      }
      assertJsonStorage(value[index], path + '[' + index + ']');
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenStorageKeys.has(key)) {
        throw new Error('Storage contains forbidden key "' + key + '" at ' + path);
      }
      if (item === undefined) {
        throw new Error('Storage contains undefined at ' + path + '.' + key);
      }
      assertJsonStorage(item, path + '.' + key);
    }
    return;
  }
  throw new Error('Storage contains unsupported value at ' + path);
}

async function writeStorageOutput(storageValue) {
  const storageJson = originalStringify(storageValue);
  const outputPath = Deno.env.get('THYME_STORAGE_OUTPUT_PATH');
  if (outputPath) {
    await Deno.writeTextFile(outputPath, storageJson);
  } else {
    console.log('${TASK_RUNTIME_OUTPUT_PREFIXES.storage}' + storageJson);
  }
}

const secrets = readSecrets();
const storage = await readStorage();

const context = {
  account,
  args,
  userArgs: args,
  client,
  logger: new Logger(),
  secrets,
  storage,
};

if (phase === 'callback') {
  const callbackName = Deno.env.get('THYME_CALLBACK');
  const payload = JSON.parse(Deno.env.get('THYME_CALLBACK_PAYLOAD') ?? '{}');
  try {
    if (typeof task[callbackName] !== 'function') {
      throw new Error('Task does not define ' + callbackName);
    }
    await task[callbackName](context, payload);
    if (!isPlainObject(context.storage)) {
      throw new Error('Executable storage must be a JSON object');
    }
    assertJsonStorage(context.storage);
    await writeStorageOutput(context.storage);
  } catch (error) {
    console.error('Callback execution error:', error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
} else {
  const definedCallbacks = ${CLOUD_LIFECYCLE_CALLBACKS_SOURCE}.filter(
    (name) => typeof task[name] === 'function',
  );
  console.log('${TASK_RUNTIME_OUTPUT_PREFIXES.callbacks}' + JSON.stringify(definedCallbacks));

  try {
    const result = await task.run(context);
    if (!isPlainObject(context.storage)) {
      throw new Error('Executable storage must be a JSON object');
    }
    assertJsonStorage(context.storage);

    if (!result.canExec && typeof task.onSkip === 'function') {
      try {
        await task.onSkip(context, { message: result.message ?? '' });
      } catch (callbackError) {
        context.logger.error(
          'onSkip callback threw: ' +
            (callbackError instanceof Error ? callbackError.message : String(callbackError)),
        );
      }
      if (!isPlainObject(context.storage)) {
        throw new Error('Executable storage must be a JSON object');
      }
      assertJsonStorage(context.storage);
    }

    console.log('${TASK_RUNTIME_OUTPUT_PREFIXES.result}' + JSON.stringify(result));
    await writeStorageOutput(context.storage);
  } catch (error) {
    if (typeof task.onError === 'function') {
      try {
        await task.onError(context, {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch (callbackError) {
        context.logger.error(
          'onError callback threw: ' +
            (callbackError instanceof Error ? callbackError.message : String(callbackError)),
        );
      }
    }
    console.error('Task execution error:', error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
`
