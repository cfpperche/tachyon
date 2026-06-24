# Spec 258 — Tasks

**UI impact:** ui — inline copy action in the Pins sidebar row.

**Verify:** `npm test`

- [x] Add a pin-row copy action in `src/webview/sidebar/App.tsx`.
- [x] Handle `pin:copy` in `src/webview/SidebarPrototype.ts`.
- [x] Copy exactly `ID: <id>\nTitle: <title>` from the host using `PinStore` title as source of truth.
- [x] Add unit coverage for the clipboard payload and stale webview-title fallback.
- [x] Run typecheck, tests, build, and package the VSIX.

## Closure

Shipped as a narrow sidebar affordance. No storage, Bridge, pin CRUD, rich-detail, attachment, or handoff behavior changed.
