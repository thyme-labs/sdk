# @thyme-labs/cli

## 0.9.0

### Minor Changes

- d3cef0d: Make every command usable without a TTY, for CI pipelines and agents.

  - New global `--ci` and `-y, --yes` flags, accepted before or after the subcommand.
    `--ci` never prompts; `--yes` pre-answers confirmations while keeping other prompts.
  - Non-interactive mode is also detected automatically from `CI`,
    `CONTINUOUS_INTEGRATION`, `THYME_CI`, or `THYME_NON_INTERACTIVE`, and from a
    non-TTY stdin/stdout — so piped and containerized runs no longer hang on a
    prompt they cannot answer.
  - When a prompt is unavailable, confirmations (`Proceed with upload?`, `re-authenticate?`)
    are answered yes, and any other missing value fails immediately with exit code 2 and a
    message naming the flag to pass, including the valid values (`--workspace <id>`,
    `--project <id>`, `--tag <tag>`, `--callback <outcome>`, or the positional argument).
  - `thyme run` gains `--callback <onSuccess|onFail:reverted|onFail:submit|onFail:timeout>`
    to pick the simulated outcome up front; it implies `--simulate-callbacks`.
  - `thyme login --token` reads the API key from stdin when there is no terminal
    (`echo "$THYME_API_KEY" | thyme login --token`), and the browser device flow now
    fails fast with alternatives instead of polling for five minutes.
  - Spinners degrade to plain single-line log output off a TTY, so CI logs stay readable.
  - `thyme init <name>` now validates a name passed as an argument with the same rule the
    prompt used, rejecting uppercase names and path separators.
  - New projects now inherit dependency versions from the installed CLI package instead
    of being pinned to obsolete `0.4.0` releases, and their generated task starts inert.
  - `thyme run` now fails on malformed `args.json` or `storage.json` instead of silently
    substituting `{}`; `--persist` can no longer overwrite malformed local storage, and
    input errors are reported before missing runtime dependencies such as Deno.
  - `thyme upload <task>` validates the local task before authentication or remote
    workspace discovery, so typos fail immediately without a network round trip.
  - Upload archives now use deterministic ZIP metadata, so unchanged bundles keep the
    same checksum and same-tag retries reach the backend's idempotent path.

## 0.8.0

### Minor Changes

- 402b7b5: Expose the execution address as `ctx.account`. Cloud runs use the executable profile address, while local runs require `SIMULATE_ACCOUNT` and expose its checksummed value. The field is available in the main run and every lifecycle callback.

### Patch Changes

- Updated dependencies [402b7b5]
  - @thyme-labs/sdk@0.7.0

## 0.7.0

### Minor Changes

- 8f3621e: Add workspace-scoped Functions management commands and a raw management API
  proxy, including multi-workspace credentials, automatic idempotency keys, and
  retry handling for safe requests.

## 0.6.0

### Minor Changes

- b7e7fa4: Add immutable function version tags to `thyme upload`, including automatic `v1`
  defaults, existing-name prompts, `--tag`, local validation, and structured upload
  conflict and idempotency messages.

## 0.5.1

### Patch Changes

- Updated dependencies [513812d]
  - @thyme-labs/sdk@0.6.0

## 0.5.0

### Minor Changes

- 374c4a6: Add task lifecycle callbacks: `onSuccess`, `onSkip`, `onError`, `onFail`. A task can now react to its own execution outcome (e.g. send an alert on failure, record the tx hash on success) without changing the execution's real status — callbacks are best-effort and never override it. `onSkip`/`onError` run inline alongside `run`; `onSuccess`/`onFail` react to the on-chain outcome once it's known. `ctx.args` is validated/transformed for callbacks exactly like it is for `run`.

  `thyme run` now runs `onSkip`/`onError` locally too, and gains `--simulate-callbacks` to fabricate a receipt and exercise `onSuccess`/`onFail` (including the `stage:'timeout'` case) without a real on-chain submission.

### Patch Changes

- Updated dependencies [374c4a6]
  - @thyme-labs/sdk@0.5.0

## 0.4.2

### Patch Changes

- f9d9113: Fix `thyme run --simulate` mislabeling every `eth_simulateV1` error as "RPC does not support batch simulation". The batch path now only falls back to per-call `eth_call` when the RPC genuinely lacks the method (JSON-RPC `-32601` / `MethodNotFoundRpcError`); other failures (reverts, `-32602` fee-validation errors on chains like Polygon, transient node errors) are surfaced instead of silently downgrading to the weaker preview.

## 0.4.1

### Patch Changes

- Fix `thyme run` on Deno 2.x by resolving the project's `node_modules` read-only (`--node-modules-dir=manual`). Improve dev/prod parity: align viem to 2.46.3, make `JSON.stringify` BigInt-safe (function and array replacers), create the public client lazily, raise the local storage limit to 100MB, and warn that `--simulate` does not reproduce production execution. Harden the local sandbox so a task can only read its own folder and `node_modules` (not the whole project). Rework the schema extractor: fix nested-optional detection, comment and regex-literal handling, and `const`-reference resolution ($/type-annotation edge cases), and model `enum`/`union`/`literal`/`tuple`/`record`/`bigint`/`coerce`/`default`; warn when extraction fails. Update the default API URL and scaffold dependency versions.
- Updated dependencies
  - @thyme-labs/sdk@0.4.1

## 0.4.0

### Minor Changes

- f4b5eea: Added secrets and storage per task

### Patch Changes

- Updated dependencies [f4b5eea]
  - @thyme-labs/sdk@0.4.0

## 0.3.7

### Patch Changes

- 56621ee: fix deno

## 0.3.6

### Patch Changes

- **`thyme run` on Deno 2:** pass `--node-modules-dir=auto` (Deno 2 defaults `nodeModulesDir` to `"manual"` when `package.json` exists) and extend `--allow-read` to the Thyme project root so tasks can resolve `viem` and `@thyme-labs/sdk` from repo `node_modules` while `cwd` remains the task directory.

## 0.3.2

### Patch Changes

- 36206bc: improve simulating
- Updated dependencies [36206bc]
  - @thyme-labs/sdk@0.3.2

## 0.3.1

### Patch Changes

- 2d63996: added logger support
- Updated dependencies [2d63996]
  - @thyme-labs/sdk@0.3.1

## 0.3.0

### Minor Changes

- 6716df4: release

### Patch Changes

- 031ffcc: release
- Updated dependencies [031ffcc]
- Updated dependencies [6716df4]
  - @thyme-labs/sdk@0.3.0
