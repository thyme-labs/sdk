# @thyme-labs/sdk

## 0.5.0

### Minor Changes

- 374c4a6: Add task lifecycle callbacks: `onSuccess`, `onSkip`, `onError`, `onFail`. A task can now react to its own execution outcome (e.g. send an alert on failure, record the tx hash on success) without changing the execution's real status — callbacks are best-effort and never override it. `onSkip`/`onError` run inline alongside `run`; `onSuccess`/`onFail` react to the on-chain outcome once it's known. `ctx.args` is validated/transformed for callbacks exactly like it is for `run`.

  `thyme run` now runs `onSkip`/`onError` locally too, and gains `--simulate-callbacks` to fabricate a receipt and exercise `onSuccess`/`onFail` (including the `stage:'timeout'` case) without a real on-chain submission.

## 0.4.1

### Patch Changes

- Validate and transform task arguments at runtime. `defineTask` now runs `ctx.args` through the task's Zod `schema` (via `safeParseAsync`, so async refinements work) before `run` executes: `z.address()` is checksummed, `.default()` / `z.coerce` are applied, and refinements are enforced — invalid input fails fast with a clear `Invalid task arguments: …` error. Arguments are passed to `run` via prototype delegation so a lazy `ctx.client` is never created eagerly. Docs now use `z.coerce.bigint()` for BigInt arguments (JSON transports them as strings).

## 0.4.0

### Minor Changes

- f4b5eea: Added secrets and storage per task

## 0.3.2

### Patch Changes

- 36206bc: improve simulating

## 0.3.1

### Patch Changes

- 2d63996: added logger support

## 0.3.0

### Minor Changes

- 6716df4: release

### Patch Changes

- 031ffcc: release
