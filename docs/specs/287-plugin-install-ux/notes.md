# 287 — plugin-install-ux — notes

_Created 2026-06-28._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### Implementation (2026-06-28)

**Lane A — progress channel (D1/D2/D6).**
- `toolProvisioning.ts`: `downloadToTemp`/`fetchOnce` gained `onProgress?: (p: { downloadedBytes; totalBytes: number | null }) => void`. Total comes from a finite, >0 `Content-Length` (else `null`). Throttle in the `res.on("data")` handler: emit on first byte, then only when `>= 1 MiB` OR `>= 250 ms` since the last; a forced final emit on `out.on("finish")`. The callback is wrapped in try/catch — a throwing UI callback never aborts a valid download (tested).
- `toolProvisionRun.ts`: added `ProvisionProgress = { kind: "data"|"tool"; name; downloadedBytes; totalBytes }` + `ProvisionProgressFn`. `provisionTools`/`provisionData`/`rehydrateTools`/`rehydrateData` each wrap the raw download callback with their `kind`+`name`.
- `engine.ts`: `ApplyOpts.onProgress` (+ `applyUpdate` opts) threaded to both provision calls.
- `PluginsPanel.ts`: a module-level `progressBusyLabel(p)` formats "Downloading <name>… NN / MM MB" (or "… NN MB" with unknown total) and the confirm/update/rehydrate paths pass `onProgress: (p) => io.postBusy(progressBusyLabel(p))`. No new webview message type — reuses the live-updating busy label (D2).

**Lane B — installed-card external tools (D3/D4/D5).**
- `externalTool.ts`: `detectExternalToolPresence(name)` is the SPAWN-FREE card check — `resolveOnCleanPathNoSpawn` walks `CLEAN_PATH` dirs in JS (`statSync`+`realpathSync`, no `command -v` subprocess, no detect probe) + trust-check. The full spoof-resistant `detectExternalTool` (which spawns) stays only in the install preview.
- `viewModel.ts` stays pure: `ExternalToolVM { name; present; installable; manual }` + `BuildPluginsInput.externalStatuses?: Record<name, ExternalToolVM[]>` injected by the host exactly like `intact`/`updateChecks`; attached to the card only when non-empty.
- `PluginsPanel.externalStatuses(ws)` computes presence with a per-gather dedupe cache (each unique tool resolved once), recomputed every gather so install/remove/refresh/terminal-close naturally re-detect (D5). `installable = Object.keys(req.install).length > 0`.
- D4: `adaptLockedInstall(Record<pm,string[]>) → Partial<Record<pm,{argv}>>` is a PURE, unit-tested helper (kept out of the vscode layer per the "logic in vscode escapes CI" rule). The installed-card click sends `{ pluginName, externalTool }`; `installExternalFromCardOp` resolves the req from the LOCKFILE, adapts, and calls the SAME shared `runAssistedInstall` (modal + visible terminal + in-flight guard + `onDidCloseTerminal` re-detect) the drawer uses. `buildAssistedInstall` re-validates + re-normalizes to trusted realpaths — security equivalent to the drawer path.

**Tests:** progress (known/unknown Content-Length, monotonic, forced-final, throttle bound <64 events, throwing-callback-safe), viewModel external-status injection (+ empty list omits the row), spawn-free presence (trusted/missing/untrusted, no probe), `adaptLockedInstall` (drops unknown PMs/empty argv; same normalized argv as manifest path). Full suite 1811 green; typecheck (engine + webview) + engine-boundary green.

### Impl codex dueto (2026-06-28, commit 24ac4ce) — SHIP-WITH-CHANGES, all folded

Codex explicitly cleared the security path (lockfile argv is adapted then re-validated + re-normalized by `buildAssistedInstall`; the in-flight key blocks the card/drawer race). No BLOCKER/HIGH. Folded:
- **MEDIUM** — `resolveOnCleanPathNoSpawn` accepted any regular file, so a trusted-path but NON-executable `ffmpeg` (mode 0644) would read as present on the card while drawer/runtime detection still fails. Fix: `fs.accessSync(cand, X_OK)` before realpath (mirrors `command -v` semantics). The resolver now takes an injectable search-path (`dirs`) + is exported for a real regression (non-exec skipped / exec resolved).
- **LOW** — the forced finish emit could duplicate the last data event's full-byte count, violating "final exactly once". Fix: `emitProgress` returns early when `bytes === lastBytes`, so the terminal full-byte event fires exactly once whether the last chunk or the finish triggers it. Test asserts exactly one full-byte event + no consecutive duplicates.
- **LOW/test-gap** — the gather mapping lived in the vscode layer untested. Fix: extracted the pure `buildExternalStatuses(plugins, isPresent)` into `viewModel.ts` (the panel keeps only the lockfile read + the per-gather dedupe cache as glue) + unit-tested it. Full suite 1817 green after the fold.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
