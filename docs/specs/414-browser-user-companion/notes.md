# 414 — browser-user-companion — notes

_Created 2026-07-19._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Provenance

- 2026-07-19 — Human pin `p-2112a8`: discuss browser extension module that talks to Tachyon bridge/engine; what doors it opens for agents/automation.
- 2026-07-19 — Free-run discussion with agent `grok`: product framing (user companion vs agent-browser), value for project assist, security, phased MVP, architecture sketch.
- 2026-07-19 — Seed scaffolded via SDD `new browser-user-companion` → `docs/specs/414-browser-user-companion/`. Design board task `t-dec8a9` created. Spec filled as concept brief + draft acceptance for **design ratify**, not product ship.
- Related already on board/specs: `t-fe52f0` (cockpit + mobile companion), agent-browser 267/268/271, system-design engine/shell split, external-client gap (`t-784bc8` lineage).

## Design decisions

- **Two-product split is non-negotiable in the seed** — agent-browser stays agent-owned CDP; this companion is human browser ↔ engine. Avoids trust/session confusion.
- **v1 = companion (pair + capture + approvals), not RPA** — actuation deferred to phase v3 with trust policy.
- **Agents never see cookies** — captures are human-authorized content fields only.
- **Approval UI is presentation; host remains authority** — same anti-laundering posture as Control → Approvals.
- **plan.md / tasks.md left deferred** until maintainer ratifies open questions in `spec.md` — avoids fake implementation plans.

## Deviations

_None yet (seed only)._

## Tradeoffs

- **Human-push vs agent-pull capture** — seed recommends human-push only for v1 (simpler consent story); agents still get context via Task artifacts without a live DOM channel.
- **Block on full service-layer vs loopback spike** — left open; product value can be dogfooded on loopback, productionization wants external-client substrate.

## Open questions

_See `spec.md` § Open questions (maintainer-owned forks)._
