# Spec 259 — Tasks

**UI impact:** ui — sidebar layout behavior.

**Verify:** `npm test && npm run typecheck && npm run build`

## Implementation

- [x] 1. Change the sidebar shell CSS so `html`, `body`, and `#root` own the viewport height without body scrolling.
- [x] 2. Make `.panel.active` the only vertical scroll container and keep shell controls/footer outside that scroll.
- [x] 3. Remove the body padding workaround for the formerly fixed Bridge footer.
- [x] 4. Build the sidebar bundle and ensure existing row reveal code still targets the active panel through `scrollIntoView()`.

## Verification

- [x] Run the focused sidebar/webview checks.
- [x] Run full test, typecheck, and build.
- [x] Package the local VSIX.

## Notes

- DOM probe against the rendered sidebar fixture: `bodyScrollable=false`, `.panel.active` has `overflow-y:auto`, the panel is scrollable, and tabs/footer keep the same viewport position after changing `panel.scrollTop`.
