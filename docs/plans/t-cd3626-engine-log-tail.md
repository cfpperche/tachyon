# t-cd3626 — Control Engine log tail (V1 → V2.5)

## Goal
Show **recent engine daemon log inside Control → Engine**, so boot/GC/errors are visible without `journalctl`.

## Phases

| Phase | Deliverable | Depends |
|-------|-------------|---------|
| **V1** | In-process ring (~150 lines) hooks `console.*`; `health` returns `logTail`; Control Engine card `<pre>` + empty state | — |
| **V1.1** | Level tint, pause-on-scroll, Copy, Clear (memory only), optional Open journalctl terminal | V1 |
| **V1.5** | Client substring filter, since chips, closed-set highlights, nav error badge | V1.1 |
| **V2** | Toggle Daemon \| Bridge \| Control events (`readEvents`) in same card | V1 |
| **V2.5** | Rotating file under engine data dir (1–2 MB) so tail survives daemon restart | V1 |

## Non-goals
ELK, agent pane logs, multi-workspace fleet log (V3 later), websocket stream.

## V1 design
- `EngineLogRing` singleton installed at daemon boot (before Workspace.start).
- Do **not** put `logTail` on identity schema (keeps attach validators stable).
- Extend **health** response: `{ logTail?: string[] }`.
- Cockpit `collect` calls `health()` when available and passes `logTail` into control model.
- UI: monospaced block under Engine KVs; max-height ~12rem; poll via existing sendModel refresh.

## V1 accept
Reload → Control → Engine shows recent lines including e.g. `[tachyon t-8310ca] orphan footprint GC…` when GC runs. Empty: “No recent engine log.”
