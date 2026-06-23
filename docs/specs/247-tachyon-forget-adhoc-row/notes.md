# Spec 247 — notes

## Codex dueto (2026-06-22) — SHIP-WITH-CHANGES
(codex dueto transcript, 2026-06-22).

Folded:
- **Rename** `forgetAdhocRow` → `removeEphemeralFootprint` (codex #2/OQ2): "Row" hides the log delete; "Adhoc" is wrong for an inline pipeline `cmd:` node (not in `this.adhoc`).
- **Bundle, no flag** (codex #3/OQ3): the drift was the *log* half forgotten; a `{keepLog}` flag re-opens that door. Declared-keep-log branch stays outside the helper.
- **Public + loud precondition doc** (codex #3/OQ5): ephemeral-only; never call where the log must survive. `dismissNode` logic stays in `Workspace`.
- **`activityDir()` is internal, not the refactor** (codex OQ4): path-dedup alone doesn't stop the pairing drift.
- **Preserve `kill` ordering** (codex extra): compute `wasAdhoc` before `adhoc.delete`; helper must not inspect `this.adhoc`.
- **Remove stale `Workspace.ts` imports** after rewrite (codex extra).
- **Full `ledger.remove` audit table** (codex #4) — added to spec.

## Verified facts (grounding)
- **OQ1 RESOLVED:** `Workspace.ledger` (`Workspace.ts:251`) === instance passed to `AgentManager` (`:265`). Same ledger. No regression.
- **`deleteActivityLog` is idempotent:** `fs.rmSync(f, {force:true})` in try/catch (`logStore.ts:42-47`).
- **`dismissNode → kill` double-delete is real + safe:** inline `cmd:` node → `adhoc=true` → `kill` already removes row+log → `dismissNode` repeats (idempotent). Declared `agent:` node → `adhoc=false` → `kill` no-ops → `dismissNode` does the single real removal that keeps the log.
- **4th-site FINDING — `extension.ts:1242`:** declared-agent Delete does `ledger.remove` + `removeContinuity` but **no** `deleteActivityLog` → orphan log of the same class. Inline comment there brags about fixing the *row* "stale-accumulation bug"; the *log* now has it. → **D-SCOPE** decision (author leans A: fix it here as the one flagged behavior change).

## Open for maintainer
- **D-SCOPE** (A fix-here / B defer / C keep-by-design) — the only line that changes observable behavior. Ratify before implement.
