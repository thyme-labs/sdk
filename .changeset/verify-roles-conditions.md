---
'@thyme-labs/cli': minor
---

`thyme verify roles-profile` now verifies Roles setup requests that carry argument conditions and spending budgets. Check 12 rebuilds each `scopeFunction` condition tree and each `setAllowance` call from the allowlist you typed (an object with `rules` and `allowances`) and refuses any difference, a start time other than "now", or a budget keyed for another role.
