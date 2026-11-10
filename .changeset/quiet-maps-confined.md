---
"@thyme-labs/cli": minor
---

Confine local task and callback module loading with Linux Landlock. Deno read
permissions alone did not prevent imports of files outside the task/dependency
grants. Local execution now requires Landlock-enabled Linux, util-linux setpriv
2.41+ with Landlock support, ldd and Deno 2.9.6, and fails closed otherwise. Direct
macOS/Windows execution requires migration to a Linux VM/container; other CLI
commands are unchanged. Dependencies must be installed within project node_modules;
external workspace/store links and remote module downloads are unsupported. Each
run uses a clean environment and disposable runtime cache. No database migration is
required. Release the CLI after merge, then update consuming app SDK pins separately.
