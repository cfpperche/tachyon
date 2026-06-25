# Spec 260 — Pin tags

**Status:** shipped. · **Follows:** spec 255 Pin Studio, spec 258 sidebar pin copy, spec 259 sidebar tab scroll. · **Surface:** pin storage, Pin Studio, sidebar Pins tab, Bridge pin tools. · **UI impact:** ui.

## Intent

Pins need lightweight tags so humans and agents can classify work, visually identify related pins, filter the Pins tab, and keep large pin lists navigable without turning pins into a separate issue tracker.

The source pin is `p-a051b3`: "alterar pins para poderem ser marcados com tags , facilitando filtros identificacao, ordenacao".

## Acceptance

- [x] **Scenario: A human creates a pin with tags**
  - **Given** the Pin Studio is creating a new pin
  - **When** the user adds tags and saves
  - **Then** `.tachyon/pins.json` stores the pin with normalized tags and the sidebar shows those tags on the pin row.

- [x] **Scenario: A human edits tags on an existing pin**
  - **Given** an existing text-only or rich pin
  - **When** the user changes tags in Pin Studio and saves
  - **Then** the pin keeps its id, done state, author, rich document, and attachments while updating only title/detail metadata and tags.

- [x] **Scenario: Legacy pins continue to work**
  - **Given** a workspace has pins without a `tags` field
  - **When** Tachyon lists, opens, edits, completes, or deletes those pins
  - **Then** they behave as untagged pins without requiring a migration step.

- [x] **Scenario: Sidebar filtering by tag**
  - **Given** the Pins tab contains tagged and untagged pins
  - **When** the user selects a tag filter
  - **Then** only pins containing that tag are shown, the active filter is visible, and clearing it restores the full pin list.

- [x] **Scenario: Sidebar search includes tags**
  - **Given** a pin has tag `docs`
  - **When** the user searches `docs` or `#docs` with Cmd/Ctrl+K
  - **Then** the pin appears as a Pins result and selecting it reveals the row inside the scrollable Pins panel.

- [x] **Scenario: Agents can read and write tags through Bridge**
  - **Given** an agent uses `create_pin`, `update_pin`, `list_pins`, or `get_pin`
  - **When** it provides or reads tags
  - **Then** optional `tags` round-trip without adding a new MCP tool or changing the existing tool count.

- [x] Existing pin CRUD, rich pin attachments/sketches, pin copy action, tab scrolling, multi-root sidebar routing, and project handoff behavior remain unchanged.

## Data Contract

Tags are summary metadata on `Pin`, stored in `.tachyon/pins.json` as an optional `tags?: string[]`.

- Missing or empty tags mean untagged.
- The detail files under `.tachyon/pins/<id>.json` remain focused on rich document and attachments; they do not duplicate tags.
- `readDetail()` returns `summary.tags` because the summary already travels with rich detail.
- Empty tag arrays should be omitted on disk when writing, but exposed to UI view-models as `[]` for simpler rendering.

## Tag Normalization

Use deterministic local normalization:

- trim whitespace
- strip leading `#`
- normalize Unicode with `NFKC`
- lower-case
- collapse internal whitespace to `-`
- reject empty tags after normalization
- de-duplicate case-insensitively after normalization
- cap a pin at 12 tags and each tag at 32 characters

Do not enforce a global tag registry in this spec.

## Non-goals

- No global tag management screen.
- No colored tag taxonomy or per-tag settings.
- No automatic tag suggestion/classification.
- No migration command for legacy pins.
- No change to the project handoff.
- No change to pin attachment blob layout or rich detail schema.

## Closure

**Closure:** shipped on 2026-06-24. Validated with `npm run typecheck`, `npm run build`, `npm test`, `node scripts/screenshots/ds/render.mjs sidebar`, and `git diff --check`. Claude reviewed the implementation read-only at `/home/goat/Agent0/.agent0/.runtime-state/claude-exec/20260625T021453Z-spec-260-pin-tags-review-2/last-message.md`; required whitespace fixes were applied and revalidated.
