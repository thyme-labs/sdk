<div align="center">

<a href="https://thymelabs.io"><img src=".github/assets/logo.svg" width="72" height="72" alt="Thyme"></a>

# Thyme Flow SDK & CLI

**Onchain automation that runs from your own Safe.**<br>
Write a TypeScript task, test it locally, and run it on a cron, an interval or a webhook.

[![@thyme-labs/sdk](https://img.shields.io/npm/v/@thyme-labs/sdk?label=%40thyme-labs%2Fsdk&color=22C77E)](https://www.npmjs.com/package/@thyme-labs/sdk)
[![@thyme-labs/cli](https://img.shields.io/npm/v/@thyme-labs/cli?label=%40thyme-labs%2Fcli&color=22C77E)](https://www.npmjs.com/package/@thyme-labs/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-0B130F)](#license)

[Website](https://thymelabs.io) · [Console](https://flow.thymelabs.io/dashboard) · [Docs](https://flow.thymelabs.io/docs) · [Quickstart](https://flow.thymelabs.io/docs/getting-started/quickstart)

</div>

> **Thyme is live in production.** Flow, Gate and Atlas are open to everyone, with a free
> monthly allowance on each. [Create a workspace →](https://thymelabs.io/dashboard)

## How it works

1. **Write a task.** A TypeScript module reads on-chain and off-chain state and returns the
   calls to make, or a reason to skip. Task code never signs or sends transactions.
2. **Run it locally.** `thyme run` executes the task in a Deno sandbox. Add `--simulate` to
   check the returned calls against the chain.
3. **Upload and schedule.** `thyme upload` publishes an immutable release. In the console you
   attach a trigger (cron, interval or webhook), a profile, args and secrets.
4. **It runs from your Safe.** A Roles profile executes through a Zodiac Roles allowlist on a
   Safe you own, with gas sponsored. The executor can only call the contracts and functions
   you listed, and you revoke it by removing the role or module.

```typescript
import { defineTask, z } from '@thyme-labs/sdk'
import { encodeFunctionData, parseAbi } from 'viem'

const abi = parseAbi([
  'function pendingRewards() view returns (uint256)',
  'function harvest()',
])

export default defineTask({
  schema: z.object({
    vault: z.address(),
    minRewards: z.coerce.bigint(),
  }),

  async run(ctx) {
    const { vault, minRewards } = ctx.args
    const pending = await ctx.client.readContract({
      address: vault,
      abi,
      functionName: 'pendingRewards',
    })

    if (pending < minRewards) {
      return { canExec: false, message: `Only ${pending} pending` }
    }

    return {
      canExec: true,
      calls: [{ to: vault, data: encodeFunctionData({ abi, functionName: 'harvest' }) }],
    }
  },
})
```

## Quick Start

```bash
# Install CLI globally
npm install -g @thyme-labs/cli

# Create new project
thyme init my-project

# Create a task
cd my-project
thyme new my-task

# Run locally
thyme run my-task

# Simulate on-chain
thyme run my-task --simulate

# Authenticate, then upload your code to the cloud
thyme login
thyme upload my-task
```

After `thyme upload`, your code appears in the [Flow console](https://flow.thymelabs.io/dashboard).
Upload only puts the code in the cloud — it does not schedule anything. Triggers, profile,
gas mode, args, and secret bindings are configured in the console when you assemble an
executable from the uploaded function.

## Coming from Gelato, Defender or Chainlink Automation?

Gelato Web3 Functions, OpenZeppelin Defender and Chainlink Automation were all retired in
2026. A Flow task has the same shape, so most ports are mechanical:

| You had | In Flow |
| --- | --- |
| Gelato `Web3Function.onRun` returning `{ canExec, callData }` | `defineTask({ run })` returning `{ canExec, calls }` |
| Defender Action + Relayer | Task + Roles profile on your own Safe |
| Chainlink `checkUpkeep` / `performUpkeep` | `run` reads the state, and the returned `calls` are executed |
| Gelato or Defender secrets | Console secrets bound to the executable |

There is no native event or log trigger: poll the state you need from the task and keep a
cursor in storage. See [triggers](https://flow.thymelabs.io/docs/concepts/triggers) and
[profiles](https://flow.thymelabs.io/docs/concepts/profiles). Stuck on a port? Email
[support@thymelabs.io](mailto:support@thymelabs.io) and we'll help.

## The Thyme platform

| Product | What it does |
| --- | --- |
| **[Flow](https://flow.thymelabs.io)** | Onchain automation from your Safe (this repo) |
| **[Gate](https://gate.thymelabs.io)** | RPC endpoints for mainnets and testnets |
| **[Atlas](https://atlas.thymelabs.io)** | Managed subgraph hosting and queries |

## Packages

- **[@thyme-labs/sdk](./packages/sdk)** - SDK for authoring Web3 tasks
- **[@thyme-labs/cli](./packages/cli)** - CLI for local development and deployment

## Development

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Run tests
bun run test

# Format code
bun run format
```

## License

MIT
