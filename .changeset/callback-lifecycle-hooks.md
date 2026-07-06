---
"@thyme-labs/sdk": minor
"@thyme-labs/cli": minor
---

Add task lifecycle callbacks: `onSuccess`, `onSkip`, `onError`, `onFail`. A task can now react to its own execution outcome (e.g. send an alert on failure, record the tx hash on success) without changing the execution's real status — callbacks are best-effort and never override it. `onSkip`/`onError` run inline alongside `run`; `onSuccess`/`onFail` react to the on-chain outcome once it's known. `ctx.args` is validated/transformed for callbacks exactly like it is for `run`.

`thyme run` now runs `onSkip`/`onError` locally too, and gains `--simulate-callbacks` to fabricate a receipt and exercise `onSuccess`/`onFail` (including the `stage:'timeout'` case) without a real on-chain submission.
