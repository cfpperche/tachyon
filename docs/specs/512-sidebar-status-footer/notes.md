# 512 — sidebar-status-footer — notes

_Created 2026-08-17._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- **Fatia 1 field name is `statusNotice`, not another row in `notices[]`.** The inbox is the Human Inbox (actions, collapsed counts, read state). The status-bar replacement is one last-write-wins message. Mixing them would make the footer a second inbox. (`t-72e93a`, estadogrok)
- **`level` is a required field on that object.** Same text can be `info` or `error`; the projector copies `level` and never reads `message` to decide it. (`t-72e93a`)
- **No timer and no `expiresAt`.** The store is `set` / `dismiss` / `get`. `at` is when the notice was written, not when it dies. A footer that fades reintroduces the defect. (`t-72e93a`)
- **State lives on the source (`statusNotice?: () => …`), not a process singleton.** Multi-root would share one notice if this were a module global. Fatia 3 hangs a `StatusNoticeStore` on the workspace and writes from the provider. (`t-72e93a`)
- **In-memory is enough.** The closed-sidebar `error` case is the same engine process remounting the projection. Disk persist would be machinery for a case the 23h41 sample never saw. (`t-72e93a`)
- **Fatia 2 is a `<footer>` sibling of `#sidebar-panel`, not a region inside any tab.** It reads
  `selected.statusNotice` (the project in focus). Absent notice mounts nothing. (`t-bd9fb8`, rodapegrok)
- **`<details>` is the path to the rest.** Collapsed: one nowrap line + the level word. Open: the
  same text unwraps. One copy in the markup; no second surface. (`t-bd9fb8`)
- **No dismiss control in this slice.** The host has not wired `StatusNoticeStore.dismiss` yet
  (fatia 3). A dead button would lie. The message stays until the next write. (`t-bd9fb8`)
- **`open` lives on `<details>`, not on the `<footer>`.** A first paint used `.status-footer[open]`
  and expand was a no-op — the measured height stayed 25px. Fail-before in the browser suite
  caught it; the selector is `details[open]`. (`t-bd9fb8`)

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

- **Height, measured 2026-08-17 in headless Chrome at 880 and 360:** collapsed footer is **25px**
  at both widths; the search bar is 26.8px; one agent card is 77.5px. The footer costs about
  one-third of a list row, and nothing when there is no notice. Opening a 161-char error unwraps
  to 4 lines at 360 and 2 at 880 — that extra height is only after a click, which is the path
  the spec asked for. Shots: `.tachyon/visual-qa/t-bd9fb8-sidebar-status-footer/`.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
