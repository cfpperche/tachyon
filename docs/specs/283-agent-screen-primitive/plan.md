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

## V2 Direction

After v1 screenshot dogfood succeeds, add screen recording as a separate explicit capability:

- `agent-screen record --active --duration <seconds> --out <mp4|webm>`
- optional `--window <query>` and `--fps <n>`
- hard max duration and max artifact size
- deterministic cleanup on timeout/cancel
- clear stdout/stderr metadata for evidence consumers
- no background recording and no automatic capture outside an explicit command

V2 is intended for short UX/DX proof clips: hover/focus behavior, animation, timing bugs, transient sidebar states, and
postmortem demonstrations that a still screenshot cannot capture.

## Risks

- Desktop capture is permission-sensitive and platform-specific.
- WSLg/Wayland/X11 behavior can vary across developer machines.
- Recording can create large or sensitive artifacts; keep it out of v1 and design explicit caps before implementation.
