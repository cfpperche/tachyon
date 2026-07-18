# t-cd3626 — Control Engine log tail (V1 → V2.5)

## Goal
Show **recent engine daemon log inside Control → Engine**, so boot/GC/errors are visible without `journalctl`.

## Phases

| Phase | Deliverable | Status |
|-------|-------------|--------|
| **V1** | In-process ring; `health.logTail`; Engine card | shipped 0.56.51 |
| **V1 layout** | Full-width log below meta grid | shipped 0.56.52 |
| **V1.1** | Level tint, pause-on-scroll, Copy, Clear, Journal terminal | this ship |
| **V1.5** | Filter, since chips, highlight set, nav error badge | this ship |
| **V2** | Source tabs Daemon \| Events \| Bridge | this ship (bridge empty until ring exists) |
| **V2.5** | File `engine.log` next to control.sock (~1.5MB rotate), hydrate on boot | this ship |

## Non-goals
ELK, agent pane logs, multi-workspace fleet log (V3 later), websocket stream.

## Accept
Reload → Control → Engine: toolbar works; Clear empties ring+file; Journal opens `journalctl -f`; Events tab shows control-plane lines when present; restart keeps recent file lines.
