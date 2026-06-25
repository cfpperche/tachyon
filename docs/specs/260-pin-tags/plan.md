# Spec 260 — Pin tags — plan

## Research Summary

The current pin model has three doors:

- `PinStore` owns `.tachyon/pins.json` summary rows and optional rich detail files.
- `PinStudioPanel` and the Pin Studio webview create/edit text-only and rich pins.
- `SidebarPrototype` projects `PinStore.list()` into `PinVM`; `sidebar/App.tsx` renders rows, search, copy, edit, delete, and tab scrolling.
- Bridge exposes five pin tools (`create_pin`, `list_pins`, `get_pin`, `complete_pin`, `update_pin`).

Tags should live on the summary row because filtering, identification, ordering, `list_pins`, and sidebar search all consume the summary list. Putting tags inside Tiptap content would make filtering dependent on opening rich detail files and would not work for text-only pins.

## Approach

### 1. Storage and normalization

Add a small pin-tag helper near `PinStore`:

- `normalizePinTags(input: unknown): string[]`
- `serializePinTags(tags: string[]): string[] | undefined`

Extend `Pin` with `tags?: string[]`. Update `create`, `update`, `createRich`, `saveDetail`, and `clearDetail` to accept optional tags and write normalized tags. `list()` should tolerate absent/malformed legacy tags defensively: absent becomes unset; non-array values are ignored or normalized to empty rather than breaking the whole pin list.

### 2. Bridge API

Keep the tool count unchanged.

- `create_pin`: add optional `tags: string[]`.
- `update_pin`: add optional `tags: string[]`; require at least one of `text` or `tags` so agents can retag without rewriting the title.
- `list_pins`: returns summary tags naturally.
- `get_pin`: returns `summary.tags` naturally.

Tests must confirm the count assertions stay at 27.

### 3. Pin Studio UI

Add a compact tag editor in the Pin Studio header under the title:

- existing tags render as removable chips
- typing a tag and pressing `Enter`, comma, or blur adds it
- Backspace in an empty input removes the last tag
- errors use the existing error strip when tag limits are exceeded

The save message includes `tags`.

### 4. Sidebar UI

Extend `PinVM` with `tags: string[]`.

Rendering:

- show tags as quiet `#tag` chips in each pin row, before author metadata
- keep action buttons and checkbox layout unchanged
- sort tags alphabetically within each row for stable scanning

Filtering:

- derive the set of tags visible in the current Pins tab from all fleets
- add a compact tag filter control in the Pins section header
- clicking a pin tag applies that tag as the active filter
- the active filter is shown as a chip with a clear action
- filtering only changes the displayed pin rows; tab counts remain total pins

Search:

- include tags in `searchIndex()` by putting `#tag` text in the pin search hint or search corpus
- `docs` and `#docs` should both match a pin tagged `docs`
- selecting the search result still flashes and scrolls the pin row inside `.panel.active`

### 5. Ordering

Do not reorder pins globally in this spec. Existing pin order remains the storage order to preserve checklist muscle memory.

This spec delivers "ordenacao" by making tags stable and alphabetized on each row and in the filter control. A future spec can add pin sort modes once there is evidence about preferred ordering.

## Files to Touch

**Create:**

- `docs/specs/260-pin-tags/{spec.md,plan.md,tasks.md,notes.md}`

**Modify:**

- `src/pins/PinStore.ts` — pin tag field, normalization, persistence, retagging.
- `src/sidebar/types.ts` — `PinVM.tags`, search metadata.
- `src/webview/SidebarPrototype.ts` — project tags into the sidebar VM; preserve copy/edit/delete routing.
- `src/webview/sidebar/App.tsx` — tag chips, tag filter state/control, tag-aware search behavior.
- `src/webview/PinStudioPanel.ts` — include tags in VM and save routing.
- `src/webview/pin-studio/types.ts` — VM and save message tags.
- `src/webview/pin-studio/App.tsx` — tag editor state and save payload.
- `src/bridge/tools.ts` — optional `tags` fields for create/update.

**Tests:**

- `test/unit/pins.test.ts` — normalize, persist, retag, legacy/malformed tolerance.
- `test/unit/pinRichStore.test.ts` — rich save/clear preserve or update tags without touching attachments.
- `test/unit/pinStudioPanel.test.ts` — VM includes tags and save writes tags for text-only and rich pins.
- `test/unit/sidebarPrototype.test.ts` — sidebar VM includes tags; copy action remains `ID + Title`.
- `test/unit/bridge.test.ts` — create/update/list/get tags round-trip; tool list unchanged.
- `test/unit/auth.test.ts` — tool count remains unchanged if assertions are impacted by schema-only changes.

## Validation

- `npm test`
- `npm run typecheck`
- `npm run build`
- UI dogfood in EDH:
  - create a text-only tagged pin
  - create a rich tagged pin with one screenshot/sketch
  - edit tags on both
  - filter by tag from a chip and from the section control
  - search by `tag` and `#tag`
  - verify copy action still copies only `ID` and `Title`
  - verify deleting a pin still cleans rich detail/blobs as before

## Risks and Decisions

- **Tool schema compatibility:** extending existing tools with optional fields is nonbreaking; making `update_pin.text` optional needs explicit validation that at least one of `text` or `tags` is provided.
- **Malformed legacy data:** list should be tolerant for `tags` only, not make corrupt `pins.json` silently acceptable.
- **UI density:** tag chips must wrap inside the existing pin row and not steal the action-button hover area.
- **Search implementation:** current search only checks `SearchItem.name`; it may need a `keywords` field or a name/hint matching update so tag search does not pollute visible titles.
