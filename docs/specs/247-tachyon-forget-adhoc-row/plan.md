# Spec 247 — plan

Structure-only refactor (+ one optional flagged orphan fix). No new surface.

## Sequence
1. **Add the helper.** `AgentManager`: `private activityDir()` + `public removeEphemeralFootprint(name)` (row + log, idempotent, ephemeral-only doc). Sibling to `forgetAdhoc`.
2. **Route `kill`.** Replace the `ledger.remove` + `deleteActivityLog` two-liner with `if (wasAdhoc) this.removeEphemeralFootprint(name);`. Keep `wasAdhoc` computed before `adhoc.delete`; keep the `!persistent` guard.
3. **Route `dismissAdhoc`.** `this.forgetAdhoc(name); this.removeEphemeralFootprint(name);`
4. **Route `dismissNode`** (Workspace): `if (!def?.agent) this.manager.removeEphemeralFootprint(name); else this.ledger.remove(name);` — then remove now-stale `deleteActivityLog`/`path`/`agentLogId` imports if unused.
5. **D-SCOPE gate** (await maintainer): if A, add `ws.manager.removeEphemeralFootprint(item.agentName)` in `extension.ts:1242`'s post-YAML-delete cb + its test.
6. **Tests** (the point of the spec): invariant at every removal site + retention at every keep-log site + `deleteActivityLog` idempotency.
7. **Verify:** `env -u TMUX npx vitest run` + tsc main/webview; live dogfood (kill ad-hoc → no orphan `.jsonl`).

## Risk control
- Gating conditions copied verbatim — review the diff against the verbatim originals.
- Test the invariant at ALL sites (the p-4dadd3 lesson), since diff-review is blind to omissions in untouched branches.
