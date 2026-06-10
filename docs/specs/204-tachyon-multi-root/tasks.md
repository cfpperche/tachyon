# 204 — tachyon-multi-root — tasks

_Generated 2026-06-10._

## Implementation

- [x] 1. Extract Workspace class (+notify); per-workspace ticker/engine/watchers; dispose
- [x] 2. extension.ts registry + folder add/remove lifecycle + activation scan
- [x] 3. Sidebar providers over `() => Workspace[]`; folder roots when >1; items carry ws; per-ws item ids
- [x] 4. Command targeting: item.ws (plain-object fallback), wsHash args, folder QuickPick; status bar ×N; badge sums
- [x] 5. Multi-root fixture + host suite (6 scenarios); dogfood second folder + walkthrough; 0.4.4

## Verification

**Verify:** `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'`

- [x] Unit 188/188 (unchanged)
- [x] Single-root xvfb suite 23 passing — UNTOUCHED (phase-1 gate)
- [x] Multi-root xvfb suite 6 passing (distinct hashes/Bridges, scoped listings, isolation on kill, independent auth)
