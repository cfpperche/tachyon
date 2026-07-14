# 375 — persistent-workspace-bridge — notes

_Created 2026-07-13._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## 2026-07-13 — bounded implementation candidate

The original headless-engine design was deliberately reduced after maintainer feedback. The candidate keeps the
engine in the Extension Host and adds a detached stable-port proxy with an owner-only Unix control socket. During
reload the proxy returns immediate `HOST_UNAVAILABLE`; after reattach the same endpoint works without agent restart.
Focused proxy/Bridge/Workspace/i18n tests pass 110/110, typecheck and diff-check pass, and the real child-process
dogfood proves stable PID/port across detach/reattach. The first full run found only two new l10n calls; both were
replaced with repo-required plain strings and the focused i18n gate is green. Installed-VSIX reload dogfood and the
final full gate remain.

## 2026-07-13 — reload dogfood correction

Installed dogfood of 0.55.96 showed the stable port survived only because a new proxy was spawned after reload:
the proxy PID/instance changed and the old proxy was a direct Extension Host child. The Linux/WSL launcher now uses
`systemd-run --user --collect` so the user manager owns the proxy process. Headless dogfood was updated to prove the
proxy is not a direct child of the caller and still keeps one PID/port/instance across backend detach and reattach.

## 2026-07-13 — installed dogfood closure

Installed VSIX `0.55.97` in the WSL VS Code server and reloaded the window. The active extension version is
`cfpperche.tachyon@0.55.97`. The persistent proxy descriptor stayed on port `42897` with pid `1381746` and
instance `6611811f-723c-4ad7-ab40-3bfae4591659`; the process command points at
`extensions/cfpperche.tachyon-0.55.97/dist/persistent-bridge-daemon.cjs` and its parent is user systemd pid `2312`,
not the Extension Host. After killing Extension Host pid `1381553`, VS Code started pid `1384909`, the backend
reattached at `44927`, and the proxy pid/instance/port did not change. Fresh authenticated MCP initialize returned
HTTP 200 with an MCP session header.

Follow-up created as `t-40a28c`: the runtime-provided MCP wrapper kept an old session and timed out on
`mcp__tachyon_bridge.append_task_note`, while a fresh direct MCP session worked.

## 2026-07-13 — persistent-service error UX follow-up

Task `t-c182d2` reopens the shipped spec only for startup-error UX. Linux remains fail-closed when the user systemd
manager is unavailable: falling back to an Extension Host child would falsely claim reload survival. The notice
will instead classify the prerequisite, give WSL-specific recovery where applicable, retain bounded launcher detail
for diagnostics, and offer Doctor plus an in-place retry.

Focused verification passed 57/57 across persistent proxy, Workspace and Doctor suites. `npm run typecheck`,
`git diff --check`, the real user-systemd dogfood and the first `npm run verify:full:quiet` candidate all passed;
the full gate reported 322 files, 3822 passed and 3 skipped.

## 2026-07-14 — t-88ef8c: control socket exceeds sun_path on long checkouts

The workspace-rooted control socket (`<workspaceRoot>/.tachyon/bridge-service/control.sock`) overflows the
AF_UNIX `sun_path` budget (~108 bytes Linux, ~104 macOS) for any long checkout — e.g. a worktree under
`~/.cache/tachyon/worktrees/<id>/<agent-name>` is already 122+ bytes before `.tachyon/bridge-service/control.sock`
is even appended. `connect()` then fails with a raw, undiagnosable `EINVAL`, and that failure previously aborted
the entire workspace activation (no engine, no spawns, dead pins) instead of degrading.

Two fixes:
1. **Short socket path.** `persistentBridgeControlSocket` now derives the control socket outside the workspace,
   under `$XDG_RUNTIME_DIR/tachyon/<8-hex-wsHash>/control.sock` (falling back to `<tmpdir>/tachyon-<uid>/...` when
   `XDG_RUNTIME_DIR` is unset) — keyed only by the workspace hash, never the workspace path, so the derived path's
   length no longer depends on checkout depth at all (`MAX_CONTROL_SOCKET_PATH_BYTES = 100`, checked at derivation
   time; if even that runtime dir is pathologically long, `PersistentBridgeSocketPathError` is thrown with the
   offending path/length instead of a raw EINVAL surfacing later).
2. **Graceful degradation.** `Workspace.degradeToInProcessBridge` makes `EINVAL` (or any other persistent-proxy
   start failure) equivalent to the persistent proxy simply being disabled: the workspace falls back to the
   in-process Bridge, activation completes, and Doctor gets one warning instead of a fatal abort. This closes the
   gap that existed even on short paths — any persistent-proxy failure used to kill activation outright.

**Backward compat / migration.** `resolvePersistentBridgeControlSocket` is the single reader-side lookup used by
every `PersistentBridgeService` request (health/register/detach/stop): it checks the new short path first, and
falls back to the legacy in-workspace path only if a daemon is still listening there. This build never writes to
the legacy path, so a daemon started by a pre-t-88ef8c extension build stays reachable — and is NOT duplicated by
a second daemon at the new path — until it naturally stops (extension update, machine restart, etc.). No explicit
migration step or forced daemon kill was needed.

**Integration-suite caveat.** `npm run test:integration` (vscode-test) run from this worktree post-fix: 11 + 1
tests failed, but none show EINVAL/ENAMETOOLONG — the historical bug class is gone. Remaining failures are
live-fleet collisions (concurrently-running sibling agents share the same tmux server and workspace-hash
namespace on this host) plus one unrelated pre-existing sidebar/config drift — both out of scope here.

Focused suites green (persistentBridgeProxy.test.ts, workspaceHeadless.test.ts, sockfix3Behavior.gen.test.ts —
69 tests), `npm run typecheck` clean, real user-systemd dogfood passes.

## Dogfood log

### 2026-07-14T14:55:00Z — pass (1/1) — source: t-88ef8c — commit: 4055b91c
- `node scripts/dogfood/persistent-bridge.mjs` — pass (real systemd-spawned daemon, short XDG_RUNTIME_DIR-based control socket)

### 2026-07-13T15:45:36Z — pass (1/1) — source: tasks.md — commit: e7aad9da3f89ddb3e9342757336b661e6f13e269
- `node scripts/dogfood/persistent-bridge.mjs` — pass
