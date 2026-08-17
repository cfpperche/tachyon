# 512 — sidebar-status-footer — notes

_Created 2026-08-17._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- **Fatia 1 field name is `statusNotice`, not another row in `notices[]`.** The inbox is the Human Inbox (actions, collapsed counts, read state). The status-bar replacement is one last-write-wins message. Mixing them would make the footer a second inbox. (`t-72e93a`, estadogrok)
- **`level` is a required field on that object.** Same text can be `info` or `error`; the projector copies `level` and never reads `message` to decide it. (`t-72e93a`)
- **No timer and no `expiresAt`.** The store is `set` / `dismiss` / `get`. `at` is when the notice was written, not when it dies. A footer that fades reintroduces the defect. (`t-72e93a`)
- **State lives on the source (`statusNotice?: () => …`), not a process singleton.** Multi-root would share one notice if this were a module global. Fatia 3 hangs a `StatusNoticeStore` on the workspace and writes from the provider. (`t-72e93a`)
- **In-memory is enough.** The closed-sidebar `error` case is the same engine process remounting the projection. Disk persist would be machinery for a case the 23h41 sample never saw. (`t-72e93a`)

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
