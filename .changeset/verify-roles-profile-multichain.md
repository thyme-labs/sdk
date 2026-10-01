---
"@thyme-labs/cli": minor
---

`thyme verify roles-profile` now accepts every chain the sponsored Roles pins were verified on: Ethereum Sepolia, Polygon Amoy, Unichain Sepolia, Polygon, OP Mainnet and BNB Smart Chain. Pass `--chain <id>`; without `--rpc-url` or `RPC_URL` the command uses viem's public endpoint for that chain. Unlisted chain ids are still refused.
