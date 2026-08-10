# 233 — tachyon-engine-host-port

_Created 2026-06-18._

**Status:** in-progress — ENGINE DECOUPLED (awaiting codex review + EDH dogfood). `src/workspace/Workspace.ts` imports
**zero `vscode`**; the whole engine is vscode-free and a CI guard (`npm run check:engine-boundary`) fails
if anything outside the shell allowlist imports `vscode`. Built in 5 behavior-preserving passes (i18n,
notify, notices, capability-ports, the import-free flip), 720 unit tests green throughout. NOTE on the
`FakeHost` step: fully driving `Workspace` headlessly ALSO needs its managers (TmuxService/Bridge/engine,
`new`'d inside `create`) behind seams — so the unit-test payoff is **deferred** to a manager-injection
follow; this spec delivers the vscode decoupling + the guard, which is the load-bearing half.

Implements the first milestone of `docs/system-design.md` (engine ⊥ UI): give
`Workspace` an injected **`EngineHost`** so it depends on a small set of host ports, not on `vscode` —
then make the engine `vscode`-import-free and lock it with a CI boundary guard. Parent design (with the
Claude↔Codex deliberation): `docs/system-design.md`.

## Intent

`Workspace.ts` is the one remaining engine/UI seam: it constructs all the (already `vscode`-free) managers
but its own body calls `vscode` ~105×. Move those touchpoints behind an `EngineHost` interface the VS Code
shell implements (`VsCodeHost`), 1:1 with today's behavior. Outcome: `src/workspace/Workspace.ts` imports
no `vscode`, a `FakeHost` makes it unit-testable, and `check:engine-boundary` fails CI on any `vscode`
import under the engine. A second shell (CLI/daemon/other IDE) then implements `EngineHost` + its own UI.

## Scope — the touchpoints to route (verified)

`Workspace.ts`: **83 `vscode.l10n.t`**, **46 `notify(...)`**, **~8 `vscode.window.*`** (showInputBox,
showWarningMessage, tabGroups, message channels), **4 `createFileSystemWatcher` + `RelativePattern`**,
**1 `getConfiguration`**, **2 `commands.executeCommand`** (incl. `getEditorLayout`), and **`deps.context`**
(globalStorageUri, globalState get/update, extension.packageJSON version, extensionUri). `notify.ts`
(the toast helper) folds into the host.

## EngineHost — the composed port (small ports, not one fat object)

Per the design (§4), one `EngineHost` object composed of focused ports; the engine never sees `vscode`:

- **`UiPort`** — `notify(msg, level?)`, `confirm(msg, ...actions)`, `promptInput(opts)`.
- **`FileWatchPort`** — `watch(root, glob, events, cb): Disposable` (VsCodeHost → `createFileSystemWatcher`;
  headless → chokidar/polling). Engine consumes events; no `fs.watch`-parity promise.
- **`SettingsPort`** — `getSetting<T>(section, key, default)`.
- **`StoragePort`** — `globalStoragePath`, `getState<T>(key)`, `setState(key, v)`, `appVersion`,
  `mediaPath(rel)` (the engine's media assets, e.g. the clipboard helper).
- **`EditorLayoutPort`** — `captureLayout()`, `applyLayout(spec)` (the 2 `executeCommand` +
  `tabGroups`); the only "editor command" the engine needs — everything else editor-ish stays shell.
- **`i18n`** — `t(message, ...args)` (same signature as `vscode.l10n.t`; VsCodeHost delegates, FakeHost
  does `{0}` substitution).
- **`WorkspaceEvents`** — `onViewsChanged(view)` (already exists).

`extensionUri`-for-webviews and command REGISTRATION stay shell-only (never reach the engine).

## Plan (incremental, behavior-preserving — each pass keeps the suite green)

1. Define `EngineHost` (`src/workspace/EngineHost.ts`, no `vscode`) + `VsCodeHost`
   (`src/workspace/VsCodeHost.ts`, the only place these `vscode` calls now live); `Workspace.create`
   takes `{ host }` (keep `context` reachable via `StoragePort`).
2. Route **i18n**: a bound `this.t = host.t`; replace `vscode.l10n.t(` → `this.t(` (83, mechanical).
3. Route **notify** → `host.notify` (46); fold `notify.ts` into `VsCodeHost`.
4. Route **window/confirm/input** → `UiPort`; **watchers** → `FileWatchPort`; **settings** →
   `SettingsPort`; **context/storage** → `StoragePort`; **layout** → `EditorLayoutPort`.
5. **Make `Workspace.ts` import-free of `vscode`** + add `scripts/check-engine-boundary` (CI: no `vscode`
   import under the engine set) wired into the build.
6. **`FakeHost`** + a Workspace unit test that exercises `create/start/startPipeline` headlessly (the
   testability payoff; collapses the verifyGate-integration duplication where feasible).
7. codex review of the PR diff (the dueto) → fold → ship.

## Acceptance
- [x] `Workspace.ts` (and the engine set) import no `vscode`; `check:engine-boundary` green in CI.
- [x] `npm run typecheck && env -u TMUX npx vitest run` green; the existing 720 stay green (behavior-preserving).
- [x] No user-visible change (same toasts, prompts, watchers, token path, version migration) — **confirmed by EDH dogfood 2026-06-19** (crash toast + buttons, live tachyon.yml edit, resume toast, Bridge token).
- [~] codex review of the diff → SHIP-WITH-CHANGES, all folded (`e0f1d4b`): watch() opt-in events, guard regex broadened, double-prefix fixed.
- [ ] A `FakeHost` drives `Workspace` in a unit test with no Electron — **DEFERRED**: also needs the managers (TmuxService/Bridge/engine) behind seams; tracked as the manager-injection follow.

**Closure:** 2026-06-19 — the engine is decoupled from VS Code: `Workspace.ts` + all managers import zero
`vscode`; the only `vscode` lives in the shell (extension.ts, presentation/, webview/, VsCodeHost,
notify). 6 behavior-preserving passes (`53a14ee`→`e0f1d4b`), 720 unit tests green throughout, codex-reviewed,
EDH-dogfooded green. CI guard `check:engine-boundary` prevents regression. A second shell (other IDE / CLI /
daemon) now implements `EngineHost` + its own UI and reuses the engine. Deferred: full headless Workspace
testing (manager injection), broader layout-surface cleanup, the typed-event localization end-state, the
`@tachyon/engine` package split (all gated on demand / a second host).

## Non-goals (this spec)
- Typed-event localization (keep `host.t` for now — § design 9 end-state is deferred).
- Moving presentation/webviews out / a `TerminalPort` rewrite (design PR-4, separate spec).
- Publishing an `@tachyon/engine` package (design § 11 — only after a 2nd host).
- Any behavior change.
