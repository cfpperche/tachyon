# 414 — browser-user-companion — notes

_Created 2026-07-19._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Provenance

- 2026-07-19 — Human pin `p-2112a8`: discuss browser extension module that talks to Tachyon bridge/engine.
- 2026-07-19 — Discussion with `grok`: companion vs agent-browser, MVP, security, phases.
- 2026-07-19 — SDD scaffold `414-browser-user-companion`; design task `t-dec8a9`.
- 2026-07-20 — Maintainer agreed lean on all open questions + hybrid repo strategy +
  `tachyon-companion` as classic monorepo (browser now, mobile next). ADE monorepo assessment
  recorded separately (`docs/architecture/tachyon-monorepo-assessment.md`, `t-e4348c`).
- 2026-07-20 — Phase 0 execution on isolated worktree `tachyon/change/companion-track`
  (one WT for the entire companion track): ratify `spec.md`, write `plan.md`, decompose board tasks.

## Design decisions

- **Two-product split** — agent-browser = agent CDP; Companion = human browser ↔ engine.
- **v1 = pair + send-tab + approvals** — not capture-only; not RPA.
- **Human-push only in v1** — no `user_browser_*` until v1.1.
- **Loopback spike** — do not block on full `t-784bc8`.
- **One active pair** — multi-engine later.
- **Task/evidence for captures** — not pins; no new evidence kind in v1.
- **Product name Tachyon Companion**; clients repo `tachyon-companion`; SDD/code slug browser-user-companion.
- **Standalone product line**, sibling of `t-fe52f0` (not a child task).
- **Hybrid repos** — engine in `tachyon`; clients in companion monorepo.
- **Track worktree** — all ADE companion work on `companion-track` until slices land.
- **Agents never see cookies** — authorized fields only.
- **Approval UI is presentation; host remains authority**.

## Deviations

_None yet (design/plan only)._

## Implementation log

- 2026-07-20 — **Slice 1 complete (`t-32c627`)**: public monorepo
  https://github.com/cfpperche/tachyon-companion (`main` @ 59e1119). Layout:
  `apps/browser` MV3 unpacked shell, `apps/mobile` reserved, `packages/protocol`,
  `packages/api-client`, CI, PRIVACY.md. Local path `/home/goat/tachyon-companion`.
  `npm run typecheck` + `pack:browser` green. Pairing deferred to slice 2.
- 2026-07-20 — **Slice 2 complete (`t-77ce07`)** on ADE branch `tachyon/change/companion-track`:
  - `CompanionPairingService` + HTTP at `http://127.0.0.1:<bridgePort>/companion/v1/*`
  - Endpoints: health, pair, status, unpair (capture/approvals → 501 until slices 3–4)
  - protocolVersion=1 fail-closed; short-lived pair codes; one active session; companion token ≠ Bridge token
  - Command `tachyon.pairCompanion` / query `companion.pair-code` (Control-equivalent affordance)
  - Focused tests: `test/unit/companionPairing.test.ts` (5/5)
  - Client: companion monorepo pair UI pushed (`902b9e1`)

## Tradeoffs

- **Human-push vs agent-pull** — v1 human-push for consent clarity; agents still get context via Tasks.
- **Loopback vs full service layer** — speed of dogfood vs eventual generalization; extract contract after spike.
- **Companion monorepo vs ADE monorepo** — multi-app clients need workspaces; ADE packaging cost is separate (`t-e4348c`).

## Open questions

_Phase 0 product forks closed in `spec.md` § Open questions → Decisions._

Implementation unknowns (transport details, exact Control entrypoint, CORS on loopback) land during
pairing spike and are appended here.
