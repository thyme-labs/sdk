---
'@thyme-labs/sdk': minor
'@thyme-labs/cli': minor
---

Add `ctx.trigger`, which says what started a run: `cron`, `interval`, `manual`, `webhook` (with its name), or `event` for onchain event triggers.

- Event runs carry the triggering log (`blockNumber` as a `bigint`), its block timestamp in unix seconds, and the event's name, signature and decoded `args`. `ctx.trigger` is optional and is `undefined` on runners that predate triggers. Lifecycle callbacks see the same value as `run`.
- New helpers `isEventTrigger(ctx)` and `decodeTriggerEvent(ctx, abiEvent)`, which decodes the log with typed viem arguments and returns `null` when the run was not started by an event or the log does not match.
- `thyme run` builds `ctx.trigger` the same way as the cloud. It defaults to `{ type: 'manual' }`. `--event-tx <hash>` replays a real log read through `RPC_URL`, picked with `--log-index <n>` or `--event-signature <sig>`, and `--event <file>` loads a saved event payload. The trigger also reaches callbacks run with `--simulate-callbacks`.
- `THYME_TRIGGER_JSON` is now a reserved key and is no longer exposed through `ctx.secrets` in local runs.
