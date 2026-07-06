# Plan: Lifecycle callbacks (`onSuccess` / `onSkip` / `onError` / `onFail`) for thyme-sdk

Add task-authored lifecycle callbacks to `@thyme-labs/sdk` so a task can react to its
own execution outcome (e.g. ping a Telegram bot on failure, record the tx hash on
success). Callbacks execute **inside the Daytona sandbox**, never in Convex.

> All file/line references verified against `thyme-sdk` and `../app` on 2026-07-01,
> re-checked on 2026-07-03 (see corrections below — `mutation/executions.ts` shifted
> +14 lines from an unrelated same-day commit adding `lib/executionErrors.ts`).

---

## Status (as of 2026-07-05)

**Done — `thyme-sdk` repo only** (Phase 1 in full, plus the `thyme-sdk`-repo slice of
Phase 5). Working tree changes, not yet committed.

| Item | State |
|---|---|
| Phase 1 — SDK contract (`types.ts`, `task.ts`, `index.ts`, README, tests, changeset) | ✅ Done — see "Phase 1" below for what shipped vs. what changed from plan |
| Phase 5 — local runner: inline `onSkip`/`onError`, `definedCallbacks` probe | ✅ Done (`packages/cli/src/deno/runner.ts`) |
| Phase 5 — `thyme run --simulate-callbacks` | ✅ Done (`packages/cli/src/commands/run.ts`, `runCallbackInDeno`) |
| Phase 5 — upload-time static badge in Console, sandbox-regeneration migration | Not started (optional/cosmetic, `../app`-side) |
| Phase 2 — sandbox wrapper protocol (`../app`) | Not started |
| Phase 3 — Convex orchestration (`../app`) | Not started |
| Phase 4 — bundler revert-detection fix (`../app`) | Not started |

**Bug found and fixed along the way (not in original plan):** the CLI's `runInDeno`
silently dropped all `stdout` output whenever a task failed — only `stderr` became the
error message, so `result.logs` was always `[]` on failure. Harmless before (nothing ran
after a throw), but `onError` exists specifically to run code after a throw, so its own
`ctx.logger` calls would have vanished from `thyme run` output. Fixed in both
`runInDeno` and `runCallbackInDeno`: stdout is now parsed for log lines on the failure
path too (still excluding `__THYME_*` control lines).

**Test coverage:** `packages/sdk` is at 100% and enforced (`bunfig.toml`
`coverageThreshold = 1.0`). `packages/cli` has no coverage floor; `commands/run.ts`
(including the new `simulateCallbacksFlow`) is exercised only by a manual smoke test
against a real `defineTask`-wrapped fixture, not by the unit suite — `runner.ts`'s new
code (inline callbacks, `runCallbackInDeno`) does have real Deno-integration tests
(`test/runner.test.ts`, 11 new cases).

**Verified live** (manual smoke test, not part of `bun test`): a fixture project using
the built `@thyme-labs/sdk` package with a `defineTask` task defining all four
callbacks — confirmed the checksum transform reaches `onSuccess`/`onFail`, `onFail`
starts from pre-run storage while preserving prior keys, `onSuccess` commits its
storage write, inline `onSkip` fires and persists, and invalid args reject before a
callback body runs (same SDK error message as `run`).

---

## Locked design decisions

| Decision | Choice |
|---|---|
| Post-submit execution model | **Two-tier re-entry.** `onError`/`onSkip` run inline in the first sandbox pass (no txHash needed). `onSuccess`/`onFail` run in a **second Daytona re-entry** after Convex resolves the on-chain result — only when the task defines them. |
| Callback taxonomy | **4 callbacks, one `onFail`** with a `stage` discriminator (`'reverted' \| 'submit' \| 'timeout'`). |
| A callback itself throws | **Best-effort:** caught, logged to execution logs, **never** changes the execution's real status. |
| Failure scope | **Sandbox-observable only.** Pre-run failures (no subscription, gas, chain-ineligible, sandbox infra) do **not** fire `onFail`. Gate: `onFail` fires only when the execution failed **from the `submitted` status** (see Phase 3). |
| Phase-2 compute | Billed as part of the execution's compute CU (real Daytona compute). |
| Storage visibility | **Callbacks always see the last *committed* storage** (see "Storage rules"). `onError` writes are never persisted. |

---

## Why callbacks can't just "run where `run` ran"

The pipeline is sequential across two machines:

1. **Daytona** runs `task.run(ctx)` → returns `{ canExec, calls }` → **the sandbox process exits.**
2. **Convex** submits the calls on-chain via the bundler and only *then* learns the
   `txHash` and success/revert (`lib/bundler.ts` `submitCalls` → receipt).

So `onSuccess(ctx, tx)` cannot run in the process that held `ctx` — that process is
already dead by the time the txHash exists. To honor "execute in Daytona," Convex must
**re-enter the sandbox a second time**, passing the tx result in, and the wrapper calls
`task.onSuccess(ctx, payload)` there.

Natural split:
- `onError` (run threw) and `onSkip` (`canExec:false`) are known **while the sandbox is
  still alive** → run inline, zero extra round-trip.
- `onSuccess` / `onFail` need the on-chain outcome → require the **second re-entry**,
  gated on whether the task actually defines them (runtime probe, Phase 2).

Good news on latency: `autoStopInterval` is in **minutes**, not seconds — 30 min at
initial provisioning (`lib/sandbox.ts:259`), 780 min (13 h) after regeneration
(`action/sandbox.ts:136-139`). The receipt wait is 60–150 s
(`SELF_PAID_RECEIPT_TIMEOUT_MS = 150_000`, self-funded 120 s, sponsored 60 s), so
phase 2 almost always re-enters a **still-running** sandbox — no restart penalty.
`ensureStarted` (`lib/sandbox.ts:314`) covers the rare stopped/archived case.

---

## The callback contract (SDK-facing shape)

```typescript
// types.ts — TaskDefinition gains 4 optional fields
interface TaskDefinition<TSchema> {
  schema: TSchema
  run: (ctx: ThymeContext<z.infer<TSchema>>) => Promise<TaskResult>
  onSuccess?: (ctx: ThymeContext<z.infer<TSchema>>, tx: SuccessPayload) => Promise<void> | void
  onSkip?:    (ctx: ThymeContext<z.infer<TSchema>>, info: SkipPayload)  => Promise<void> | void
  onError?:   (ctx: ThymeContext<z.infer<TSchema>>, info: ErrorPayload) => Promise<void> | void
  onFail?:    (ctx: ThymeContext<z.infer<TSchema>>, info: FailPayload)  => Promise<void> | void
}

type SuccessPayload = {
  txHash: string
  blockNumber: number
  gasUsed: string        // BundlerResult.actualGasUsed
  gasCostWei: string     // useful + already available; costs nothing to include
  userOpHash?: string    // absent for raw self-paid txs
}
type SkipPayload  = { message: string }   // run() returned canExec:false ('' if none given)
type ErrorPayload = { error: string }     // run() threw
type FailPayload  = {
  // 'reverted' — receipt says the tx/userOp reverted (txHash present)
  // 'submit'   — broadcast/bundler rejected it (definitely never landed)
  // 'timeout'  — receipt wait timed out: OUTCOME UNKNOWN, the tx may still land.
  //              txHash/userOpHash provided when known (persisted pre-receipt).
  stage: 'reverted' | 'submit' | 'timeout'
  reason: string         // redacted userMessage shown in the dashboard — see
                          // the sanitizeExecutionError parity note in Phase 3
  txHash?: string
  userOpHash?: string
}
```

`stage: 'timeout'` exists because a receipt timeout is **not** proof of failure — the
self-paid/self-funded paths persist the hash pre-receipt precisely because the tx can
confirm after the wait gives up (`bundler.ts:924-948`). Telling the task "it failed"
when it may have succeeded would make e.g. a retry-on-fail handler double-spend.

Callback `ctx` is the **same** `ThymeContext` (`args`, `client`, `logger`, `secrets`,
`storage`) — `args` re-validated/transformed by the SDK wrapper, `client` live (RPC_URL
is passed to phase 2 too), `secrets` identical. `--allow-net` is on in the cloud
sandbox, so `fetch('https://api.telegram.org/...')` works from any callback.

Example task:

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
  async run(ctx) { /* ... returns { canExec, calls } ... */ },

  async onSuccess(ctx, { txHash }) {
    ctx.storage.lastTx = txHash
    await tg(ctx.secrets.TG_TOKEN, ctx.secrets.TG_CHAT, `✅ executed ${txHash}`)
  },
  async onFail(ctx, { stage, reason, txHash }) {
    if (stage === 'timeout') return // outcome unknown — don't alert as a failure
    await tg(ctx.secrets.TG_TOKEN, ctx.secrets.TG_CHAT,
      `❌ ${stage} failure: ${reason}${txHash ? ` (${txHash})` : ''}`)
  },
})
```

---

## Phase 1 — SDK (`packages/sdk`) — ✅ Done

| File | Change |
|---|---|
| `src/types.ts` | ✅ Added the 4 optional callback fields + `SuccessPayload`/`SkipPayload`/`ErrorPayload`/`FailPayload`, placed just above `TaskDefinition`. |
| `src/task.ts` | ✅ `defineTask` factors validation into one `withValidatedArgs<R, Ret>` closure (shared by `run` and every defined callback) and spreads callback keys **conditionally** (`...(onSuccess ? { onSuccess: withValidatedArgs(onSuccess) } : {})`, etc.) so an omitted callback is truly absent, not `undefined`. |
| `src/index.ts` | ✅ Exports the 4 payload types (alphabetized alongside the existing exports). |
| `README.md` | ✅ New "Lifecycle Callbacks" section: the 4 hooks, two-tier timing, best-effort semantics, storage-rules table, local-dev note pointing at `--simulate-callbacks`. |
| `test/task.test.ts` | ✅ 5 new tests under a `describe('lifecycle callbacks')` block: absent-stays-absent, payload passthrough for all 4 hooks, checksum-transform parity with `run`, invalid-args rejection before the callback body runs. |
| `.changeset/` | ✅ `callback-lifecycle-hooks.md` — **minor** for both `@thyme-labs/sdk` and `@thyme-labs/cli` (bundled since the CLI's local-runner work shipped in the same pass). |

**Backward compatible** — `defineTask({ schema, run })` alone still type-checks. Verified: `npx tsc --noEmit`, `bun test` (44/44, 100% coverage on `task.ts`), `biome check`, and `tsup` build all clean.

> ⚠️ Parity trap: `defineTask` is documented as an "identity passthrough" but it actually
> wraps `run` to inject validation. Callbacks must get the **same** wrapping, or `ctx.args`
> in a callback would be raw JSON (un-checksummed addresses) while `ctx.args` in `run` is
> transformed. Use the same `Object.create(ctx)` delegation as `task.ts:92` — a spread
> eagerly triggers the local runner's lazy `get client()` and breaks client-less tasks.
> Factor the validate-and-rewrap logic into one helper shared by `run` and all callbacks.
>
> ✅ Resolved as planned, with one TS wrinkle: `withValidatedArgs`'s generic `Ret` can't
> be structurally proven assignable to `Awaited<Ret>` when unconstrained, so the
> implementation does `return (await fn(next, ...rest)) as Awaited<Ret>` — a deliberate,
> safe cast (see the comment in `task.ts`), not a type-safety gap.

---

## Phase 2 — Sandbox wrapper protocol (`app/backend/convex/lib/sandbox.ts`, `WRAPPER_CODE`)

The wrapper is a static string uploaded at provisioning (`createSandbox` → `wrapper.js`,
`lib/sandbox.ts:56-195`). Make it **phase-dispatched** on a new `THYME_PHASE` env var:

- **`THYME_PHASE=run`** (current path):
  1. Validate args, run `task.run(ctx)` as today.
  2. **New:** emit `__THYME_CALLBACKS__["onSuccess","onFail"]` — a runtime `typeof`
     probe of the module — so Convex knows whether to schedule phase 2. Emit it
     *before* invoking `run` so it survives the error path too.
  3. **New:** if run returns `canExec:false` and `task.onSkip` exists →
     `await task.onSkip(ctx, { message: result.message ?? '' })` (try/catch → log
     line, never abort) **before** the storage output is written, so onSkip's
     storage writes are captured by the existing skip-path commit.
  4. **New:** in the wrapper `catch` (run threw), if `task.onError` exists →
     `await task.onError(ctx, { error })` (try/catch) **before** `Deno.exit(1)`.
     No storage output is written on this path — matches today's semantics.
- **`THYME_PHASE=callback`** (new path): read `THYME_CALLBACK` (`onSuccess`|`onFail`)
  + `THYME_CALLBACK_PAYLOAD` (JSON) + the storage input file, rebuild `ctx` exactly
  like the run phase (args/client/secrets/storage), invoke `task[name](ctx, payload)`,
  then emit logs + write the storage output file the same way `run` does. No
  `__THYME_RESULT__` line is emitted.

> ⚠️ Deno permission gotcha: `runInSandbox` builds `--allow-env` from exactly the env
> keys it injects (`lib/sandbox.ts:421-423`), and `Deno.env.get()` on an **unlisted**
> var *throws* (NotCapable), it doesn't return undefined. So `THYME_PHASE` must be
> **explicitly set in both phases** (`THYME_PHASE=run` in `runInSandbox`,
> `THYME_PHASE=callback` in the new path) — the wrapper must never probe an env var
> that isn't guaranteed to be in the allow-list.

`parseOutput` (`lib/sandbox.ts:200`) gains a `__THYME_CALLBACKS__` prefix →
`RunSandboxOutput.definedCallbacks: string[]`. In callback phase, the missing
`__THYME_RESULT__` line is fine — `parseOutput` already defaults the result.

Phase 2 is a **fresh process** — in-memory state from `run` is gone; the callback only
sees `ctx` (args/secrets/client) + committed `storage`. Document this.

---

## Phase 3 — Convex orchestration (`action/execution.ts`, `lib/sandbox.ts`)

1. **`lib/sandbox.ts`:** add `runCallbackInSandbox(sandboxId, callback: {name, payload},
   args, envVars, rpcUrl, timeoutMs, redact, storage)` — **full `runInSandbox` parity**
   (the callback ctx needs `TASK_ARGS`, `RPC_URL`, and `THYME_SECRETS_JSON` just like the
   run phase; all are still in scope in `triggerExecution`, no re-resolution needed),
   plus `THYME_PHASE=callback`, `THYME_CALLBACK`, `THYME_CALLBACK_PAYLOAD`. Share the
   storage-file + redaction plumbing with `runInSandbox` rather than duplicating it.
   Timeout: 30 s like phase 1. No `withRetry` around user code — retrying a
   user-visible side effect (a sent Telegram message) is worse than dropping it.

2. **`action/execution.ts` (`triggerExecution`):**
   - Hoist `sandboxResult` so `definedCallbacks` is visible in the `catch` block.
   - `onSkip`/`onError` need nothing here — the wrapper already ran them; their log
     lines flow back through the existing `insertLogs` (`execution.ts:724-734`).
   - **`onSuccess`** — after `completeExecution` (`execution.ts:1041`) and the storage
     commit (`execution.ts:1058`), if `definedCallbacks` includes `onSuccess`: call
     `runCallbackInSandbox` with the success payload, passing the **post-run storage**
     (`nextStorage.value`) as input and committing the callback's storage output with
     `expectedVersion` = the version returned by the run's commit. Wrapped in its own
     try/catch → log only; on `SandboxInfraError` also schedule
     `regenerateSandboxAction` (the existing infra-error handler at `execution.ts:1178`
     is unreachable from here because the confirmed-status guard returns first).
     Insert this **before** the CU metering (see billing below).
   - **`onFail`** — in the failure `catch` (`execution.ts:1135`), **after**
     `updateExecutionStatus(failed)` has secured the terminal state: fire when
     `definedCallbacks` includes `onFail` **and** the execution failed *from the
     `submitted` status* (`execution.status === 'submitted'` read at `execution.ts:1136`).
     That single gate cleanly excludes everything pre-submit: enforcement bails,
     dBank-gate blocks, sandbox infra errors, and task-threw errors all fail from
     earlier statuses. Stage: `'reverted'` for the typed `OnChainExecutionError`
     (Phase 4), `'timeout'` for receipt-wait timeouts, `'submit'` otherwise; `reason` =
     the redacted `userMessage` from `splitUserOpErrorForDisplay`. Storage input =
     the **last committed** storage (`currentStorage.value` — see Storage rules);
     commit the callback's output with `expectedVersion = storageVersion`.

     > ⚠️ Redaction parity gap (surfaced 2026-07-03): `updateExecutionStatus`
     > (`mutation/executions.ts`) now also runs `errorMessage`/`errorDetailsRaw`
     > through `sanitizeExecutionError` (`lib/executionErrors.ts`) — a second,
     > newer redaction layer (strips gas-policy UUIDs, rewrites infra-outage
     > messages) that `splitUserOpErrorForDisplay` alone doesn't apply. Route
     > `onFail.reason` through `sanitizeExecutionError` too (or reuse whatever
     > `updateExecutionStatus` computed for this same failure) so the task never
     > sees an internal detail the dashboard would have redacted.
     >
     > Also decide explicitly whether `onFail`'s re-entry needs the same
     > `SandboxInfraError` → `regenerateSandboxAction` handling the `onSuccess`
     > bullet above calls out — as written, that handling is only specified for
     > `onSuccess`.
   - Both re-entries run **while the execution storage lock is still held** (released
     in the `finally` at `execution.ts:1188`), so no interleaved run can move the
     storage version underneath the callback — the commits above are deterministic,
     not best-effort OCC.

3. **Billing** (locked: phase-2 compute is billed as compute CU):
   - `recordCuUsage` uses `executionId` as the Stripe idempotency key
     (`execution.ts:277-285`) — a **second** report for the same execution would be
     silently deduplicated. For `onSuccess`, fold the callback's `durationMs` into the
     *single* existing report (run it before `recordCuUsage`, meter
     `completion.computeCuMs + cbDurationMs`). For `onFail` there is no existing
     report (failures bill nothing today) — report the callback CU separately with
     `identifier: \`${executionId}:cb\`` (precedent: `\`${executionId}:rpc\`` at
     `execution.ts:329`).

4. **Watchdog gap (document):** executions reaped by `failStaleExecutions`
   (`mutation/executions.ts:401` — a mutation, can't reach Daytona) never fire
   `onFail`. Acceptable: the watchdog only catches actions that died mid-flight.
   Optionally have it schedule a callback action later; not in v1.

---

## Phase 4 — Make reverts observable (`app/backend/convex/lib/bundler.ts`)

Prerequisite for `onFail(stage:'reverted')` **and** a latent correctness fix:

- **Self-paid** already checks `receipt.status !== 'success'` (`bundler.ts:950`) — but
  throws a plain `Error`. Normalize to a typed
  `OnChainExecutionError { stage:'reverted', txHash, userOpHash?, gasCostWei, blockNumber }`.
- **Sponsored (Pimlico `bundler.ts:470-483`, Alchemy `545-558`) and self-funded
  (`706-719`)** ERC-4337 paths **do not check the UserOp receipt's `success` field** —
  a reverted op is currently recorded as a *success* (and billed as confirmed). Add the
  check; throw the same typed error carrying `receipt.receipt.transactionHash` and
  `receipt.actualGasCost`.
- `execution.ts` reads the typed error to build the `onFail` payload precisely instead
  of string-matching.

**Billing/persistence consequences of the fix** (the gas *was* spent even though the op
reverted — routing these runs to the failure path must not lose that):

- In the catch, on `OnChainExecutionError`: call `recordSubmittedTx`
  (`mutation/executions.ts:192` — accepts `txHash`/`userOpHash`) so the failed
  execution row still shows its tx. (Self paths already persist pre-receipt; the
  **sponsored** paths never persist the hash before the receipt wait, so without this
  a reverted sponsored run would show "failed" with no tx to inspect.)
- Still value + debit the gas: reuse `deductSponsoredGas` / `priceGasUsdCents` with the
  error's `gasCostWei` (sponsored mainnet must still debit dBank — the paymaster paid
  for the reverted op). Today's `deductSponsoredGas` idempotency key (`gas:<id>`)
  already makes this safe.

> Without Phase 4, `onFail` would silently never fire for reverted sponsored txs — and
> reverted sponsored ops would keep being billed as confirmed successes. The feature
> forces fixing a real revert-detection gap.

---

## Storage rules (asymmetric — document explicitly)

Invariant: **a callback's `ctx.storage` always starts from the last *committed*
storage.** Uncommitted writes from a failed run are dropped, exactly as today.

| Callback | Sees | Writes persist? | Mechanism |
|---|---|---|---|
| `onSkip`    | run's live storage (same process) | ✅ Yes | Skip path already commits (`execution.ts:743`). |
| `onSuccess` | post-run **committed** storage | ✅ Yes | Phase-2 commit, `expectedVersion` = version from the run's commit; lock still held ⇒ no conflict. |
| `onFail`    | **pre-run** committed storage (the failed run's writes are dropped, as today) | ✅ Yes | Phase-2 commit, `expectedVersion = storageVersion`; lock still held. |
| `onError`   | run's live storage (same process) | ❌ No | Failure path never writes the storage output — matches today's throw semantics. |

The `onFail` row is the subtle one: giving it the run's uncommitted storage and then
committing would smuggle a failed run's writes into persistence, breaking the invariant
that persisted storage only ever reflects committed outcomes.

---

## Phase 5 — Detection, local dev, rollout

- **"Who checks if defined":** runtime `typeof` probe in phase 1 (primary, robust) →
  `RunSandboxOutput.definedCallbacks` → gates phase-2 re-entry. Optional: an
  upload-time static badge in the Console (extend the `schema-extractor` scan) —
  cosmetic only.
- **`thyme run` (local):** ✅ Done. The CLI's own exec script
  (`packages/cli/src/deno/runner.ts`, was line 316) is *not* the production wrapper, so
  `onSkip`/`onError` needed their own inline invocations — added directly in
  `runInDeno`'s script tail, gated on `typeof task.onSkip/onError === 'function'`,
  matching the production ordering (onSkip before the storage/result output; onError
  before `Deno.exit(1)`, no storage write). The permission-flag builder and the
  Logger/client/storage-helper preamble were factored out into `buildDenoFlags` /
  `buildContextPreamble` so the run phase and the new callback phase can't drift apart
  on what `ctx` looks like.
  For the post-submit hooks, no real submission happens locally — `--simulate-callbacks`
  now fabricates a payload (`onSuccess`, or `onFail` with a choice of `reverted`/
  `submit`/`timeout`) via a new `runCallbackInDeno` (mirrors `runCallbackInSandbox` from
  Phase 3, deliberately, for naming consistency across the two repos) and an interactive
  `clack.select` prompt in `run.ts`. Storage sourcing follows the same asymmetric rule as
  production: `onSuccess` starts from the run's produced storage, `onFail` starts from
  the pre-run storage. Kept the name `--simulate-callbacks` despite the collision noted
  below — it reads as a distinct flag in `--help` output, and no user confusion showed up
  in testing.
- **Rollout:** the new wrapper ships only when a sandbox is (re)provisioned — existing
  executables keep the old single-phase wrapper and simply **don't fire callbacks**
  until re-provisioned (graceful: old wrapper + new SDK bundle ignores callbacks; new
  wrapper + old SDK bundle probes `typeof` and finds none, because today's `defineTask`
  strips them). Optionally add a migration that walks active executables through
  `regenerateSandboxAction` (`action/sandbox.ts:101`).

---

## Suggested build order

1. ✅ **Done.** SDK types + `defineTask` passthrough + tests + changeset (isolated, publishable).
2. ⬜ `bundler.ts` typed `OnChainExecutionError` + ERC-4337 `receipt.success` checks +
   failure-path gas debit / `recordSubmittedTx` wiring (standalone correctness fix,
   shippable before any callback work).
3. ⬜ Phase-dispatched wrapper + inline `onSkip`/`onError` + `definedCallbacks` probe +
   explicit `THYME_PHASE` in `runInSandbox`.
4. ⬜ `runCallbackInSandbox` + wire `onSuccess`/`onFail` re-entry + storage commits + CU
   metering in `execution.ts`.
5. 🟡 **Partially done.** Local runner inline callbacks + `--simulate-callbacks` ✅ shipped.
   README/docs ✅ shipped (SDK README; `../app` has none in scope). Optional
   sandbox-regeneration migration: ⬜ not started (blocked on steps 2–4 anyway).

## Test matrix (beyond SDK unit tests)

| Scenario | Expect |
|---|---|
| canExec:false, onSkip defined | onSkip runs inline; its storage writes commit; logs labeled |
| run throws, onError defined | onError runs; exit 1; no storage commit; execution `failed` |
| confirmed run, onSuccess defined | phase-2 re-entry; storage commit on top of run's commit; CU folded into the single meter report |
| sponsored revert (post Phase 4) | typed error → `failed` + txHash persisted + dBank debited + onFail(stage:'reverted') |
| receipt timeout | onFail(stage:'timeout') with the persisted hash; no false "reverted" |
| callback throws / sandbox infra error in phase 2 | execution status unchanged; error logged; regeneration scheduled on infra error |
| task without callbacks | zero phase-2 re-entries (probe empty), zero added latency |
| old wrapper + new SDK / new wrapper + old SDK | no callbacks fire; nothing breaks |

---

## Key files touched

| Repo | Path | Role | Status |
|---|---|---|---|
| thyme-sdk | `packages/sdk/src/types.ts` | Callback fields + payload types | ✅ |
| thyme-sdk | `packages/sdk/src/task.ts` | `defineTask` passthrough + shared validation wrapping | ✅ |
| thyme-sdk | `packages/sdk/src/index.ts` | Export payload types | ✅ |
| thyme-sdk | `packages/sdk/README.md` | "Lifecycle Callbacks" docs section | ✅ |
| thyme-sdk | `packages/sdk/test/task.test.ts` | Callback unit tests | ✅ |
| thyme-sdk | `packages/cli/src/deno/runner.ts` | Inline `onSkip`/`onError` locally, `definedCallbacks` probe, `runCallbackInDeno`; also fixed a pre-existing bug where stdout logs were dropped on task failure | ✅ |
| thyme-sdk | `packages/cli/src/commands/run.ts`, `src/index.ts` | `--simulate-callbacks` flag + interactive outcome picker | ✅ |
| thyme-sdk | `packages/cli/test/runner.test.ts` | 11 new Deno-integration tests for the above | ✅ |
| thyme-sdk | `.changeset/callback-lifecycle-hooks.md` | Minor bump for both packages | ✅ |
| app | `backend/convex/lib/sandbox.ts` | Phase-dispatched wrapper, `THYME_PHASE`, `definedCallbacks`, `runCallbackInSandbox` | ⬜ |
| app | `backend/convex/action/execution.ts` | `onSuccess`/`onFail` re-entry, storage commits, CU metering, failure-path gas/tx persistence | ⬜ |
| app | `backend/convex/lib/bundler.ts` | Typed `OnChainExecutionError` + ERC-4337 revert detection | ⬜ |
