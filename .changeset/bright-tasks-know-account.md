---
'@thyme-labs/sdk': minor
'@thyme-labs/cli': minor
---

Expose the execution address as `ctx.account`. Cloud runs use the executable profile address, while local runs require `SIMULATE_ACCOUNT` and expose its checksummed value. The field is available in the main run and every lifecycle callback.
