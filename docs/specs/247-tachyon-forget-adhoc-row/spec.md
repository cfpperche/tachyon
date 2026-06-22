# Spec 247 — `removeEphemeralFootprint`: one helper for an ephemeral agent's durable footprint

**Status:** IMPLEMENTED + dogfooded 2026-06-22 (branch `spec-247-remove-ephemeral-footprint`, commit `2c30b8c`; 975 unit tests + tsc main/webview green; live ad-hoc-kill dogfood vs rebuilt 0.34.1 → zero orphan). Pending maintainer call on merge/PR + release version. codex dueto 2026-06-22 (SHIP-WITH-CHANGES → folded: renamed helper, idempotency + double-call proven, `ledger.remove` audit table, declared-delete 4th-site finding surfaced). **D-SCOPE = A ratified by maintainer 2026-06-22** (declared-Delete orphan fixed here as the one flagged behavior change). · **Date:** 2026-06-22 · **Follows:** spec 239 (agent activity log), 211 (ad-hoc ledger lifecycle), pin p-4dadd3 (orphan-log cleanup) · **Surface:** `src/agents/AgentManager.ts` (`kill`, `dismissAdhoc`, new helper), `src/workspace/Workspace.ts` (`dismissNode`), optionally `src/extension.ts` (declared-Delete, see D-SCOPE) · **Review:** codex design debate DONE · **UI impact:** none (internal lifecycle; the only optional behavior change is fixing a latent orphan, D-SCOPE)

> **Origin:** identified as a *real smell* in the spec-239/p-4dadd3 follow-up handoff. The 0.34.1 bug (`935cb36`) — `kill` removed an ad-hoc agent's ledger row but left its durable activity log orphaned — was a **drift bug**: the "drop the row ⇒ drop the log" invariant was open-coded at three sites and one missed the second half. This refactor closes the *class*, not just the instance.

## Problem

An ephemeral agent's **durable footprint** is two on-disk artifacts that share one lifecycle: its **ledger row** (`ledger.remove(name)`) and its **durable activity log** (`deleteActivityLog(activityDir, name)` → `<name>.jsonl` + `<name>.state.json`). When such an agent is truly gone (no reachable pane, no declared config), both must be removed together — or the survivor is an orphan: a row resurrects a phantom stopped agent (spec 211); a log grows unreachable under `.tachyon/activity/` (spec 239 / p-4dadd3).

That paired removal is open-coded at **three** ephemeral sites, each rebuilding the same `path.join(workspaceRoot, ".tachyon", "activity")` literal. The 0.34.1 omission lived in `kill`'s `wasAdhoc` branch and diff-review was blind to it (the missing line was in an untouched branch).

### `ledger.remove` audit (codex finding #4 — all sites, verified 2026-06-22)

| Site | Paired with log delete? | Classification |
|---|---|---|
| `AgentManager.kill()` `wasAdhoc && !persistent` (`:716-722`) | **yes** (since 0.34.1) | **In scope** — ephemeral pair |
| `AgentManager.dismissAdhoc()` (`:791-800`) | **yes** | **In scope** — ephemeral pair |
| `Workspace.dismissNode()` inline `cmd:` (`!def?.agent`, `:700-704`) | **yes** | **In scope** — ephemeral pair |
| `AgentManager.list()` clean-exit reap (`:388`) | **no — intentional** | Out of scope: dead pane still viewable in postmortem; log kept until explicit dismiss (spec 239 / p-4dadd3 decision) |
| `AgentManager.rename()` (`:764`) | n/a — moves the row, doesn't remove | Out of scope: log path is name-keyed but rename is a separate follow pass (spec 226 harness-home note) |
| `Workspace.ts:1443` reconcile (declared row removed from config + not live) | **no** | Out of scope: GC of an already-config-removed declared agent; log retention for declared agents is a deliberate separate policy |
| **`extension.ts:1242` declared-agent Delete** (`ledger.remove` + `removeContinuity`, **no log delete**) | **no** | **⚠ FINDING — same orphan class.** The inline comment says they fixed the *row* "stale-accumulation bug (deleted agents kept showing)"; the *log* has the identical accumulation now. See **D-SCOPE.** |

### Grounding (verified 2026-06-22)
- **`deleteActivityLog` is idempotent** — `fs.rmSync(f, { force: true })` in try/catch ("a missing/locked file is fine", `logStore.ts:42-47`). A double-call is harmless.
- **The `dismissNode → kill` double-delete is real but safe.** An **inline `cmd:`** node is spawned `manager.spawn(name, { cmd, … })` (`Workspace.ts:661`) → `adhoc = !!opts?.cmd` true → in `this.adhoc` → `kill`'s `wasAdhoc` branch **already** removes row+log; `dismissNode` then removes both again (idempotent). A **declared `agent:`** node is spawned `manager.spawn(def.agent, …)` (`Workspace.ts:650`) → no `cmd` → `adhoc` false → not in `this.adhoc` → `kill` touches neither; `dismissNode`'s `ledger.remove` + `!def?.agent`-skip is the real, single removal that **keeps** the log. So the spec's "declared keeps log" claim holds today and is preserved.
- **An existing sibling factors the in-memory half:** `forgetAdhoc(name)` (`AgentManager.ts:779`) drops the `adhoc` map + `lineage` entry. There is **no** sibling for the durable half — that's the gap.
- **Ledger instance identity (OQ1, RESOLVED):** `Workspace.ledger = new SessionLedger(workspaceRoot)` (`Workspace.ts:251`) is the same instance passed into `AgentManager` (`:265 ledger: this.ledger`) → `this.manager.removeEphemeralFootprint(name)` removes from the same ledger as `this.ledger.remove(name)`. No regression.

## Goal

One named, lifecycle-documented helper on `AgentManager` encapsulates "remove an ephemeral agent's durable footprint = ledger row + activity log, from the one place that owns the activity dir." Route the three ephemeral sites through it (the declared-node branch in `dismissNode` keeps its explicit row-only removal). After this, a fourth removal site cannot silently re-introduce the orphan, because the paired operation is **named, not copied**.

## Decisions (folded from codex dueto)

- **D1 — Name = `removeEphemeralFootprint(name)`, NOT `forgetAdhocRow`.** (codex OQ2) "Row" hides the log deletion and "Adhoc" is wrong for an inline pipeline `cmd:` node (`pl-<runId>-<nodeId>`, not in `this.adhoc`). The name must say *lifecycle* + *both artifacts*.
- **D2 — Bundle row + log; callers branch; NO `{ keepLog }` flag.** (codex OQ3) The drift was the *log* half being forgotten — a flag re-introduces a way to "forget" it. The declared-keep-log case stays an explicit `ledger.remove` *outside* the helper.
- **D3 — `public`, lifecycle-named, with a loud precondition doc:** "removes the durable footprint for an ephemeral agent ONLY (ledger row + activity log); never call for an agent whose log must survive (declared, postmortem-viewable)." (codex #3, OQ5) `dismissNode` logic stays in `Workspace` (it owns node defs, pipeline maps, view refresh) — only the footprint removal moves.
- **D4 — Centralize the activity-dir literal too** via a `private activityDir()`, but that alone is NOT the refactor (codex OQ4 — it fixes path dup, not the pairing drift). The helper is the unit; `activityDir()` is its internal.
- **D5 — Preserve `kill` ordering exactly:** compute `wasAdhoc` *before* `this.adhoc.delete`; the helper must NOT inspect `this.adhoc` internally (it's row+log only — the in-memory `adhoc`/`lineage` drop stays at the call site, via `forgetAdhoc` or `kill`'s own `adhoc.delete`).
- **D6 — Remove now-stale imports** from `Workspace.ts` after the rewrite (`deleteActivityLog`, and `path`/`agentLogId` if unused) — they move behind the manager.

### D-SCOPE — the `extension.ts:1242` declared-Delete finding (maintainer decision)

The audit found a **fourth latent orphan of the same class**: deleting a *declared* agent removes its config entry + ledger row + continuity but leaves `<name>.jsonl` orphaned. Three options:

- **(A) RECOMMENDED — fix it in this spec as a 4th site, flagged as the one (correct) behavior change.** A deleted agent should not leave an orphan log; the helper makes it a one-liner (`removeEphemeralFootprint` after the YAML delete succeeds). Adds one acceptance row + one test. Maximizes value: the refactor de-dups *and* kills a live latent instance.
- **(B) Defer to a follow-up spec** — keep 247 a pure structure-only refactor (no behavior change), open a tiny follow-up for the declared-delete orphan.
- **(C) Decide declared-delete SHOULD keep the log** (e.g. for export) — then it's intentional row-only and the table closes as "by design."

Author leans (A): same bug class, low risk, the helper is purpose-built for it, and "fixed the row but not the log" is exactly the drift this spec exists to end. Needs maintainer ratify before implement (it's the only line that changes observable behavior).

## Proposed shape

```ts
// AgentManager.ts — sibling to the in-memory forgetAdhoc()
private activityDir(): string {
  return path.join(this.opts.workspaceRoot, ".tachyon", "activity");
}

/** Remove an ephemeral agent's DURABLE footprint — its ledger row AND its activity log —
 *  together (spec 211 row + spec 239 log; splitting them is the p-4dadd3 / 0.34.1 orphan bug).
 *  EPHEMERAL ONLY: never call for an agent whose log must survive (a declared agent, a
 *  postmortem-viewable clean-exit pane). In-memory def+lineage is forgetAdhoc()'s job.
 *  Idempotent (ledger.remove on a missing key + force rm). */
removeEphemeralFootprint(name: string): void {
  this.opts.ledger?.remove(name);
  deleteActivityLog(this.activityDir(), name);
}
```

Call-site rewrites (gating conditions copied verbatim — the helper is the *body*, not the *condition*):
- `kill`: `if (wasAdhoc) this.removeEphemeralFootprint(name);` (`adhoc.delete` stays above it).
- `dismissAdhoc`: `this.forgetAdhoc(name); this.removeEphemeralFootprint(name);`
- `dismissNode` (Workspace): `if (!def?.agent) this.manager.removeEphemeralFootprint(name); else this.ledger.remove(name);`
- *(if D-SCOPE=A)* `extension.ts:1242` declared-Delete success cb: add `ws.manager.removeEphemeralFootprint(item.agentName);` after the YAML delete succeeds.

## Non-goals

- Any change to **when** a log/row is removed for the three existing ephemeral sites (gating preserved verbatim — structure only).
- Touching `forgetAdhoc` (in-memory), `deleteActivityLog` (the single durable primitive), `list()`'s clean-exit reap (intentional log retention), or `rename`.
- Injected behavior, new surface, or any UI change (except the optional D-SCOPE=A orphan fix).

## Risks

- **R1 — silent behavior change** from collapsing branches (esp. `dismissNode` declared/inline split, `kill` persistent-fork guard). Mitigation: gating copied verbatim; D5 ordering preserved.
- **R2 — ledger-instance mismatch.** Closed (OQ1 verified).
- **R3 — the refactor drifts the invariant it protects.** Mitigation: R4 below.
- **R4 — declared-delete fix (D-SCOPE=A) over-deletes** a log a user wanted. Mitigation: only fires on explicit Delete (not Stop); declared agents are gone from config after it — no path renders the log anyway.

## Acceptance

- [ ] One `public removeEphemeralFootprint(name)` encapsulates the row+log paired removal with a loud ephemeral-only precondition doc; the `path.join(…, ".tachyon", "activity")` literal exists in exactly one place (`private activityDir()`).
- [ ] All three ephemeral sites route through it; the declared-node branch in `dismissNode` keeps explicit `ledger.remove`; all gating conditions unchanged; `kill` computes `wasAdhoc` before `adhoc.delete`.
- [ ] **A test asserts the invariant at every site** — kill(ad-hoc), dismissAdhoc, dismissNode(inline `cmd:`) → ledger row gone AND `deleteActivityLog` effected; and the retention cases — dismissNode(declared `agent:`), persistent fork, list() clean-exit reap → log preserved. *(p-4dadd3 test-lesson: test the invariant at ALL sites, not only the changed one.)*
- [ ] `deleteActivityLog` idempotency is covered (missing `.jsonl`/`.state.json` → no throw), legitimizing the `dismissNode → kill` double-call.
- [ ] Stale `Workspace.ts` imports removed (D6).
- [ ] **D-SCOPE ratified.** If (A): declared-Delete also drops the log + a test asserts no orphan after delete. If (B/C): the audit table's `extension.ts:1242` row is annotated with the decision.
- [ ] `env -u TMUX npx vitest run` (L-scoped) + tsc main/webview green; live dogfood — kill an ad-hoc agent, no orphan `.jsonl`.
