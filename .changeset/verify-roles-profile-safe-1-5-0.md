---
"@thyme-labs/cli": minor
---

`thyme verify roles-profile` now verifies Roles profile Safes born on the Safe 1.5.0 template (SafeProxyFactory, SafeL2 and CompatibilityFallbackHandler 1.5.0) as well as 1.4.1. The template is never taken from the request: the command derives the Safe from both pinned templates and requires exactly one to match, or the one `--safe-version 1.4.1|1.5.0` names. A 1.4.1 Safe upgraded in place to 1.5.0 from Safe{Wallet} still passes: the version, singleton and fallback-handler rows accept the 1.5.0 deployments while the birth log still proves the 1.4.1 template. The guard row now also requires an empty 1.5.0 module guard.
