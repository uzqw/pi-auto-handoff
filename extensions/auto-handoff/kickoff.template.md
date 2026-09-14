Continue the work from a previous session whose context grew too large.
Its transcript is: {{SESSION_FILE}}

Recover the state in one command — it prints every user message in full and
every assistant reply (truncated), so do NOT open or read the JSONL yourself:

    python3 "{{SCRIPT}}" "{{SESSION_FILE}}"

Each truncated reply ends with a ready-to-run `rg` command that prints that
message in full; use it when the cut matters. If the dump is larger than you
need, re-run with `--turns 20` for just the tail. For exact tool output or an
error, grep the raw tail:

    rg -n '"toolResult"' "{{SESSION_FILE}}" | tail -20

If the next step is still ambiguous, ask the user instead of guessing.
