# Spec 258 — Sidebar pin copy

**Status:** shipped
**Closure:** Landed in commit `685fdc96`; every implementation task is checked and `tasks.md` records closure.
**Status detail:** SHIPPED.
**Follows:** spec 237 sidebar webview and spec 255 rich pins.
**Surface:** Pins section in the Tachyon sidebar.
**UI impact:** ui (one inline pin-row action).

## Intent

The Pins sidebar is the fastest place to hand a pin reference to another agent or to a terminal prompt, but today the user must open/edit the pin or manually copy the visible title. Add a compact inline action on each pin row that copies the pin's durable ID plus the displayed title to the OS clipboard.

## Acceptance

- Scenario: Copy a pin reference
  - Given a pin row with ID `p-123abc` and title `Pin Studio rich pins`
  - When the user clicks the inline copy action on that row
  - Then the OS clipboard contains exactly:
    ```text
    ID: p-123abc
    Title: Pin Studio rich pins
    ```
- Scenario: Source of truth
  - Given the webview sends a stale title label
  - When the host handles `pin:copy`
  - Then it reads the current title from `PinStore` before writing the clipboard.
- The action does not modify pin files, completion state, attachments, rich details, or the project handoff.

## Non-goals

- No new Bridge tool.
- No change to `list_pins`, `get_pin`, pin storage, or pin migration.
- No markdown/rich-doc serialization in the copied payload; this is ID + title only.

## Context / references

- `src/webview/sidebar/App.tsx` renders the Pins row and inline action bar.
- `src/webview/SidebarPrototype.ts` owns webview-to-host dispatch and can use `vscode.env.clipboard`.
