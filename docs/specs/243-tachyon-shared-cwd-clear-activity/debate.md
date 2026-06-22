# Debate 243 — codex plan review

**Outcome:** Option B chosen. A disqualified, C = fallback, D = brittle. Probe green.

## Codex verdict (reasoning-effort high, 2026-06-21)

- **Option A — DISQUALIFIED.** The length-1 sibling-clear counterexample is real and general: after `/clear`,
  the disk state for "A cleared" vs "B cleared" is observationally identical to A's resolver when the new
  transcript carries no title marker and no parent link. Any rule that adopts "newest unclaimed" in the
  A-cleared world also adopts B's session in the sibling-cleared world. Without a per-agent signal, A is not
  salvageable.
- **Option B — RECOMMENDED.** Claude exposes `--settings <file-or-json>` (a per-command settings layer) and
  `hooks` is a settings key; `SessionStart` fires on `startup|resume|clear|compact` with input
  `{session_id, transcript_path, cwd, source, hook_event_name}`. So Tachyon can spawn even shared-home agents
  with a per-spawn `--settings` JSON whose `SessionStart` hook records `{agent, session_id, transcript_path,
  cwd, source, ts}` to an ownership ledger (atomic append / `flock`) — WITHOUT mutating `~/.claude/settings.json`
  or the repo's `.claude/settings.json`. The resolver follows only ownership rows for that agent.
- **Option C — SOUND FALLBACK.** Isolated `CLAUDE_CONFIG_DIR` already works (distinct transcript namespace ⇒
  `shared===false` ⇒ existing escape follows `/clear`). Keep it as the guaranteed path when hooks are disabled,
  policy-blocked, or unsupported by the installed claude. Heavier than B (splits auth/settings/plugins).
- **Option D — REJECTED.** Open-fd inspection is sound only under an unproven invariant (claude keeps the
  transcript FD open between appends); append loggers often open-write-close. Diagnostic at best, not the
  attribution foundation.
- **Riskiest assumption:** that `--settings` hooks are honored for Tachyon's INTERACTIVE claude spawn and fire on
  `/clear` with the per-spawn agent identity available. **→ Verified by probe (below).**

Sources cited: https://code.claude.com/docs/en/hooks · https://code.claude.com/docs/en/settings

## Probe (2026-06-21, claude 2.1.185) — GREEN

`claude -p "…" --settings /tmp/probe-settings.json` with a `SessionStart` hook (`command: cat > marker`) →
the hook fired and its stdin payload was:

```json
{ "session_id": "182a5c81-…", "transcript_path": "/home/goat/.claude/projects/-tmp/182a5c81-….jsonl",
  "cwd": "/tmp", "hook_event_name": "SessionStart", "source": "startup" }
```

Confirms: a per-spawn `--settings` hook (1) is honored, (2) receives the live `session_id` + `transcript_path` +
`source`. The `source:"clear"` firing is independently disk-proven (the live repro's post-`/clear` transcript
`db3f3453…jsonl` contains a `{"hookName":"SessionStart:clear"}` record).

## Resolved OQs

- **OQ1** — Ship B as v1; C stays as the documented fallback. Do NOT also ship A.
- **OQ2** — Ownership ledger is authoritative for claude when a row exists; otherwise fall back to the existing
  (title/captured-uuid) resolution. The agent's own stale uuid is never an exclusion (moot under B — ownership is positive, not by elimination).
- **OQ3** — No mtime staleness guard needed: ownership rows are positive attribution; take the NEWEST row for the agent.
- **OQ4** — Surface the isolated-home fallback only in docs/notes for now (no new UI).
