# Spec 253 — retire `notes` (the dead third coordination surface)

**Status:** shipped
**Closure:** Commit `cc759931` records notes retired with pins and handoff intact after design debate and implementation review.
**Status detail:** SHIPPED 2026-06-24 (notes removed; pins + handoff intact; codex-debated + codex-reviewed).
**Surface:** remove the free-form shared `notes` whiteboard (`.tachyon/notes.md` + `get_notes`/`set_notes` + the sidebar notes-row) — the dominated middle wheel between **pins** (structured checklist) and the **project handoff** (curated narrative state, spec 245). Pins stay fully intact.
**UI impact:** ui (the sidebar loses the notes-row; no other panel changes).
**Verify:** `npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit && bash scripts/check-engine-boundary.sh && node esbuild.mjs && env -u TMUX npx vitest run`

> **Origin.** Spec **192** shipped two coordination surfaces together: **pins** (a structured shared checklist — discrete items with id/author/done-state) and **notes** (a single free-form `.tachyon/notes.md` "whiteboard", set wholesale via `set_notes`). Spec **245** later shipped the **project handoff** (`.tachyon/HANDOFF.md` — curated state in sections, fed by an append-only pending-note lane that the owner distills, with staleness + CAS). The handoff covers notes' *stated* coordination purpose — *"work division, do-not-touch zones, decisions"* — with a model built for concurrency. Notes was never retired, leaving a **three-way overlap** (pin / note / handoff) and confirmed dead in practice (maintainer dogfood: pins saw heavy use; `notes.md` did not).

## Problem

Three surfaces overlap, so every agent and human pays a "pin, note, or handoff?" decision tax. **Notes is the dominated one — and what it does uniquely is a workflow we want to retire, not preserve:**

- For **discrete, trackable items** → **pins** win (ids, done-state, checklist UI). Notes can't track an item.
- For **narrative coordination state** (work division, do-not-touch, decisions) → the **project handoff** wins. Its `append_project_handoff_note` + owner-distill was the explicit fix for the exact hazard `set_notes` still has: **`set_notes` REPLACES the whole file** (`writeFileSync`, no merge/CAS) — *"call get_notes first and merge"* is a manual CAS the tool never enforces. In a multi-agent fleet (where Tachyon lives), wholesale replace is a clobber/race footgun.

The one thing notes does that the handoff does NOT is be a **free-form, uncapped (50k) shared scratchpad** — e.g. an agent dumping a long child result for a sibling to read. That is NOT a gap the handoff should fill (its notes are short, typed `summary`+`evidence` deltas by design). It is a workflow we are **deliberately retiring**: long results belong in a **file** or are read via **`read_output`**; project-state deltas go to the **handoff**; discrete items go to **pins**. So removing notes is a routing decision, not a capability loss.

## Goal

Remove the `notes` surface entirely. **Pins stay intact** (different data shape, proven useful). Coordination routes to the **handoff** (narrative state) + **pins** (discrete items); long free-form content routes to files / `read_output`. Re-point all agent guidance accordingly. Existing `.tachyon/notes.md` files are **left untouched on disk** (we never delete user data) — they are simply no longer read, written, or surfaced. The result is a clean two-surface model with a crisp boundary: **pins = structured trackable items · handoff = curated narrative state.**

## Decisions

- **D1 — Remove, don't deprecate.** Notes is dead; a deprecation shim would just add surface. Cut the tools, the store methods, and the UI outright.
- **D2 — Pins are untouched.** Only `notes` is carved out of spec 192's pins+notes pair. `PinStore`'s pins CRUD, `create_pin`/`list_pins`/`complete_pin`/`update_pin`, and the sidebar pin section are unchanged.
- **D3 — Re-point agent guidance.** `bridgeGuidanceTail()` drops `set_notes/get_notes` and names the surviving coordination surfaces (the project handoff via `append_project_handoff_note`, plus pins).
- **D4 — Don't touch user files.** Stop reading/writing `.tachyon/notes.md`; any existing file stays (harmless, ignored). Update the init gitignore comment so it no longer cites `notes.md` as a shareable Tachyon file (pins.json stays cited).
- **D5 — Stale-agent calls degrade gracefully (no crash).** An agent mid-session whose context still teaches `get_notes`/`set_notes` may call them after the upgrade. Removing a tool registration means the MCP server answers with a normal **unknown-tool error** (method-not-found) — it must NOT crash the Bridge or the extension. We verify the tools are absent from the registered set; the release notes route the old workflow to pins / handoff / files. (Also keep the handoff's OWN `notesPath`/`readNotes`/`parseNotes` — those operate on `.tachyon/handoff-notes.jsonl`, a different surface — fully intact.)
- **D6 — Docs follow the code.** The README MCP-tool table, the site tool list, the package walkthrough copy, and the screenshot-scene fixture all advertise notes; they are updated/removed in the same change so the docs never describe a tool that no longer exists.

## Acceptance

- [x] The `get_notes` and `set_notes` MCP tools are removed; the Bridge no longer registers them, and their `deps.pins.getNotes/setNotes` wiring is gone. The `wait_for_agent` + `spawn_agent` descriptions no longer cite `get_notes`/`set_notes`, and the `set_continuity` tool comment no longer contrasts with "notes".
- [x] `PinStore` has no notes members (`notesPath` / `getNotes` / `setNotes` / `ensureNotesFile` + the `notes.md` header comment reworded); pins CRUD + storage are byte-for-byte behaviorally unchanged.
- [x] The `tachyon.openNotes` VS Code command is gone: its registration in `extension.ts` (and the `ensureNotesFile` call), its `contributes.commands` entry in `package.json`, and the `command.openNotes` title in `package.nls.json` + `package.nls.pt-br.json`.
- [x] The sidebar no longer renders the notes-row: the `.notes-row` button + the `"openNotes"` `GlobalOp` in `App.tsx`, the `openNotes` branch in the `SidebarPrototype` global handler + the `getNotes()`-fed `notes` producer in `gatherOne`, the `notes: string` field on `FleetVM` (`types.ts`), the SAMPLE `notes` literal, and the `.notes-row` CSS rules.
- [x] All agent guidance stops teaching notes: `bridgeGuidanceTail()` (`roles/templates.ts`) + the orchestrator role-preset line + the `spawn_agent` description all route to pins / the handoff / files instead.
- [x] Docs no longer advertise notes: the README MCP-tool table row + the whole delegation/shared-memory guide, the `site/index.html` tool cards + Pins-section copy, the `package.json` walkthrough copy, and the `scripts/screenshots/runner.js` scene fixture are removed/reworded.
- [x] The init gitignore comment (and the `extension.ts` gitignore comment) no longer cite `notes.md` (pins.json stays cited as shareable); `init.test.ts` expectations updated to match.
- [x] Stale-agent safety: with the tools gone, `get_notes`/`set_notes` are absent from the registered tool set (asserted in `bridge.test.ts` + the `auth.test.ts` count 28→26); a call to them returns an unknown-tool error without crashing the Bridge/extension.
- [x] The handoff's own pending-notes lane is untouched: `ProjectHandoffStore`'s `notesPath`/`readNotes`/`parseNotes` (over `.tachyon/handoff-notes.jsonl`) + `projectHandoff.test.ts` stay green.
- [x] Pins tests stay green; notes-specific tests are removed. The verification grep `grep -rE "get_notes|set_notes|openNotes|ensureNotesFile|\.tachyon/notes\.md|tachyon\.openNotes" src/ test/ package.json package.nls*.json README.md site/ scripts/` returns **nothing**.
- [x] No behavior change to pins or the handoff; `tsc ×2` + `check-engine-boundary.sh` + `esbuild` + the full suite (1228 tests) stay green.
