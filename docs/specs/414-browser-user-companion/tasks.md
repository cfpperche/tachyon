# 414 — browser-user-companion — tasks

_Updated 2026-07-21 after browser MVP ship (shipped)._

## Phase 0 — Design

- [x] Scaffold SDD `414-browser-user-companion`
- [x] Concept brief + design acceptance
- [x] Maintainer lean recorded; open questions → Decisions in `spec.md`
- [x] Repo strategy (ADE + `tachyon-companion` monorepo multi-app)
- [x] Real `plan.md` + delivery slices
- [x] Isolated ADE track worktree `tachyon/change/companion-track` (merged; prune after close)
- [x] Board design task `t-dec8a9` + implementation follow-ups

## Phase 1 — Implementation (v1 browser MVP)

| Slice | Board | Title | Status |
|---|---|---|---|
| 1 | `t-32c627` | Scaffold monorepo `tachyon-companion` | done |
| 2 | `t-77ce07` | Engine protocol + loopback pairing + Control pair code | done |
| 3 | `t-523405` | Send prompt to active agent (idle-safe) + tab capture lineage | done |
| 4 | `t-a45c6b` | Approvals list + host-authoritative resolve | done |
| 5 | `t-725317` | Unpacked Chromium dogfood | done |

- [x] **Slice 1 — `t-32c627`** Scaffold `tachyon-companion` monorepo — https://github.com/cfpperche/tachyon-companion
- [x] **Slice 2 — `t-77ce07`** Engine protocol + loopback pairing — `/companion/v1` + pair code
- [x] **Slice 3 — `t-523405`** Send prompt / tab context path (cookie-free)
- [x] **Slice 4 — `t-a45c6b`** Approvals list + resolve (host-authoritative)
- [x] **Slice 5 — `t-725317`** Unpacked Chromium dogfood (pair → send → approve)

### Tab / agent-pull follow-through (beyond original v1 human-push)

| Board | Title | Status |
|---|---|---|
| `t-88a17c` | content script + host bridge | done |
| `t-2a7010` | agent tool surface — tab snapshot | done |
| `t-fbe280` | actions click/type/fill | done |
| `t-e05d2d` | trust policy + permissions UX | done |
| `t-5c77bd` | console / MAIN world (escalation) | done |
| `t-a0f81d` | dogfood loop agent drives user tab | done |
| `t-2d0e23` | design system `packages/browser-ui` | done |
| `t-32b1de` | Control Connected devices | done |

Settings: `settings.companion.tabTools` + Connected devices UI (main `c26baecf` / 0.56.88).

## Deferred / out of this SDD's closed MVP

Not open work on this SDD (no unchecked delivery boxes). Track on sibling board tasks / future slices:

- **Board backlog umbrella:** `t-cb36c5` (414/420 long-tail inventory)
- Agent-pull hardening beyond fixture hosts (broader trust policy)
- Firefox package
- Multi-engine picker
- `apps/mobile` real client — board: `t-fe52f0`, `t-619157`
- Store submission
- Companion Audit trail surface ("coming soon" residual)

## Verification

- [x] Design criteria in `spec.md` checked for Phase 0
- [x] Product v1 scenarios in `spec.md` checked (with evolution notes)
- [x] Focused tests for pairing on ADE side (`test/unit/companionPairing*.test.ts` lineage)
- [x] Companion monorepo typecheck/pack green (shipped as 0.4.8)

**Verify:** `npm run test:unit -- test/unit/companionPairing` (ADE; extend as surface grows)

**Dogfood-Opt-Out:** no single headless end-to-end (requires real Chromium extension + live engine).  
**Human dogfood:** pair/unpair + tabTools toggle + Connected devices + actuation fixture — see `notes.md` (2026-07-20…21).

Evidence: `.tachyon/evidence/companion-414/pair-unpair-dogfood-2026-07-20.png` + maintainer Connected devices / tabTools dogfood 2026-07-21.
Verdict: pass (browser MVP UI).

**Cookbook-Opt-Out:** operator path is Control Settings + unpacked extension load; full cookbook deferred until store packaging.

