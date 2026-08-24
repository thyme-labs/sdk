# @thyme-labs/cli

CLI for developing and uploading Thyme Web3 automation tasks. Binary: `thyme`.

The CLI scaffolds projects, runs tasks locally in a Deno sandbox, uploads immutable
function releases, and proxies the Thyme Functions management API. The same projects,
executables, profiles, storage, secrets, webhooks, executions, and logs available in
the Console can be managed through typed commands or the raw `thyme api` command.

## Installation

```bash
npm install -g @thyme-labs/cli
```

## Non-interactive use (CI and agents)

Every command runs without a terminal. Prompts are only ever reached when a TTY is
attached and no flag already supplied the value.

```bash
# Either position works
thyme --ci upload my-task -w ws_123abc -p proj_456def --tag v2
thyme upload my-task -w ws_123abc -p proj_456def --tag v2 --ci
```

**Global options** (available on `init`, `new`, `run`, `login`, and `upload`, and on the
root command for every subcommand):

- `--ci` — never prompt. Confirmations are answered yes; any other missing value is an
  immediate error.
- `-y, --yes` — answer confirmations yes but keep the other prompts. Useful on a
  terminal when you only want to skip `Proceed with upload?`.

**Automatic detection.** Non-interactive mode also turns itself on when any of `CI`,
`CONTINUOUS_INTEGRATION`, `THYME_CI`, or `THYME_NON_INTERACTIVE` is set to anything
other than `0`/`false`/`off`/`no`/empty, or when stdin/stdout is not a terminal (a pipe,
a container without a TTY, a subprocess). `--ci` is only needed to force the behaviour
where none of that applies.

**Failure contract.** A missing value exits with **code 2** and a message naming the
flag that supplies it, along with the accepted values:

```
■  A workspace is required when prompts are unavailable (--ci was passed).
│  Pass `--workspace <id>`. Available: ws_123abc (Acme), ws_456def (Acme Staging)
```

Exit code 1 stays reserved for genuine runtime failures (auth, network, a failed task,
a rejected upload), so a script can tell "you forgot a flag" from "it broke".

**Every prompt and its flag:**

| Command | Prompt | Non-interactive path |
| --- | --- | --- |
| `init` | project name | `thyme init <name>` argument |
| `new` | task name | `thyme new <name>` argument |
| `run` | task picker | `thyme run <task>` argument |
| `run --simulate-callbacks` | outcome picker | `--callback <outcome>` |
| `login` | re-authenticate? | answered yes |
| `login --token` | paste API key | piped on stdin |
| `login --rewrite-api-url` | API URL | `--api-url <url>` |
| `upload` | task picker | `thyme upload <task>` argument |
| `upload` | workspace picker | `-w, --workspace <id>` |
| `upload` | project picker | `-p, --project <id>` |
| `upload` | version tag | `-t, --tag <tag>` |
| `upload` | proceed? | answered yes |

`list`, `logout`, `api-url`, `api`, and the management commands never prompt.

Spinners collapse to plain single-line output off a TTY, so CI logs stay readable.

A typical pipeline authenticates through the environment rather than `thyme login`:

```bash
export THYME_AUTH_TOKEN="$THYME_API_KEY"
export THYME_API_URL=https://functions.thymelabs.io/http
thyme upload my-task --ci -w "$THYME_WORKSPACE_ID" -p "$THYME_PROJECT_ID" --tag "v$BUILD_NUMBER"
```

## Commands

### `thyme init [name]`

Initialize a new Thyme project.

```bash
thyme init my-project
cd my-project
npm install
cp .env.example .env
# Edit .env and set SIMULATE_ACCOUNT (plus RPC_URL when the task reads chain state)
```

`name` must match `^[a-z0-9-]+$`, whether it is passed as an argument or entered at the
prompt (you'll be prompted if omitted, unless prompts are unavailable). Creates an empty
`functions/` directory, plus `package.json` (`type: module`, a `dev` script that runs
`thyme run`, deps `@thyme-labs/sdk` + `viem` + `zod`, devDeps `@thyme-labs/cli` +
`typescript`), `tsconfig.json`, `.env.example`, `.gitignore`, and `README.md`. Dependency
versions come from the installed CLI package, keeping a newly generated project on a
compatible SDK and CLI release.

### `thyme new [name]`

Create a new task in the current project.

```bash
thyme new my-task
```

Task names must be lowercase alphanumeric + hyphens, at most 64 characters, with no
path traversal (`..`, `/`, `\`), and cannot be reserved (`node_modules`, `dist`,
`build`, `src`, `lib`). Creates:

- `functions/my-task/index.ts` — task definition (a `defineTask` template)
- `functions/my-task/args.json` — test arguments (`ctx.args` for `thyme run`)
- `functions/my-task/storage.json` — local storage seed (`ctx.storage`)
- `functions/my-task/.env.example` — task-local secret template

The generated task is deliberately inert (`canExec: false`) until you replace its
return value. It can be run and uploaded safely while you build out its logic.

### `thyme run [task]`

Run a task locally in a Deno sandbox.

```bash
# Interactive task picker
thyme run

# Run a specific task
thyme run my-task

# Dry-run the returned calls on-chain
thyme run my-task --simulate

# Persist produced storage back to storage.json
thyme run my-task --persist
```

Requires Deno to be installed (https://deno.land/); the CLI checks `deno --version`
before running. The task executes in a hardened Deno subprocess. Environment is loaded
from the project root `.env` first, then the task-local `functions/<task>/.env`
(task-local values override root values). `SIMULATE_ACCOUNT` is required for every local
run and is exposed to task code as the checksummed `ctx.account`.

**Options:**

- `--simulate` — after `run()` returns `calls`, dry-run them on-chain with viem's
  `simulateCalls` (`eth_simulateV1`). If the RPC doesn't support batch simulation, the
  CLI falls back to per-call `eth_call` + `estimateGas` and warns that dependent-call
  failures can't be detected in fallback mode. Requires `RPC_URL`; the run already
  requires `SIMULATE_ACCOUNT` for `ctx.account`.
- `--persist` — write the produced `ctx.storage` back to `storage.json`. By default the
  produced storage is printed and not written back.
- `--simulate-callbacks` — fabricate a receipt and invoke `onSuccess`/`onFail` locally.
  `thyme run` never submits a call, so there is no real outcome to react to; this picks
  one. On a terminal it shows a picker of the outcomes the task actually defines.
- `--callback <outcome>` — choose that outcome up front instead of picking it, and
  implies `--simulate-callbacks`. One of `onSuccess`, `onFail:reverted`,
  `onFail:submit`, `onFail:timeout`, or `skip`. An outcome the task doesn't define is an
  error listing the ones it does.

```bash
# Exercise onSuccess without a picker
thyme run my-task --callback onSuccess

# Exercise the timeout branch of onFail
thyme run my-task --callback onFail:timeout
```

Output includes the task's logs, the result (`canExec`/`calls`, or the skip
`message`), execution stats (duration, memory, RPC request count), and the produced
storage.

Malformed `args.json` or `storage.json` is a fatal input error. The CLI does not fall
back to `{}`, which ensures `--persist` cannot replace an unreadable local storage seed.

### `thyme list`

List all tasks in the current project. Discovers `functions/<name>/` directories that
contain an `index.ts` and a valid task name. Errors if you are not in a Thyme project.

```bash
thyme list
```

### `thyme login`

Authenticate with Thyme Cloud. Standard login mints a personal API key for uploads;
`--management` mints a separate full-scope key permanently bound to the workspace you
approve. Credentials are saved to `~/.thyme/config.json` (file mode `0600`) — **not**
to `.env`. Revoking a key in
**[Console → API Keys](https://functions.thymelabs.io/dashboard/api-keys)** ends the CLI
session.

```bash
# Browser device flow (default)
thyme login

# Pairing-code flow for headless machines
thyme login --browserless

# Paste an existing API key
thyme login --token

# Consent to full, workspace-bound Functions management access
thyme login --management
```

**Browser flow (default):** the CLI starts a session and opens your browser to
approve. It then polls for the minted key (every 2s, up to 5 minutes).

**Browserless flow (`--browserless`):** the CLI prints a pairing code and a verify URL.
Open the URL on another device and enter the code to approve.

**Token flow (`--token`):** paste an API key you generated in
**[Console → API Keys](https://functions.thymelabs.io/dashboard/api-keys) → Create Key**
(the full key is shown once). The key must be at least 10 characters. Without a terminal
the key is read from stdin instead of prompted, so the key never lands in your shell
history or the process list:

```bash
echo "$THYME_API_KEY" | thyme login --token
```

**Non-interactive runs:** most pipelines should skip `thyme login` entirely and export
`THYME_AUTH_TOKEN` — every later command reads it. If you do need to log in, use
`--token` (as above) or `--browserless`, which prints a pairing code and polls. The
default browser flow fails immediately without a terminal rather than polling for five
minutes for an approval that can't happen.

**Options:**

- `--browserless` — use the pairing-code flow instead of opening a browser.
- `--token` — supply an existing API key instead of using the device flow: prompted on a
  terminal, read from stdin otherwise.
- `--management` — show the Functions scope bundle in the browser, require an
  owner/admin workspace selection, and save a credential bound to that workspace.
- `--api-url <url>` — override the Thyme Cloud API URL for this login (http/https).
- `--rewrite-api-url` — update the stored `apiUrl` in `~/.thyme/config.json`.

After a successful login the CLI verifies the key and prints your user, workspaces, and
projects.

### `thyme logout`

Remove the saved standard auth token, or remove one locally stored management
credential. This does not revoke the server-side key; use Console → API Keys for that.

```bash
thyme logout

# Remove the sole saved management credential
thyme logout --management

# Choose one when several workspace credentials are saved
thyme logout --management --workspace WORKSPACE_ID
```

### `thyme upload [task]`

Upload a task bundle to Thyme Cloud. Requires an auth token (from `thyme login`) and a
resolved API URL.

```bash
# Interactive task + workspace + project picker
thyme upload

# Upload a specific task (prompts for workspace/project)
thyme upload my-task

# Skip the pickers with explicit IDs
thyme upload my-task --workspace ws_123abc --project proj_456def

# Short form
thyme upload my-task -w ws_123abc -p proj_456def

# Explicit immutable version (required for non-interactive repeat uploads)
thyme upload my-task -w ws_123abc -p proj_456def --tag beta

# Fully unattended: no pickers, no confirmation
thyme upload my-task -w ws_123abc -p proj_456def --tag beta --ci
```

**Options:**

- `-w, --workspace <id>` — workspace ID to upload to (skips the interactive prompt).
- `-p, --project <id>` — project ID to upload to (skips the interactive prompt).
- `-t, --tag <tag>` — immutable function version tag (skips the version prompt).
- `--ci` / `-y, --yes` — answer `Proceed with upload?` yes. `--ci` additionally turns a
  missing workspace, project, task, or tag into an error naming the flag rather than a
  prompt.

The CLI fetches your available workspaces and projects from the API and, if the flags
are omitted, walks you through a workspace → project picker. A new function name defaults
to `v1`; an existing name prompts for a tag and suggests the next unused numeric tag.

Tags are canonical lowercase, 1–32 characters, match
`^[a-z0-9][a-z0-9._-]{0,31}$`, and cannot be reused (including after deletion). `latest` is
reserved for the Console's dynamic newest-upload badge. Repeating the same active
name/tag/checksum is idempotent and reuses the existing function ID; reusing a tag with
different code is a conflict.

**Upload pipeline:** esbuild bundles the task to a single ESM file → the Zod schema is
extracted to JSON Schema → `source.ts` + `bundle.js` are zipped with a sha256 checksum
→ the archive is sent as a multipart upload. ZIP metadata is fixed, so unchanged source
and dependencies produce the same checksum and repeating an upload is genuinely
idempotent. The CLI shows a summary and asks for confirmation before uploading.

**Schema extraction:** the `schema` field of your `defineTask()` call is converted to
JSON Schema and stored alongside the code, so the Console can render an arguments form.

```typescript
export default defineTask({
  schema: z.object({
    targetAddress: z.address(),
    amount: z.number(),
  }),
  async run(ctx) {
    // ...
  },
})
```

> **Upload schedules nothing.** After upload, your code shows up in **Console →
> Functions**. Triggers, profile, gas mode, args, and secret bindings are all
> configured in the Console when you assemble an executable from the uploaded function.

### Management commands

Authenticate first with `thyme login --management`. Commands emit JSON and select the
only stored management workspace automatically; pass `--workspace <id>` when several
workspace credentials are stored.

```bash
thyme projects list
thyme functions list --project PROJECT_ID --name price-watcher
thyme executables pause EXECUTABLE_ID
thyme executables set-function EXECUTABLE_ID --function FUNCTION_V2_ID
thyme executables resume EXECUTABLE_ID
thyme executions logs EXECUTION_ID
thyme profiles share PROFILE_ID --project TARGET_PROJECT_ID --alias operator
thyme executables storage-set EXECUTABLE_ID \
  --expected-version 3 --value '{"cursor":1200}'
```

The storage commands read or replace the complete Convex-backed JSON object and
support serialized values up to 16 MiB per management request.

Available groups are `projects`, `chains`, `functions`, `executables`, `executions`,
`profiles`, `secrets`, `webhooks`, and `usage`. Run `thyme <group> --help` for its operations.
Function commands preserve immutable version tags; `set-function` requires a paused
executable and starts an asynchronous atomic sandbox rebuild.

For routes without a dedicated command, use the raw proxy. It accepts only
relative `/api/v1/...` paths and never forwards the credential outside the
management surface:

```bash
thyme api GET '/api/v1/functions?projectId=PROJECT_ID&name=price-watcher'
thyme api PATCH /api/v1/executables/EXECUTABLE_ID/pinned \
  --data '{"pinned":true}'
```

Mutations generate an `Idempotency-Key` automatically and reuse it for a network
retry. Supply `--idempotency-key <key>` to preserve identity across separate CLI
invocations. See the hosted Management API documentation and OpenAPI document for
the wire-level contract.

### `thyme api-url`

Print the resolved Thyme Cloud API URL and where it came from (`env`, `config`, or
`default`).

```bash
thyme api-url
```

## Environment Variables

Create a `.env` file in your project root for CLI/project defaults:

```bash
# RPC URL for blockchain reads and simulation
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/your-key

# Account exposed as ctx.account and used as the sender for --simulate
SIMULATE_ACCOUNT=0x742d35Cc6634C0532925a3b844Bc454e4438f44e

# Cloud API URL (optional; defaults to https://functions.thymelabs.io/http)
THYME_API_URL=https://functions.thymelabs.io/http

# Cloud auth token (config wins; this is a fallback)
THYME_AUTH_TOKEN=your-token

# Force non-interactive mode without passing --ci (0/false/off/no/empty disable it)
THYME_CI=1
```

Notes:

- `RPC_URL` provides the public client in task context (`ctx.client`) and is used for
  `--simulate`.
- The auth token is normally stored in `~/.thyme/config.json` by `thyme login`. For
  later commands the config `authToken` takes precedence over `THYME_AUTH_TOKEN`.
- The API URL resolves in this order: `THYME_API_URL` env → `~/.thyme/config.json`
  `apiUrl` → built-in default (`https://functions.thymelabs.io/http`). Use `thyme api-url`
  to see the resolved value.
- `THYME_CI` and `THYME_NON_INTERACTIVE` (and the standard `CI` /
  `CONTINUOUS_INTEGRATION`) disable prompts — see
  [Non-interactive use](#non-interactive-use-ci-and-agents).

For `thyme run`, the CLI also loads `functions/<task>/.env` after task selection.
Task-local values override root `.env` values for that task and are exposed as
`ctx.secrets`, **except** the reserved keys `THYME_API_URL`, `THYME_AUTH_TOKEN`, and
`RPC_URL`, and `SIMULATE_ACCOUNT`, which are stripped. `SIMULATE_ACCOUNT` can be set in
either root `.env` or `functions/<task>/.env` and becomes `ctx.account` for every local
run.

Task `.env` files are gitignored. Commit `functions/<task>/.env.example` templates
instead.

## Requirements

- Node.js 18+
- Deno (for local task execution)

## License

MIT
