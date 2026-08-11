# Cookbook — cockpit-single-app

_Operator/agent how-to for adding a new full-page editor surface to Control. Not the contract
(`spec.md`) and not build memory (`notes.md`). This pattern shipped 7 times (Approvals as the Phase A
pilot section, then 6 studios in Phase D) — the happy path below is the checklist that repeated each
time, not a one-off guess._

## When to use

- You're adding a new **section** (a flat Control tab — dashboard-style, one instance, no
  create/edit form) or a new **studio** (an entity-form route — `studio-new`/`studio-edit`, backed by
  an adapter with load/save/validate).
- You're retiring an old standalone `*Panel.ts` webview in favor of either shape.

## When not to use

- Plugin surfaces (`src/plugins/ui/host.ts`) stay standalone — security isolation (opaque-origin
  iframe), a standing exception, not a gap to close.
- The 2 dev-only spec-350 fakes (pipeline-studio, agent-fixture-studio) stay standalone — reachable
  only through the dev preview harness, never shipped to a real user.
- A one-off dialog or inline panel that isn't a full page doesn't need either shape — just a
  component.

## Happy path — new studio (entity-form route)

1. **Route id**: add the id to `STUDIO_IDS` in `src/cockpit/studioIds.ts` (the one runtime source —
   `StudioId` is derived from it, never hand-declared separately).
2. **Adapter**: write `WorkspaceXTarget` (`src/shell/XTarget.ts`) — the persistence contract
   (`loadX`/`saveX`, any attachment/media puts) — and `XAdapter implements StudioHostAdapter`
   (`src/webview/XAdapter.ts`) — the presentation adapter (`load`/`save`/`validate`/`titleFor`,
   `concurrency: {kind:"none"|"cas"}`, `dirty` hooks). Keep persistence and presentation in these two
   separate files, not merged.
3. **Registry entry**: add to `STUDIO_REGISTRY` in `src/cockpit/studioRegistry.ts` — `legacyViewType`
   (the retiring panel's old `createWebviewPanel` id, for the legacy-redirect serializer),
   `makeAdapter`, and `handleDomainMessage` if the studio has domain messages beyond the 9 core
   protocol types (import/attach/browse-style host actions) — write those in their own
   `src/cockpit/xDomain.ts`, dispatched from the registry entry.
4. **Client App**: write `src/webview/x-studio/App.tsx` against the SHARED studio protocol
   (`decodeStudioMessage`, `StudioDispatch`, `useStudioFreeze` for the nav-transaction freeze) — props
   are `{dispatch, routeKey, mountNonce, incoming?}`, decoding happens INSIDE the component, not
   pre-parsed by a caller. Mirror the nearest existing shape: `command-studio-shell/App.tsx` for the
   minimal case, `task-studio/App.tsx` for a rich-doc/Excalidraw editor with attachments.
5. **Register in Control**: `src/webview/cockpit/App.tsx` — a `lazy(() => import(".../App"))` block
   (co-loading its stylesheets via `loadSectionStylesheet` in the SAME order Cockpit.ts's eager
   `styles:` array uses — cascade order is a real contract, not cosmetics) and a
   `activeRoute.studio === "x"` branch in the studio render switch.
6. **CSS co-load**: `src/webview/Cockpit.ts` — an `xStudioIsActive` const, an eager `styles:` array
   entry, and matching keys in the `__tachyonSectionStyles` bootstrap-global map (one distinct key per
   client call site, even if two studios share a stylesheet — `cockpitCssParity.test.ts`'s parity
   check is a plain array compare, not set-based).
7. **CSP** (only if the studio needs it — most don't): request the MINIMUM grant
   (`imgBlob`/`connectSrc`/`workerSrc`/`childSrc` in `renderWebviewShell`'s options), and run the
   MANDATORY adversarial probe on the actual CSP diff before landing — see Fail-closed below.
8. **Retire the old panel**: reduce `src/webview/XPanel.ts` to a types-only stub (`VIEW_TYPE` +
   `PanelState`, nothing else); delete its manifest row in `src/webview/surfaces.ts`; remove its
   esbuild target and `main.tsx` (leave its `copyFileSync` calls — Control still co-loads the CSS);
   register its legacy-redirect serializer in `extension.ts` (`registerLegacyStudioRedirect` covers
   the generic case; write a bespoke one if the studio's "new" fallback isn't safe — e.g. Task's `id`
   is never optional).
9. **Tests**: delete the old panel-lifecycle test file (its SUT is gone); add an isolated
   `xDomain.test.ts` covering just the domain-message dispatch (generic lifecycle is already covered
   by `cockpitStudio.test.ts`); update `workspacePresentationBoundary.test.ts`'s migrated-surfaces
   list (move `XPanel.ts` out, keep `XAdapter.ts` in); update the dev-preview harness
   (`scripts/webview-preview/routes.ts` + a `fixtures/x-studio.ts`) and regenerate
   `routes.json` (`npx vite-node --script scripts/webview-preview/generate-routes.ts`).

## Happy path — new section (flat tab, no entity form)

Same shape, much smaller: add the id to `CockpitSectionId` (`src/cockpit/model.ts`), a body branch in
`cockpit/App.tsx`, CSS co-load in `Cockpit.ts`, and (if migrating an old panel) a
`registerTrustedPanelSerializer` redirect into `{section: "x"}`. See Approvals
(the Phase A pilot) or Validations for the smallest real examples.

## Tools / commands

| Action | Command | Notes |
|--------|---------|-------|
| Regenerate the preview catalog after adding/renaming a route or fixture | `npx vite-node --script scripts/webview-preview/generate-routes.ts` | writes `scripts/webview-preview/routes.json`; `webviewPreviewCatalog.test.ts` fails if it's stale |
| Verify the CSS co-load contract | `npx vitest run test/unit/cockpitCssParity.test.ts` | client/host key parity + per-studio cascade-order assertions |
| Verify the manifest + convention guard | `npx vitest run test/unit/webviewConvention.test.ts` | the primary "no un-manifested panel" guard |
| Router exhaustiveness (adding a StudioId) | `npx vitest run test/unit/sectionsRoute.test.ts` | drives every StudioId through decode/routeKey/parent/nav/refresh |

## Fail-closed / safety

- `decodeRoute` (`src/cockpit/route.ts`) is the ONE runtime decoder at every trust boundary (webview
  messages, persisted panel state) — rejects unknown/extra/missing fields, never guesses. Any new
  route field is MANDATORY (no optional fields) and validated here, not left to convention.
- A CSP grant is a PERMANENT, panel-wide change (`renderWebviewShell`'s `<meta>` tag is emitted once
  per Control panel lifetime, not per route) — never copy an old standalone panel's CSP config blind.
  Verify each directive against the actual code path that needs it (grep for the real `fetch`/`Worker`/
  `Blob` call), and run a mandatory adversarial probe on the diff before landing — explicit maintainer
  security acceptance is required, recorded in the task journal.
- The navigation-transaction FSM (`studioHost.ts`) freezes a dirty form during any navigation attempt
  and requires an explicit Save/Discard/Stay resolution — never bypass it with a direct route mutation.

## Cleanup

1. Prefer the generic `registerLegacyStudioRedirect` helper over a bespoke serializer unless the
   studio's "new" session genuinely can't be constructed id-less (mirror Task Studio's bespoke one if so).
2. After retiring a panel, grep the WHOLE tree for its old view type string and manager class name —
   a stray import or manifest row is a silent drift, not a build error (TS won't catch a leftover
   test asserting behavior of a class that no longer exists until you delete it).
3. Run the full suite + typecheck + a production build (`npm run build`) before landing — the CSS
   co-load and CSP tests only catch drift in the SOURCE, not a genuinely broken bundle.

## See also

- Contract: [`spec.md`](./spec.md)
- Design (studios, the router, the nav-transaction FSM, the returnRoute mechanism):
  [`studios-routes-design.md`](./studios-routes-design.md)
- Build history / per-PR decisions: [`notes.md`](./notes.md), [`tasks.md`](./tasks.md)
- Nearest real examples: `src/cockpit/route.ts`, `src/cockpit/studioRegistry.ts`,
  `src/webview/command-studio-shell/` (minimal studio), `src/webview/task-studio/` (richest studio:
  rich-doc + Excalidraw + CAS + attachments)
