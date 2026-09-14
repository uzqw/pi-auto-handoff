# pi-auto-handoff

Proactive context handoff for the [pi](https://github.com/earendil-works/pi) coding agent.

When context grows past a threshold, the session continues in a **fresh session** with
`parentSession` set. The new agent recovers state by running `session-tail.py`, which prints
the old transcript on demand — no summarization pass, no lossy compaction, nothing carried in
the new context until it is actually needed.

## Install

```bash
pi install git:github.com/uzqw/pi-auto-handoff
```

If you already keep a copy in `~/.pi/agent/extensions/auto-handoff/`, remove it — both would
register `/handoff` and both would fire on the threshold.

## Usage

| Command | Effect |
| --- | --- |
| `/handoff` | Hand off now, regardless of context size |
| `/handoff-threshold` | Show current threshold and on/off state |
| `/handoff-threshold 150` | Auto-handoff at 150k tokens |
| `/handoff-threshold off` / `on` | Disable / re-enable auto-handoff |

Threshold state lives in `~/.pi/agent/auto-handoff.json`:

```json
{ "threshold": 195000, "enabled": true }
```

## How it works

- `agent_settled` checks `ctx.getContextUsage().tokens` against the threshold. It fires at most
  once per session, and never in a session that was itself created by a handoff (a
  `auto-handoff-target` custom entry marks it).
- The event context has no `newSession()`, so the handler re-enters through
  `pi.sendUserMessage("/handoff", { expandPromptTemplates: true })`, which dispatches the
  registered command and gives it a command context where `newSession()` exists.
- `newSession({ parentSession, setup, withSession })` marks the fresh session with a
  `auto-handoff-target` entry, then sends the kickoff prompt.
- The kickoff prompt (editable at `extensions/auto-handoff/kickoff.template.md`, read fresh at
  handoff time) points the new agent at `session-tail.py` and the parent session file.

`session-tail.py` prints every user message in full and assistant replies truncated, each with
a ready-to-run `rg` command to read one whole, plus `--turns N` for a shorter tail.

## Layout

```
extensions/auto-handoff/
  index.ts                # extension: commands + threshold watcher
  kickoff.template.md     # first message the fresh session receives
  session-tail.py         # transcript reader the fresh session runs
```

## License

MIT
