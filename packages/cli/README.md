# @thyme-labs/cli

CLI for developing and deploying Thyme Web3 automation tasks.

## Installation

```bash
npm install -g @thyme-labs/cli
```

## Commands

### `thyme init [name]`

Initialize a new Thyme project.

```bash
thyme init my-project
cd my-project
npm install
```

### `thyme new [name]`

Create a new task in the current project.

```bash
thyme new my-task
```

Creates:
- `functions/my-task/index.ts` - Task definition
- `functions/my-task/args.json` - Test arguments
- `functions/my-task/.env.example` - Task-local secret template

### `thyme run [task]`

Run a task locally in a Deno sandbox.

```bash
# Interactive task picker
thyme run

# Run specific task
thyme run my-task

# Run with on-chain simulation
thyme run my-task --simulate
```

Requires Deno to be installed: https://deno.land/

### `thyme list`

List all tasks in the current project.

```bash
thyme list
```

### `thyme login`

Authenticate with Thyme Cloud.

```bash
thyme login
```

Opens your browser to generate an API token, then saves it to `.env`.

### `thyme upload [task]`

Upload a task to Thyme Cloud.

```bash
# Interactive task and organization picker
thyme upload

# Upload specific task (will prompt for organization)
thyme upload my-task

# Upload to specific organization
thyme upload my-task --organization org_123abc

# Short form
thyme upload my-task -o org_123abc
```

**Options:**
- `-o, --organization <id>` - Organization ID to upload to (skips interactive prompt)

**Schema Extraction:**
When uploading, the CLI automatically extracts the Zod schema from your task definition and converts it to JSON Schema. This allows the frontend dashboard to generate forms for users to input task arguments.

The schema is extracted from the `schema` field in your `defineTask()` call:

```typescript
export default defineTask({
  schema: z.object({
    targetAddress: z.address(),
    amount: z.number(),
  }),
  async run(ctx) {
    // ...
  }
})
```

The extracted JSON Schema is stored in the database alongside the task code, enabling dynamic form generation in the UI.

## Environment Variables

Create a `.env` file in your project root for CLI/project defaults:

```bash
# RPC URL for blockchain reads and simulation
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/your-key

# Simulation settings (for --simulate flag)
SIMULATE_ACCOUNT=0x742d35Cc6634C0532925a3b844Bc454e4438f44e

# Cloud authentication (set by `thyme login`)
THYME_AUTH_TOKEN=your-token

# Cloud API URL (required - your Convex deployment URL)
# Example: https://your-deployment.convex.cloud
THYME_API_URL=https://your-deployment.convex.cloud
```

**Note:** 
- `RPC_URL` is used for:
  - Providing the public client in task context (`ctx.client`)
  - Running on-chain simulations with `--simulate` flag
- `THYME_API_URL` should be set to your Convex deployment URL (found in your Convex dashboard or `.env.local` file as `VITE_CONVEX_URL`)

For `thyme run`, the CLI also loads `functions/<task>/.env` after task
selection. Task-local values override root `.env` values for that task and are
available as `ctx.secrets`, except reserved project keys such as
`THYME_API_URL`, `THYME_AUTH_TOKEN`, and `RPC_URL`. `SIMULATE_ACCOUNT` can be set
in either root `.env` or `functions/<task>/.env` for `thyme run --simulate`.

Task `.env` files are gitignored. Commit `functions/<task>/.env.example`
templates instead.

## Requirements

- Node.js 18+
- Deno (for local task execution)

## License

MIT
