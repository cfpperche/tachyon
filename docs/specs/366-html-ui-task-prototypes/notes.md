# 366 — html-ui-task-prototypes — notes

_Created 2026-07-09._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

### 2026-07-09 - codex - Claude Fable plan fold

Fable reviewed the initial spec/plan/tasks in `.tachyon/reviews/366-html-ui-task-prototypes-fable.md` and returned
REVISE BEFORE DELEGATION (4 blockers, 6 majors, 5 minors). Folded decisions:

- Interactive HTML is conditional on both a server request-counter proof and blocking evidence in a real VS Code
  webview. Failure or unavailable proof selects static-only v1.
- Prototype validation is a standalone strict policy; it does not inherit `entryHtmlValidator` as a policy floor.
- Agents create drafts only and cannot name `supersedes`; approval/demotion remains first-party.
- The manifest, not the task journal or `awaitingHuman`, is the authoritative decision record.
- v1 lifecycle is only `draft | approved | superseded | rejected`; `implemented`/`archived` were cut.
- Prototype blobs use their own `prototypes/<sha256>` directory to avoid rich-doc GC coupling.
- `awaitingHuman` gains an optional exact prototype subject and remains advisory; task status changes cannot alter
  manifest decision state.
- Static frames require four-sided first-party containment and an over-frame watermark; interactive bundles require
  synchronous nonce capture, zero message listeners, and no `allow-same-origin`/prototype `unsafe-inline` scripts.

## Deviations

None yet.

## Tradeoffs

Interactive fallback intentionally permits a complete static-only v1. A functional mock remains inspectable and
approvable, but click behavior waits until Tachyon can prove that arbitrary frame navigation creates zero egress in
the real Electron/VS Code host.

## Open questions

No product fork blocks implementation. T3 owns the empirical interactive/static result.
