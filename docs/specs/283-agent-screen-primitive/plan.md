# 283 - agent-screen-primitive - plan

**Status:** in-progress

## Approach

Promote the deferred design into a plugin-first implementation plan. Keep core Tachyon untouched unless the plugin needs
a generic evidence attachment hook that does not already exist.

V1 is screenshot-only. It should solve the concrete dogfood gap from installed VS Code/Tachyon validation: an agent can
see the real desktop state after a VSIX install/reload, instead of inferring visual UI from Bridge rows.

## Phases

1. **Backend probe**
   - Confirm the actual display stack on the dogfood machine.
   - Probe `ffmpeg`, `xdotool`, `$DISPLAY`, `$WAYLAND_DISPLAY`, and any available host bridge.
   - Decide whether v1 captures active window, full screen, or both.

2. **Plugin scaffold**
   - Add `agent-screen` in the plugins repo as a runtime-neutral shell tool plugin.
   - Include README/SKILL usage that makes privacy and explicit capture semantics clear.
   - Keep install/provisioning aligned with existing plugin patterns.

3. **CLI v1**
   - `agent-screen doctor`
   - `agent-screen list-windows`
   - `agent-screen screenshot --active --out <png>`
   - `agent-screen screenshot --window <query> --out <png>`
   - Fail closed on missing backend/display/permission and avoid writing blank/fake success artifacts.

4. **Evidence integration**
   - Make the output path compatible with visual-qa/evidence attachment.
   - Document a dogfood recipe for Tachyon sidebar validation after VSIX install/reload.

5. **Verification and dogfood**
   - Unit/smoke test backend selection and fail-closed errors.
   - Live dogfood on the installed Tachyon extension: capture the VS Code sidebar and attach the screenshot as evidence.
   - Record in notes whether Bridge-only validation has been replaced by actual screen evidence.

## V1.1 Plan

V1.1 is a targeting upgrade for the Windows-host backend. It should make the agent's selection process explicit instead
of relying on "whatever window is active".

1. **Windows window inventory**
   - Add a PowerShell/.NET helper for `list-windows --json`.
   - Enumerate visible top-level windows with `EnumWindows`, `GetWindowText`, `GetWindowRect`, `IsIconic`, process id,
     and process name.
   - Include foreground marker via `GetForegroundWindow`.
   - Exclude empty-title/tool/zero-sized windows unless a debug flag is added later.
   - Cap/redact titles in normal output and candidate summaries; full titles require an explicit verbose/debug mode.
   - Never attach the full window inventory as evidence automatically.

2. **Target resolution**
   - Add `--window-id <id>` for exact selection from `list-windows`.
   - Extend `--window <query>` on Windows-host to match title/process substring.
   - Fail closed with candidate summaries when no match or multiple matches occur.

3. **Screen capture**
   - Add `screenshot --screen --out <png>` for "the human arranged the windows already" flows.
   - Capture the virtual desktop bounds, not only the primary monitor, if PowerShell can do this reliably.
   - Treat `--screen` as the most privacy-invasive v1.1 capture mode; prefer `--window-id` when a target can be isolated.

4. **Multi-window UX**
   - Document the default workflow: list windows, select ids, capture separately, or capture screen if already arranged.
   - Defer automatic side-by-side composition until single-window selection is stable.
   - If composition is added, make it explicit and deterministic (`--layout horizontal|vertical`) and record the source
     windows in stdout metadata.
   - Use explicit user consent as the v1.1 privacy gate for `list-windows`, `--screen`, and targeted captures.
   - Leave sensitive-data detection/redaction/blur as a future plugin evolution.

5. **Verification**
   - Smoke `list-windows --json` and confirm Chrome/Discord/VS Code are distinguishable by process/title when present.
   - Smoke `screenshot --window-id <id>`.
   - Smoke ambiguous `--window <query>` failure.
   - Dogfood "capture VS Code by id" before broadening to Chrome + Discord.

## V2 Direction

After v1 screenshot dogfood succeeds, add screen recording as a separate explicit capability:

- `agent-screen record --active --duration <seconds> --out <mp4|webm>`
- optional `--window <query>` and `--fps <n>`
- hard max duration and max artifact size
- a fresh backend decision for recording, not an automatic extension of the screenshot backend
- a crash/cancel-tolerant output strategy: fragmented MP4, Matroska/WebM, or remux-on-finalize so evidence remains playable
- deterministic cleanup on timeout/cancel
- frame extraction or sampling for model/visual-qa consumption, because raw video alone is mostly human-readable evidence
- clear stdout/stderr metadata for evidence consumers
- no background recording and no automatic capture outside an explicit command

V2 is intended for short UX/DX proof clips: hover/focus behavior, animation, timing bugs, transient sidebar states, and
postmortem demonstrations that a still screenshot cannot capture.

## Risks

- Desktop capture is permission-sensitive and platform-specific.
- WSLg/Wayland/X11 behavior can vary across developer machines.
- Window titles are user/content-dependent and can leak sensitive data in logs; summaries should be explicit but bounded.
- Window ids are runtime handles, not durable identifiers across sessions.
- `list-windows --json` reveals more private context than `--active`; treat it as an inventory operation, not a harmless
  read.
- `screenshot --screen` can capture unrelated apps and notifications; it needs stronger UX guidance than window capture.
- V1.1 accepts these risks when the user explicitly consents; do not block implementation on automatic sensitive-data
  detection or blur.
- Recording can create large or sensitive artifacts; keep it out of v1 and design explicit caps before implementation.
- Interrupted MP4 writes can produce unplayable files if the container is not chosen deliberately.
- A recorded clip is not automatically useful to agents unless v2 also defines frame sampling/extraction.
