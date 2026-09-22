---
'@thyme-labs/sdk': minor
'@thyme-labs/cli': minor
---

Add optional function permission manifests (`functions/<task>/permissions.json`).

- `compressTask(source, bundle, permissions?)` adds `permissions.json` to the release
  ZIP when given. Without it the archive is unchanged.
- `decompressTask` returns `permissions?: string` with the raw manifest text when the
  archive carries one, and rejects an archive with duplicate `source.ts`, `bundle.js`,
  or `permissions.json` entries.
- `thyme upload` validates `permissions.json` when the task has one and includes it in
  the ZIP. An invalid manifest is a hard error, including under `--ci` and `--yes`.
- `thyme run` validates the manifest and warns about every returned call it does not
  declare, resolving argument targets from `args.json` and the chain id from `RPC_URL`.
- `thyme new` does not scaffold the file; it is opt-in and documented in the CLI README.
