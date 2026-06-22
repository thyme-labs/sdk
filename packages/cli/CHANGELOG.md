# @thyme-labs/cli

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
