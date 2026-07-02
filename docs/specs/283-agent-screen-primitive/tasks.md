# 283 - agent-screen-primitive - tasks

**Status:** in-progress

## Planning

- [x] Promote the spec from deferred once a concrete consumer exists.
- [x] Record the v1 direction: screenshot-only plugin for installed VS Code/Tachyon dogfood.
- [x] Record the v2 direction: explicit bounded screen recording after screenshot v1 is proven.
- [x] Recreate the active tracking pin as `p-c7d306`.

## Implementation

- [x] Probe the dogfood host display/capture stack.
- [x] Scaffold the `agent-screen` plugin in the plugins repo.
- [x] Implement `agent-screen doctor`.
- [x] Implement `agent-screen list-windows`.
- [x] Implement `agent-screen screenshot --active --out <png>`.
- [x] Implement `agent-screen screenshot --window <query> --out <png>`.
- [x] Add fail-closed tests for no display/backend/permission.
- [x] Document privacy/explicit-capture behavior in README/SKILL.

## Verification

- [x] Run the plugin unit/smoke tests.
- [ ] Dogfood against installed Tachyon/VS Code after VSIX install/reload.
- [ ] Attach a real sidebar screenshot as evidence.
- [ ] Confirm the evidence path is consumable by visual-qa.

## V1.1 Planning

- [x] Define Windows-host window inventory as the next targeting increment.
- [x] Define explicit `--screen` capture for human-arranged multi-window layouts.
- [x] Define `--window-id` to avoid ambiguous title/process queries.
- [x] Fold Claude Fable probe feedback into the v1.1 plan.
- [x] Decide v1.1 consent posture: explicit user consent accepts privacy risk; sensitive-data blur/redaction is future.

## V1.1 Implementation

- [ ] Implement Windows-host `list-windows --json`.
- [ ] Include title, process name, pid, bounds, minimized/visible state, monitor/desktop data when available, and foreground marker.
- [ ] Implement Windows-host `screenshot --screen --out <png>`.
- [ ] Implement Windows-host `screenshot --window-id <id> --out <png>`.
- [ ] Extend Windows-host `screenshot --window <query> --out <png>` with title/process matching.
- [ ] Fail closed on zero/ambiguous query matches with bounded candidate summaries.
- [ ] Cap/redact window titles in normal `list-windows`/ambiguity output; require explicit verbose/debug for full titles.
- [ ] Ensure `list-windows` output is not auto-attached as evidence.
- [ ] Document the Chrome + Discord side-by-side workflow.
- [ ] Decide whether multi-window composition belongs in v1.1 or a later v1.2.
- [ ] Track future sensitive-data detection/redaction/blur as post-v1.1.

## V1.1 Verification

- [ ] Smoke `agent-screen list-windows --json`.
- [ ] Smoke `screenshot --screen --out <png>`.
- [ ] Smoke `screenshot --window-id <id> --out <png>` using a visible VS Code window.
- [ ] Smoke ambiguous query failure.
- [ ] Smoke privacy bounds: long/sensitive titles are capped in normal output.
- [ ] Dogfood a multi-window request using either arranged `--screen` or two selected window captures.

## V2 Backlog

- [ ] Design `agent-screen record --active --duration <seconds> --out <mp4|webm>`.
- [ ] Add max duration, max file size, fps, cleanup, and cancel semantics.
- [ ] Choose a recording-specific backend instead of assuming the screenshot backend generalizes.
- [ ] Choose a cancel-tolerant output container or finalize/remux strategy.
- [ ] Define frame extraction/sampling so agents and visual-qa can consume recordings.
- [ ] Decide whether window-targeted recording ships in v2 or follows after active-screen recording.
- [ ] Decide whether accessibility tree capture belongs in v2 or a later semantic-inspection spec.
