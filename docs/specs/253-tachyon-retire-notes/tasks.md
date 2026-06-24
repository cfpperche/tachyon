# Spec 253 — tasks (build order)

Remove the `notes` surface; keep pins. Each step keeps `tsc ×2` + engine-boundary + the suite green.

**Verify:** `npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit && bash scripts/check-engine-boundary.sh && node esbuild.mjs && env -u TMUX npx vitest run`

## Steps

- [ ] **Step 1 — Engine + Bridge.** Drop `notesPath`/`getNotes`/`setNotes`/`ensureNotesFile` (+ the `notes.md` header comment) from `src/pins/PinStore.ts`, leaving pins untouched. Remove the `get_notes` + `set_notes` registrations and their `deps.pins.*` wiring from `src/bridge/tools.ts`, and scrub the `notes` mentions from the `wait_for_agent` description + the `set_continuity` comment. Update `test/unit/pins.test.ts` (drop the notes case, keep pins) + `test/unit/bridge.test.ts` (drop the get/set_notes round-trip + the two tool-list entries).
- [ ] **Step 2 — VS Code command.** Remove the `tachyon.openNotes` command: its `registerCommand` (+ `ensureNotesFile`) in `src/extension.ts`, its `contributes.commands` entry in `package.json`, and the `command.openNotes` title in `package.nls.json` + `package.nls.pt-br.json`.
- [ ] **Step 3 — Sidebar.** Remove the `.notes-row` button + the `"openNotes"` `GlobalOp` in `src/webview/sidebar/App.tsx`; the `openNotes` branch in `SidebarPrototype` `handleMessage` + the `getNotes()`-fed `notes` producer in `gatherOne`; the `notes: string` field on `FleetVM` in `src/sidebar/types.ts`; and the `.notes-row` CSS rules. Verify the sidebar still renders dark+light (render harness).
- [ ] **Step 4 — Agent guidance + init.** Scrub the notes teaching from `src/roles/templates.ts` (`bridgeGuidanceTail()` + the orchestrator preset's "keep the shared notes/checklist current" line) and the `spawn_agent` description ("save its result with set_notes") — route to pins / the handoff / files. Update the `notes.md` gitignore comment in BOTH `src/init/initLogic.ts` and `src/extension.ts`; fix the `init.test.ts` expectations for the new comment string.
- [ ] **Step 5 — Docs.** Remove/reword the notes mentions in `README.md` (MCP-tool table row), `site/index.html` (the two `get_notes`/`set_notes` tool cards), `package.json` (walkthrough "share pins & notes" → "share pins"), and `scripts/screenshots/runner.js` (the scene "save findings with set_notes").
- [ ] **Step 6 — Sweep + close.** The precise grep `grep -rE "get_notes|set_notes|openNotes|ensureNotesFile|\.tachyon/notes\.md|tachyon\.openNotes" src/ test/ package.json package.nls*.json README.md site/ scripts/` returns nothing (handoff `handoff-notes.jsonl` + `docs/specs/*/notes.md` deliberately not matched). Full verify green. Codex-review the diff; fold required fixes. Tick Acceptance; fill Closure.

## Closure
_(filled at ship)_
