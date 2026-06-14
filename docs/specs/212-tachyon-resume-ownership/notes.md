# 212 — tachyon-resume-ownership — notes

## Origin
Dogfood pin `p-d8f69c` (A3 in the 2026-06-13 triage): "se eu inicio um agente e dentro
da seção utilizo o /resume (claude ou codex) o agente não atualiza qual seção ele é dono;
se paro e inicio de novo ele volta na seção em branco ou na de criação." Parked behind
spec 210 (worktrees) because the clean fix needs an unambiguous cwd; 210 shipped (v0.13.0),
so A3 is now unblocked.

## Why it only bites mint runtimes
- **Capture** (codex/opencode): id is resolved newest-by-cwd from disk at resume time
  (`resolveCaptureId`), so an in-TUI /resume is already picked up → no bug.
- **Mint** (claude/gemini): id is minted at spawn and stored once; never refreshed → stop+resume
  snaps back to the creation session. This spec adds the refresh.
- **Self-managed** (`claude --resume tachyon`): spec 211 records NO resume block for these, so
  Tachyon doesn't manage their session at all → untouched (the user's --resume arg owns it).

## Codex design review (from the 2026-06-13 triage, folded in)
- (a) Do NOT overload ▶ (fresh-start by design); ↻ "Resume with context" is already the
  separate action → A3 is just the id-refresh. **Adopted.**
- (b) cwd-refresh is identity-ambiguous across runtimes → A3 is genuinely COUPLED to 210
  (worktree = unique cwd). **Adopted** as the ambiguity gate (refresh only on unambiguous cwd).
- (c) resume() dropped declared def.env → already FIXED (F1, v0.12.1). N/A here.
- (d) `continue` is adapter-resumable but has no resolver → empty-id rows fall back to fresh.
  **Documented gap**, not fixed here (no documented on-disk map).
- (e) the resumable BADGE doesn't check the transcript still exists → over-broad ↻. **Deferred**
  (a separate polish; resume() already verifies + falls back, so no data risk).

## Design crux: ambiguity gate
"Newest session for this cwd" is only correct when one agent owns that cwd. Worktrees (210)
guarantee it; shared workspace-root agents don't. So the refresh is gated: skip when another
ledger row shares the cwd. Conservative — a missed refresh just keeps the (still-valid) minted
id; it never writes a wrong one.

## Gemini gap (honest limitation)
gemini mints `--session-id` but its on-disk project dir is a friendly-name or SHA not derivable
from cwd alone (noted in adapters.ts: "project_key … not derivable from inputs alone"). So
`resolveCurrentSession('gemini', …)` returns null — gemini stays pinned to its minted id. A
wrong guess would be worse than a no-op; documented.

## Status
**Shipped v0.13.2.** Implemented under the user's product push (the Init scaffold's default
`cmd: claude` IS mint-tracked, so a fresh single-agent user hits this whenever they `/resume`
in-TUI — unambiguous cwd → A3 works fully).

## Closure
**Closure:** shipped as **v0.13.2**. All tasks 1-6 done; codex dueto **3 rounds** (3 findings,
all fixed + regression-tested): R1 — refreshOwnership could throw before killSession (now a
fully-guarded best-effort) + the cwd-ambiguity gate used raw string equality (now path.resolve);
R2 — refresh normalized the cwd but resume() read the raw one (now resolveCwd canonicalizes at
the source AND resume keys on path.resolve(record.cwd)); R3 — **SHIP**. 358 tests + typecheck.
Task 6's interactive EDH portion (in-TUI /resume) is a maintainer smoke recipe — the resolvers
are fixture-tested and the refresh/skip matrix is unit-tested. No open follow-ups (gemini/continue
gaps are documented by-design; C2/C3 stay separate specs).
