#!/usr/bin/env python3
"""Print a pi session transcript as plain dialogue.

    python3 session-tail.py <session.jsonl> [--turns N] [--chars N] [--selftest]

Every user message is printed in full — user turns carry the task and its
constraints, so truncating them would drop the requirement, not the noise.
Assistant replies are truncated to --chars (default 600); each truncated reply
ends with an `rg` command that locates that message in the raw JSONL, so
nothing is lost, just deferred until you actually need it.

Thinking, tool calls and tool results are skipped (grep the raw JSONL when you
need those). The most recent message is printed last, so the state you need is
at the bottom. With no --turns, the whole conversation is shown.
"""
import json
import sys

DEFAULT_CHARS = 600


def parts_text(content) -> str:
    """Flatten a message's content into its text parts."""
    if isinstance(content, str):
        return content
    out = []
    for part in content or []:
        if isinstance(part, dict) and part.get("type") == "text" and part.get("text"):
            out.append(part["text"])
    return "\n".join(out)


def dialogue(path: str, limit: int, cap: int) -> str:
    messages = []
    name = ""
    with open(path, errors="replace") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("type") == "session_info" and not name:
                name = str(rec.get("name") or "")
                continue
            if rec.get("type") != "message":
                continue
            message = rec.get("message") or {}
            role = message.get("role")
            if role not in ("user", "assistant"):
                continue
            text = parts_text(message.get("content")).strip()
            if text:
                messages.append((role, text, rec.get("id")))

    shown = messages[-limit:] if limit > 0 else messages
    lines = [f"# {path}"]
    if name:
        lines.append(f"# session: {name}")
    if limit > 0 and len(shown) < len(messages):
        lines.append(f"# {len(messages)} user/assistant messages; showing the last {len(shown)}")
    else:
        lines.append(f"# {len(messages)} user/assistant messages (all shown)")
    lines.append("")
    for role, text, mid in shown:
        lines.append(f"### {'USER' if role == 'user' else 'ASSISTANT'}")
        if role == "assistant" and len(text) > cap:
            lines.append(text[:cap])
            hint = f"… [+{len(text) - cap} chars]"
            if mid:
                hint += f" — full message: rg -n '\"id\":\"{mid}\"' \"{path}\""
            lines.append(hint)
        else:
            lines.append(text)
        lines.append("")
    return "\n".join(lines)


def selftest() -> None:
    import os
    import tempfile

    long_user = {
        "id": "u1",
        "type": "message",
        "message": {"role": "user", "content": [{"type": "text", "text": "U" * 80}, {"type": "toolCall", "name": "bash"}]},
    }
    long_reply = {
        "id": "a1",
        "type": "message",
        "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": "A" * 80}]},
    }
    noise = {"type": "message", "message": {"role": "toolResult", "content": [{"type": "text", "text": "noise"}]}}
    name = {"type": "session_info", "name": "demo"}
    path = os.path.join(tempfile.mkdtemp(), "s.jsonl")
    with open(path, "w") as fh:
        for rec in (name, long_user, noise, long_reply):
            fh.write(json.dumps(rec) + "\n")

    out = dialogue(path, limit=0, cap=10)
    assert "### USER\n" + "U" * 80 in out, out  # user message stays whole
    assert "A" * 10 in out and "[+70 chars]" in out, out
    assert f'rg -n \'"id":"a1"\' "{path}"' in out, out  # cut reply points back at the raw record
    assert "hmm" not in out and "noise" not in out, out
    assert "# session: demo" in out and "all shown" in out, out
    tail = dialogue(path, limit=1, cap=10)
    assert tail.count("###") == 1 and "ASSISTANT" in tail, tail  # --turns keeps the tail
    short = dialogue(path, limit=1, cap=1000)
    assert "rg -n" not in short, short  # nothing cut -> no hint
    print("selftest ok")


def main(argv) -> None:
    if "--selftest" in argv:
        selftest()
        return
    if len(argv) < 2:
        sys.exit(__doc__)
    limit = int(argv[argv.index("--turns") + 1]) if "--turns" in argv else 0
    cap = int(argv[argv.index("--chars") + 1]) if "--chars" in argv else DEFAULT_CHARS
    print(dialogue(argv[1], limit, cap))


if __name__ == "__main__":
    main(sys.argv)
