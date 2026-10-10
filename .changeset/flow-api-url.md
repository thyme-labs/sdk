---
"@thyme-labs/cli": patch
---

Default the API URL to `https://flow.thymelabs.io/http`, the Thyme Flow host. The previous default, `https://functions.thymelabs.io/http`, keeps working, and a saved `apiUrl` or `THYME_API_URL` still takes precedence.
