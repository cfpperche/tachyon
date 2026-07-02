# 283 - agent-screen-primitive - tasks

**Status:** in-progress

## Planning

- [x] Promote the spec from deferred once a concrete consumer exists.
- [x] Record the v1 direction: screenshot-only plugin for installed VS Code/Tachyon dogfood.
- [x] Record the v2 direction: explicit bounded screen recording after screenshot v1 is proven.
- [x] Recreate the active tracking pin as `p-c7d306`.

## Implementation

- [ ] Probe the dogfood host display/capture stack.
- [ ] Scaffold the `agent-screen` plugin in the plugins repo.
- [ ] Implement `agent-screen doctor`.
- [ ] Implement `agent-screen list-windows`.
- [ ] Implement `agent-screen screenshot --active --out <png>`.
- [ ] Implement `agent-screen screenshot --window <query> --out <png>`.
- [ ] Add fail-closed tests for no display/backend/permission.
- [ ] Document privacy/explicit-capture behavior in README/SKILL.

## Verification

- [ ] Run the plugin unit/smoke tests.
- [ ] Dogfood against installed Tachyon/VS Code after VSIX install/reload.
- [ ] Attach a real sidebar screenshot as evidence.
- [ ] Confirm the evidence path is consumable by visual-qa.

## V2 Backlog

- [ ] Design `agent-screen record --active --duration <seconds> --out <mp4|webm>`.
- [ ] Add max duration, max file size, fps, cleanup, and cancel semantics.
- [ ] Choose a recording-specific backend instead of assuming the screenshot backend generalizes.
- [ ] Choose a cancel-tolerant output container or finalize/remux strategy.
- [ ] Define frame extraction/sampling so agents and visual-qa can consume recordings.
- [ ] Decide whether window-targeted recording ships in v2 or follows after active-screen recording.
- [ ] Decide whether accessibility tree capture belongs in v2 or a later semantic-inspection spec.
