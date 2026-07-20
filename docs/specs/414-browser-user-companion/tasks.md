# 414 — browser-user-companion — tasks

_Updated 2026-07-20 after design ratify. Work top-to-bottom per plan slices._

## Phase 0 — Design (this commit)

- [x] Scaffold SDD `414-browser-user-companion`
- [x] Concept brief + design acceptance
- [x] Maintainer lean recorded; open questions → Decisions in `spec.md`
- [x] Repo strategy (ADE + `tachyon-companion` monorepo multi-app)
- [x] Real `plan.md` + delivery slices
- [x] Isolated ADE track worktree `tachyon/change/companion-track`
- [x] Board design task `t-dec8a9` + implementation follow-ups (see board)

## Phase 1 — Implementation (v1)

| Slice | Board | Title |
|---|---|---|
| 1 | `t-32c627` | Scaffold monorepo `tachyon-companion` |
| 2 | `t-77ce07` | Engine protocol + loopback pairing + Control pair code |
| 3 | `t-523405` | Send tab → create_task (cookie-free) |
| 4 | `t-a45c6b` | Approvals list + host-authoritative resolve |
| 5 | `t-725317` | Unpacked Chromium dogfood |

- [x] **Slice 1 — `t-32c627`** Scaffold `tachyon-companion` monorepo — public repo https://github.com/cfpperche/tachyon-companion (2026-07-20)
- [x] **Slice 2 — `t-77ce07`** Engine protocol + loopback pairing — `/companion/v1` on Bridge listener + `tachyon.pairCompanion` (2026-07-20)
- [ ] **Slice 3 — `t-523405`** Send tab → create_task (URL + title; no cookies)
- [ ] **Slice 4 — `t-a45c6b`** Approvals list + resolve (host-authoritative)
- [ ] **Slice 5 — `t-725317`** Unpacked Chromium dogfood (pair → send → approve)

## Post-v1 (do not start in v1)

- [ ] Agent-pull `user_browser_*` + human confirm prompt
- [ ] Screenshot → task evidence (273/274)
- [ ] Firefox package
- [ ] Multi-engine picker
- [ ] `apps/mobile` real client
- [ ] Store submission

## Verification

- [x] Design criteria in `spec.md` checked for Phase 0
- [ ] Product v1 scenarios in `spec.md` checked when slices land
- [ ] Focused tests for pairing + capture on ADE side
- [ ] Companion monorepo typecheck/pack green

**Verify:** _(add when implementation has a mechanical command, e.g. focused vitest for pairing)_

**Dogfood-Opt-Out:** design-only commits have no runtime dogfood.  
**Human dogfood:** after slices 2–4 — unpacked Chromium + local engine; steps in slice 5.

**Visual QA Opt-Out:** Phase 0 docs only.  
**Visual QA:** required for companion popup + Control pair affordance when UI lands (Evidence/Verdict in notes).

**Cookbook-Opt-Out:** no operator tools until pairing ships; then add cookbook for pair/send/approve.
