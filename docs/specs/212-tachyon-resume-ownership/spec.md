# 212 — tachyon-resume-ownership

_Created 2026-06-14._

**Status:** shipped
**Closure:** Shipped as v0.13.2; commit `9be4cf7f` records tasks 1–6 done and the three-round SHIP review.
**Status detail:** shipped (v0.13.2)

**UI impact:** none
<!-- No new UI. Refreshes the ledger's resume session id at stop/kill so the
existing ↻ "Resume with context" action follows an in-TUI /resume. Verified by
driving a real agent: /resume inside, stop, resume → lands on the switched-to
session, not the creation one. -->

## Intent

**A3 (dogfood pin `p-d8f69c`) — an in-TUI `/resume` must not be lost on stop+resume.**

A Tachyon-mint-tracked agent (plain `claude`/`gemini`) gets a session id minted at
spawn and stored in the ledger. If the human runs `/resume <other>` **inside** the
agent's TUI, the agent is now in a different session — but the ledger still holds the
*creation* id. Stop the agent, then ↻ Resume → Tachyon runs `claude --resume <creation-id>`
and **snaps back to the session it was created in**, silently discarding the one the
human switched to. Same shape for any mint runtime.

Capture runtimes (codex/opencode) already self-heal — their id is resolved newest-by-cwd
from disk at resume time, so an in-TUI switch is picked up. The gap is the **mint** path,
where the id is pinned at spawn and never refreshed.

## Decisions (incorporating the codex design review)

1. **Refresh ownership at stop/kill, not at resume.** When a tracked agent's session ends
   (kill / restart-kill), re-resolve the *current* session for its cwd from disk and write
   it back to the ledger's `resume.sessionId`. The next ↻ then follows what the human
   actually resumed to. (Refreshing at stop — while the on-disk transcript is freshest and
   the cwd still maps cleanly — beats refreshing lazily at resume.)
2. **Do NOT overload ▶.** ▶ (`spawnAgentItem`) is intentionally "start fresh"; ↻
   (`resumeAgentItem`, "Resume with context") is already the separate resume action. A3 is
   purely the id-refresh that makes ↻ land on the right session — **no new action, no ▶
   change** (codex correction (a)).
3. **`resolveCurrentSession(runtime, cwd)` — newest session for a cwd, where derivable:**
   - **claude** — newest `*.jsonl` by mtime in `~/.claude/projects/<encodeClaudeCwd(cwd)>/`
     → its basename uuid. (New: mint runtimes never needed a resolver before.)
   - **codex / opencode** — reuse the existing capture resolvers (already newest-by-cwd).
   - **qwen** — `resumesWithoutId` (`--continue`); no id to refresh — skip.
   - **gemini** — no derivable on-disk project path → **null, documented gap** (stays pinned
     to the minted id; honest limitation, not a silent wrong-guess).
   - **continue** — no documented on-disk map → null (its empty-id rows already fall back to
     a fresh spawn; codex finding (d), documented).
4. **cwd ambiguity is the real hazard — gate on it (codex correction (b)).** Two agents in
   the *same* cwd make "newest session for this cwd" ambiguous (it might be the *other*
   agent's). So refresh ONLY when the agent's cwd is unambiguous: it is the sole ledger
   agent with that cwd, OR it runs in its own **worktree** (spec 210 → unique cwd). When the
   cwd is shared, keep the minted id and skip the refresh (never guess wrong). Worktrees are
   what make A3 fully clean — the coupling the review identified.
5. **Never downgrade resumability.** A refresh only ever *replaces* a valid id with another
   valid (on-disk, transcript-exists) id; if `resolveCurrentSession` returns null or the
   resolved transcript is missing, leave the stored id untouched.

## Behavior

- **On kill / restart-kill of a tracked agent** (has a `resume` block, mint or capture):
  if its cwd is unambiguous, call `resolveCurrentSession(runtime, cwd)`; if it returns a
  non-empty id whose transcript exists, write it to `resume.sessionId` in the ledger.
- **↻ Resume / activation resume** then uses the refreshed id — landing on the in-TUI
  `/resume` target rather than the creation session.
- **Gemini / continue / shared-cwd** → no refresh (documented; behaves as today).
- No change to ▶, the badge, or any UI.

## Non-goals

- A new "resume where I left off" action — ↻ already is it (rejected per review).
- Resolving gemini/continue on-disk ids — no documented map; out of scope, documented gap.
- Disambiguating two agents in one shared cwd — solved by worktrees (210), not here.
- Checking transcript existence for the resumable *badge* (codex finding (e)) — separate
  polish; resume() already verifies the transcript and falls back, so it's not a data risk.

## Acceptance

- A mint agent (`claude`) that ran an in-TUI `/resume`, then was stopped, resumes (↻) into
  the **switched-to** session, not the creation one — verified live.
- The refresh fires only at stop/kill, only for an unambiguous cwd, and only replaces a
  stored id with another valid on-disk id (never nulls it, never guesses on a shared cwd).
- `resolveCurrentSession`: claude resolves newest-by-mtime; codex/opencode reuse the capture
  resolvers; qwen/gemini/continue return null (no wrong guess). Pure, fixture-tested.
- Gemini stays pinned with a documented gap; no crash, no wrong session.
- A worktree agent (unique cwd) always refreshes cleanly; two agents sharing the workspace
  root never cross-contaminate ids.
