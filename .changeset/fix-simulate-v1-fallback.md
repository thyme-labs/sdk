---
"@thyme-labs/cli": patch
---

Fix `thyme run --simulate` mislabeling every `eth_simulateV1` error as "RPC does not support batch simulation". The batch path now only falls back to per-call `eth_call` when the RPC genuinely lacks the method (JSON-RPC `-32601` / `MethodNotFoundRpcError`); other failures (reverts, `-32602` fee-validation errors on chains like Polygon, transient node errors) are surfaced instead of silently downgrading to the weaker preview.
