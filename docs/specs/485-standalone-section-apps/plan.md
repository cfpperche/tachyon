# 485 — standalone-section-apps — plan

_Drafted from `spec.md` on 2026-08-02. The approach, not the steps (those go in `tasks.md`)._

## Approach

Two prerequisite phases land before any surface moves, then surfaces move one PR at a time, then
Control is removed. The order is not preference: **A** is what keeps the design system enforceable
once "one runtime" stops being the mechanism, and **B** is what stops N apps from multiplying the
event cost this project spent 2026-08-02 reducing. Migrating first and hardening after is how the
2026-07-18 drift comes back.

### Phase A — the conformance contract (no surface moves)

Extend `WEBVIEW_SURFACES` (spec 279) so each surface declares its **posture** (`conform` / `extend` /
`replace`), and, for `extend`, which extension points it uses. Generalize
`webviewConvention.test.ts` — which already requires `main.tsx` + a built entry per converted
surface and already catches new `createWebviewPanel` calls — so an **undeclared** departure fails:
own page chrome, own pad/token values, mounting outside the shared shell. `replace` passes with a
non-empty reason; silence does not.

Also in A, because the contract is only credible if the shell can actually be extended: give
`renderWebviewShell` / the page frame real, named extension points, and prove at least one real
surface uses `extend`. A shell nobody can extend is a shell people will replace.

### Phase B — visibility gating (no surface moves)

`onDidChangeViewState` appears **nowhere** in the repo today, and `StudioPanelManagerBase.ts:160`
and `Cockpit.ts:1191` both set `retainContextWhenHidden: true` — so the panels that exist keep
working while hidden. Add gating at the manager layer: a hidden panel runs no refresh, no
collection, no subscriber callback, and posts no model; on reveal it catches up by journal delta
where the window covers it and by full resync where it does not.

This is worth landing on its own merits — it improves today's `AgentPanePanel` and Control — and it
must exist before the app count grows.

### Phase C — the generic manager and the first two apps

One `SectionPanelManager`, configured from the manifest entry, keyed by `viewId + project +
identity`, with **cardinality as a parameter**: a dashboard is one panel per section per project; a
document is one panel per identity. It creates panels through the shared shell and persists the
minimum state `registerTrustedPanelSerializer` needs.

The first two apps are the two motivating cases, in this order:

1. **Task detail** — the document kind, and the case that the "twelve sections" framing would have
   missed entirely. Proves multi-instance and the identity rule.
2. **Board** — the dashboard kind, and the case the maintainer named first (Board beside a terminal).

Stop here and use it for a few days before continuing. If side-by-side does not feel like what the
use wanted, the remaining ten sections have not been touched and the spec's `Done` can narrow
without betraying the intent. This checkpoint is the cheapest information in the whole plan.

### Phase D — the remaining ten dashboards, one PR each

Same shape each time: app lands, launcher and `tachyon.*` commands point at it, old restore state
and deep links become redirects, that section's renderer leaves `cockpit/App.tsx`. A compatibility
shim with no UI may survive; two live renderers may not.

The project selector moves to the sidebar Control tab header in the PR that first needs it (likely
Phase C's Board), with `controlWorkspaceScope.test.ts` re-anchored in the same change.

### Phase E — remove Control

Once the last surface has moved: the internal router, `navEpoch`, the singleton claim
(`cockpitSingleton.ts`), the subroute breadcrumb chrome, `Cockpit.ts` itself, and the cockpit entry.
Record in `docs/specs/410-cockpit-single-app/spec.md` that its app-count decision was superseded
here, so a future reader finds the reversal from either direction.

## Key decisions

- **Conformance contract before migration** — chosen because 410's own sentence ("a shared kit cannot
  enforce one runtime when every surface is a peer app") is the load-bearing risk of this reversal;
  rejected *migrate first, harden later* because that is precisely the sequence that produced the
  drift 410 was written to end.
- **Three postures (conform / extend / replace), failing only on silence** — chosen because a
  contract with no supported way out gets worked around, and a worked-around contract enforces
  nothing; rejected *conform-or-exception* because it makes every real need an exception and trains
  the reader to ignore the list.
- **One generic manifest-driven manager, cardinality as a parameter** — chosen because both
  independent consults reached it and because the conformance contract can then inspect a manifest
  instead of twelve heterogeneous classes; rejected *twelve hand-written managers* (recreates the
  triplication `StudioPanelManagerBase` ended) and *one singleton section manager* (Control with a
  new name; fails two task details).
- **One entrypoint per app, single esbuild invocation with `splitting: true`** — chosen because it
  isolates bootstrap, error boundary and CSS per app while Preact and the kit stay shared chunks;
  rejected *one bundle with twelve lazy mounts* (shared shell/listener/state/error boundary is
  code-splitting, not app isolation — codex) and *twelve independent IIFE builds* (prevents chunk
  extraction and genuinely reopens 410's budget hole — grok).
- **Project selector in the sidebar Control tab header** — chosen because the Agents tab already
  carries its filter in that exact slot, so it lands as `conform` rather than a new component, and
  one control cannot diverge from itself; rejected *stay in Overview* (needs an app open to
  configure the others) and *one per app* (twelve competing controls over a global concept, the
  divergence t-46eb4f closed). Maintainer decision, 2026-08-03.
- **A document's identity is fixed at open** — chosen because `route.ts:37` already treats a task
  detail's `wsHash` as identity; rejected *the selector retargets open documents* because two task
  details side by side would silently become different documents when the human touches a dropdown.
- **Atomic cutover per surface** — chosen as the mirror of the discipline 410 proved, and because
  Control's host state is global (`panel`, `currentRoute`, `navEpoch`), so a surface in both places
  means two subscriptions and two answers to one command; rejected *dual rendering paths* (Approvals
  already wore that scar) and *big-bang* (widens the blast radius, abandons a proven cadence).
- **Pilot checkpoint after the first two apps** — chosen because it buys the answer to "is this what
  the use wanted" at 2/12 of the cost; rejected *straight through all twelve* because it spends the
  whole budget before the first real feedback. **Strike this if the maintainer prefers the direct
  path** — it is insurance, not a technical requirement.

## Files touched

| File | Change |
|---|---|
| `src/webview/surfaces.ts` | posture + extension-point declaration per surface; the contract's authority |
| `test/unit/webviewConvention.test.ts` | generalize to fail on undeclared departures |
| `test/unit/cockpitBundleBudget.test.ts` | successor: per-app eager entry + reachable total, manifest-driven |
| `src/webview/shared/shell.ts` | named extension points so `extend` is real |
| `src/webview/shared/studio/StudioPanelManagerBase.ts` | visibility gating; source of the generic manager's shape |
| `src/webview/SectionPanelManager.ts` *(new)* | the generic manager; cardinality as a parameter |
| `esbuild.mjs` | multi-entry build with `splitting: true` |
| `src/webview/sidebar/App.tsx` | project selector into the Control tab header row |
| `test/unit/controlWorkspaceScope.test.ts` | re-anchor the selector's testid away from `cockpit/App.tsx` |
| `src/extension.ts` | `tachyon.*` commands open apps; legacy serializers redirect |
| `src/webview/cockpit/App.tsx`, `src/webview/Cockpit.ts` | shrink per PR, removed in Phase E |
| `docs/specs/410-cockpit-single-app/spec.md` | record the supersession |

## Risks & unknowns

- **The road is far less built than the first draft assumed.** Six "standalone panels" are 13–43 line
  tombstones with zero `createWebviewPanel`; only `AgentPanePanel` is live. Phase C is building a
  pattern, not restoring one. Verify early by making task detail work end to end before promising
  the other eleven.
- **CSS bleed returns if the contract is weak.** 410 named it as a symptom of peer apps. Per-app CSS
  with a shared kit graph is the intent; `cockpitCssParity.test.ts` / `lazySectionStyles.test.ts` are
  the machinery to repoint rather than reinvent.
- **Restore across reload, N panels.** Spec 361 established the machinery for first-party panels; it
  has not been exercised at twelve simultaneous panels across editor groups.
- **Deep links and command redirects.** Today `tachyon.*` open-commands redirect *into* Control. Each
  must become an app open with no dead redirect left behind — easy to half-do and hard to notice.
- **The Overview JUMP card is a second navigation surface** (left open deliberately by t-aa2780).
  Phase D should decide whether it survives, mirrors the launcher, or goes.
- **Unmeasured:** what a hidden-but-retained webview actually costs in memory at twelve panels. The
  spec's criterion is zero *work*, not zero cost; if retained memory turns out to matter, the fix is
  `retainContextWhenHidden: false` plus restore-on-reveal, which spec 361's machinery already allows.

## Visual impact

Every phase after B is visible. Per the convention agreed with the maintainer on 2026-08-02
(handoff note), each surface PR captures preview screenshots and the maintainer sees them **before**
the release — validation is part of `done`, not polish. The convention has already paid twice: a 1px
border that made the launcher grid read as a grafted widget (t-6e2952), and an Overview action row
that clips at 360px (t-89ecfe), neither of which any test would have caught.

## Sources consulted

- `docs/specs/410-cockpit-single-app/spec.md` (Intent, Closure) and `plan.md` (Phase C mandate, Key
  decisions) — the decision being reversed, and its reasons.
- `docs/specs/485-standalone-section-apps/evidence/opiniao-grok.md` and `opiniao-codex.md` — two
  independent consults, kept verbatim; this plan cites them rather than restating them.
- `src/webview/surfaces.ts`, `src/webview/shared/studio/StudioPanelManagerBase.ts`,
  `src/webview/shared/shell.ts`, `src/webview/shared/panelSerializer.ts`, `src/webview/Cockpit.ts`,
  `src/webview/cockpit/App.tsx`, `src/cockpit/sectionNav.ts`, `src/cockpit/route.ts`, `esbuild.mjs`.
- `test/unit/webviewConvention.test.ts`, `test/unit/cockpitBundleBudget.test.ts`,
  `test/unit/controlWorkspaceScope.test.ts`.
- Panel tombstones verified by direct count: `AgentStudioPanel` 15 lines, `PinStudioPanel` 14,
  `CommandStudioPanel` 13, `ActivityPanel` 16, `HandoffPanel` 15, `ApprovalPanel` 43, all with zero
  `createWebviewPanel`; `AgentPanePanel` 470 with one.
- t-b51923 (the 30 events/s storm and its fix) for why visibility gating precedes app growth.
