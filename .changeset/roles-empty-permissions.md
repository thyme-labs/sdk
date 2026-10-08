---
"@thyme-labs/cli": patch
---

Allow verification of Safe Roles setups with no allowed calls and later scope
updates from an explicitly empty allowlist. Empty permissions grant no calls;
scope updates still require the previous allowlist and verify every revocation.
