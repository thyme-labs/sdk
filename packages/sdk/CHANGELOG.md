# @thyme-labs/sdk

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
