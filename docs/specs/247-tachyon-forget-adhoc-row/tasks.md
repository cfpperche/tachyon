# Spec 247 — tasks

**Verify:** `env -u TMUX npx vitest run && npm run -s typecheck`

- [x] T1 — `AgentManager`: add `private activityDir()` + `public removeEphemeralFootprint(name)` (row+log, idempotent, ephemeral-only doc).
- [x] T2 — Route `kill` through the helper (`wasAdhoc` before `adhoc.delete`; `!persistent` guard intact).
- [x] T3 — Route `dismissAdhoc` (`forgetAdhoc` then helper).
- [x] T4 — Route `dismissNode`; drop stale `Workspace.ts` import (`deleteActivityLog`).
- [x] T5 — **D-SCOPE A**: fix `extension.ts:1242` declared-Delete orphan via the helper.
- [x] T6 — Tests: helper row+log+idempotency, kill(ad-hoc) + dismissAdhoc retained (existing, still green), kill(declared) keeps log; `deleteActivityLog` idempotency already covered in `logStore.test.ts`.
- [x] T7a — `env -u TMUX npx vitest run` (975 ✓) + `npm run typecheck` (✓).
- [x] T7b — live dogfood (build/install `.vsix` 0.34.1 rebuilt, Reload): ad-hoc kill via Bridge with a seeded `.jsonl`+`.state.json` → BOTH deleted + ledger row gone, zero orphan. The declared-Delete path (D-SCOPE A) calls the same now-live-proven helper after the YAML delete; optional UI re-confirm left to maintainer.
- [x] Commit on branch — `2c30b8c` on `spec-247-remove-ephemeral-footprint`.

## Closure
**Closure:** Shipped to branch `spec-247-remove-ephemeral-footprint` (`2c30b8c`). One named `removeEphemeralFootprint` helper replaces the open-coded row+log pair at kill/dismissAdhoc/dismissNode; D-SCOPE=A also fixed the `extension.ts:1242` declared-Delete orphan (same drift class). 975 unit tests + tsc green; live ad-hoc-kill dogfood confirmed no orphan against the rebuilt 0.34.1 build. Pending: maintainer call on merge/PR + release version.
