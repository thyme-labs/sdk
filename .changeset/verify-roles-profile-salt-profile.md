---
"@thyme-labs/cli": minor
---

`thyme verify roles-profile` accepts `--salt-profile <id>` for a profile that recreates, at the same address, a Safe another profile has on a different chain. The customer Safe's salt then derives from that profile's id while the Roles proxy, role key and executor Safe still derive from `--profile`; a request whose `customerSafeSaltProfileId` differs is refused at check 2.
