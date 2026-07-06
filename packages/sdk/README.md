# @thyme-labs/sdk

SDK for authoring Web3 automation tasks with Thyme.

You author a **task** as a TypeScript module that exports a `defineTask({ schema, run })`
default. The task's `run(ctx)` reads on-chain and off-chain state and returns either the
calls to execute or a reason to skip — you never sign or send transactions yourself. The
Thyme executor submits the calls when the task runs in the cloud.

## Installation

```bash
npm install @thyme-labs/sdk zod viem
```

## Usage

Create a task with an embedded schema:

```typescript
import { defineTask, z } from '@thyme-labs/sdk'
import { encodeFunctionData } from 'viem'

const abi = [
  {
    name: 'updatePrice',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'price', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'getPrice',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

export default defineTask({
  // Define your arguments schema with type-safe Ethereum addresses
  schema: z.object({
    oracleAddress: z.address(), // Validates and returns viem's Address type
    threshold: z.coerce.bigint().positive(), // coerce: args arrive as JSON strings
  }),

  // Main execution logic
  async run(ctx) {
    const { oracleAddress, threshold } = ctx.args

    // Read from the blockchain using the public client
    const lastPrice = await ctx.client.readContract({
      address: oracleAddress,
      abi,
      functionName: 'getPrice',
    })

    // Your logic here
    const price = await fetchPrice()

    if (price > threshold && price !== lastPrice) {
      return {
        canExec: true,
        calls: [{
          to: oracleAddress,
          data: encodeFunctionData({
            abi,
            functionName: 'updatePrice',
            args: [price],
          }),
        }],
      }
    }

    return {
      canExec: false,
      message: 'Price below threshold or unchanged',
    }
  },
})
```

A task definition is exactly `{ schema, run }`. `run(ctx)` returns either
`{ canExec: true, calls }` (the executor submits the calls) or
`{ canExec: false, message }` (skip, with a reason).

## Schema Validation

The SDK provides an extended Zod instance with Ethereum-specific validators.

### `z.address()`

Validates an Ethereum address and returns viem's `Address` type (checksummed). It
accepts checksummed and all-lowercase addresses and rejects all-uppercase (EIP-55),
missing `0x`, wrong length, and non-hex input.

```typescript
import { defineTask, z } from '@thyme-labs/sdk'

export default defineTask({
  schema: z.object({
    targetAddress: z.address(), // Validates checksum and format
  }),
  async run(ctx) {
    // ctx.args.targetAddress is typed as Address from viem
    return {
      canExec: true,
      calls: [{
        to: ctx.args.targetAddress,
        data: '0x',
      }],
    }
  },
})
```

You can also use standard Zod validators:

```typescript
schema: z.object({
  address: z.address(),
  amount: z.coerce.bigint().positive(),
  enabled: z.boolean(),
  metadata: z.string().optional(),
})
```

On upload, the schema is converted to JSON Schema so the Console can render an arguments
form.

> **BigInt arguments:** task arguments are transported as JSON (which has no BigInt type),
> so a `uint256`/BigInt argument is delivered as a string. Use `z.coerce.bigint()` (not
> `z.bigint()`) so the string is parsed into a real `bigint` before your `run` executes;
> `ctx.args` is validated and transformed against your schema, so `ctx.args.amount` is a
> `bigint` you can do arithmetic with.

## Public Client

The context includes a viem `PublicClient` for **reading** blockchain data. It has no
wallet or signer — you return `Call`s and the Thyme executor submits them.

```typescript
import { defineTask, z } from '@thyme-labs/sdk'

export default defineTask({
  schema: z.object({
    tokenAddress: z.address(),
    threshold: z.coerce.bigint(),
  }),

  async run(ctx) {
    // Read contract state
    const totalSupply = await ctx.client.readContract({
      address: ctx.args.tokenAddress,
      abi: [{
        name: 'totalSupply',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'uint256' }],
      }],
      functionName: 'totalSupply',
    })

    // Get block data
    const blockNumber = await ctx.client.getBlockNumber()
    const block = await ctx.client.getBlock({ blockNumber })

    // Get balance
    const balance = await ctx.client.getBalance({
      address: ctx.args.tokenAddress,
    })

    if (totalSupply > ctx.args.threshold) {
      return {
        canExec: true,
        calls: [/* ... */],
      }
    }

    return {
      canExec: false,
      message: 'Threshold not met',
    }
  },
})
```

Locally, the client is configured from the `RPC_URL` environment variable in your root
`.env`, or a task-local `functions/<task>/.env` (task-local values override root). In
the cloud, the chain is the one bound to the executable's profile.

## Task Secrets

Use `ctx.secrets` to read secrets. There is no explicit declaration API — a secret is
declared implicitly by reading it.

```typescript
export default defineTask({
  schema: z.object({}),

  async run(ctx) {
    const apiKey = ctx.secrets.MY_API_KEY

    // ...
    return { canExec: false, message: 'Not ready' }
  },
})
```

For local runs, put task-specific secrets in `functions/<task>/.env`. The reserved keys
`THYME_API_URL`, `THYME_AUTH_TOKEN`, and `RPC_URL` are not exposed through
`ctx.secrets`. In the cloud, secrets are bound to the executable in the Console and
injected at runtime.

## Task Storage

Use `ctx.storage` for small JSON state that persists across executions of the same
executable. Mutate it in place.

```typescript
export default defineTask({
  schema: z.object({}),

  async run(ctx) {
    ctx.storage.runs = ((ctx.storage.runs as number | undefined) ?? 0) + 1
    ctx.storage.lastCheckedAt = Date.now()

    return { canExec: false, message: 'State updated' }
  },
})
```

`ctx.storage` must be a plain JSON object and is capped at 64KB. Do not put secrets in
storage; use `ctx.secrets` for credentials. Local runs read
`functions/<task>/storage.json` when it exists. By default `thyme run` prints the
produced storage without overwriting the file; pass `--persist` to write it back.

## Lifecycle Callbacks

A task can react to how its own execution turned out by defining any of four optional
callbacks alongside `schema`/`run`: `onSuccess`, `onSkip`, `onError`, `onFail`. All four
run **inside the sandbox**, get the same `ctx` as `run` (with `ctx.args` validated and
transformed the same way), and can use `fetch` (e.g. to notify Telegram/Discord/Slack)
and `ctx.storage`.

```typescript
import { defineTask, z } from '@thyme-labs/sdk'

async function tg(token: string, chat: string, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }),
  })
}

export default defineTask({
  schema: z.object({ vault: z.address() }),
  async run(ctx) {
    /* ... returns { canExec, calls } ... */
    return { canExec: false, message: 'not ready' }
  },

  async onSuccess(ctx, { txHash }) {
    ctx.storage.lastTx = txHash
    await tg(ctx.secrets.TG_TOKEN, ctx.secrets.TG_CHAT, `✅ executed ${txHash}`)
  },
  async onFail(ctx, { stage, reason, txHash }) {
    if (stage === 'timeout') return // outcome unknown — don't alert as a failure
    await tg(
      ctx.secrets.TG_TOKEN,
      ctx.secrets.TG_CHAT,
      `❌ ${stage} failure: ${reason}${txHash ? ` (${txHash})` : ''}`,
    )
  },
})
```

### When each one fires

- **`onSkip(ctx, { message })`** — `run` returned `canExec: false`.
- **`onError(ctx, { error })`** — `run` threw.
- **`onSuccess(ctx, tx)`** — the submitted call(s) were confirmed on-chain. Fires only
  after Convex learns the on-chain result, which happens **after** the sandbox process
  that ran `run` has already exited — so this runs in a **fresh** re-entry into the
  sandbox, not the same process. In-memory state from `run` (local variables, closures)
  is gone; only `ctx` (args/secrets/client/storage) and the payload are available.
  `tx` is `{ txHash, blockNumber, gasUsed, gasCostWei, userOpHash? }`.
- **`onFail(ctx, info)`** — the execution failed *after* being submitted on-chain (as
  opposed to failing before submission — enforcement bails, insufficient gas, and
  similar pre-submit failures never call `onFail`). Also runs in a fresh re-entry, same
  constraints as `onSuccess`. `info.stage` distinguishes three cases:
  - `'reverted'` — the receipt says the tx/userOp reverted; `txHash` is present.
  - `'submit'` — the broadcast/bundler rejected it; it definitely never landed.
  - `'timeout'` — the receipt wait timed out. **The outcome is unknown** — the tx may
    still confirm later. Don't treat this as a confirmed failure (see the example
    above); `txHash`/`userOpHash` are included when already known.

### Best-effort semantics

If a callback itself throws, it's caught and logged to the execution's logs — it can
**never** change the execution's real status (a throwing `onSuccess` doesn't turn a
confirmed execution into a failed one). There's no retry: a callback that performs a
real side effect (like sending a message) should not be retried automatically, since
that could duplicate the side effect.

### Storage rules

`ctx.storage` in a callback always starts from the **last committed** storage — never
from an in-progress run's uncommitted writes.

| Callback    | Sees                                  | Writes persist? |
|-------------|----------------------------------------|:---:|
| `onSkip`    | `run`'s live storage (same process)    | ✅ |
| `onSuccess` | post-run committed storage             | ✅ |
| `onFail`    | pre-run committed storage (the failed run's writes are dropped) | ✅ |
| `onError`   | `run`'s live storage (same process)    | ❌ |

### Local dev (`thyme run`)

`onSkip`/`onError` run locally the same as in the cloud. `onSuccess`/`onFail` need an
on-chain result, which `thyme run` doesn't produce — pass `--simulate-callbacks` to
fabricate a fake receipt and exercise them locally instead.

## Encoding Function Calls

Use viem's `encodeFunctionData` to build the `data` for a `Call`:

```typescript
import { defineTask, z } from '@thyme-labs/sdk'
import { encodeFunctionData } from 'viem'

const abi = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

export default defineTask({
  schema: z.object({
    token: z.address(),
    recipient: z.address(),
  }),

  async run(ctx) {
    return {
      canExec: true,
      calls: [{
        to: ctx.args.token,
        data: encodeFunctionData({
          abi,
          functionName: 'transfer',
          args: [ctx.args.recipient, 1000n],
        }),
      }],
    }
  },
})
```

Viem's `encodeFunctionData` provides full type safety and validation.

## API

### `defineTask(definition)`

Define a Web3 automation task. This is an identity passthrough — its only job is generic
inference so `ctx.args` is typed from your schema.

#### Parameters

- `definition.schema` — Zod schema for validating task arguments.
- `definition.run` — execution function `(ctx) => Promise<TaskResult>` that returns
  whether to execute and which calls to make.

A definition has exactly these two fields.

#### Returns

The task definition (for type inference).

## Types

### `ThymeContext<TArgs>`

Context provided to task execution:

- `args` — user-provided arguments, validated against your schema and typed accordingly.
- `client` — viem `PublicClient` for reading blockchain data (reads only).
- `logger` — logger for task output (`info`/`warn`/`error`); captured to the dashboard.
- `secrets` — `Record<string, string>` of secrets available to the task.
- `storage` — persistent `JsonObject` scoped to this executable.

### `TaskResult`

Result from task execution:

- `{ canExec: true, calls: Call[] }` — execute these calls.
- `{ canExec: false, message: string }` — don't execute, with a reason.

### `Call`

A call to execute on-chain:

- `to` — target contract address (`Address`).
- `data` — encoded function call data (`Hex`).

## Advanced

The package also exports `compressTask` / `decompressTask` (and the related
`CompressResult` / `DecompressResult` types). These power the upload pipeline (zip +
sha256 checksum, with zip-bomb guards on decompress) and are internal — task authors
don't need them.

## License

MIT
