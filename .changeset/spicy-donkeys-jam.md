---
'@thyme-labs/cli': minor
---

Make every command usable without a TTY, for CI pipelines and agents.

- New global `--ci` and `-y, --yes` flags, accepted before or after the subcommand.
  `--ci` never prompts; `--yes` pre-answers confirmations while keeping other prompts.
- Non-interactive mode is also detected automatically from `CI`,
  `CONTINUOUS_INTEGRATION`, `THYME_CI`, or `THYME_NON_INTERACTIVE`, and from a
  non-TTY stdin/stdout — so piped and containerized runs no longer hang on a
  prompt they cannot answer.
- When a prompt is unavailable, confirmations (`Proceed with upload?`, `re-authenticate?`)
  are answered yes, and any other missing value fails immediately with exit code 2 and a
  message naming the flag to pass, including the valid values (`--workspace <id>`,
  `--project <id>`, `--tag <tag>`, `--callback <outcome>`, or the positional argument).
- `thyme run` gains `--callback <onSuccess|onFail:reverted|onFail:submit|onFail:timeout>`
  to pick the simulated outcome up front; it implies `--simulate-callbacks`.
- `thyme login --token` reads the API key from stdin when there is no terminal
  (`echo "$THYME_API_KEY" | thyme login --token`), and the browser device flow now
  fails fast with alternatives instead of polling for five minutes.
- Spinners degrade to plain single-line log output off a TTY, so CI logs stay readable.
- `thyme init <name>` now validates a name passed as an argument with the same rule the
  prompt used, rejecting uppercase names and path separators.
