# 283 - agent-screen-primitive - notes

Deferred 2026-06-28. Tracked by a Tachyon pin at the time.

2026-07-02: promoted from deferred because spec 330's live postmortem dogfood exposed a real production-validation
gap. Bridge tools can prove agent state, postmortem retention, and dismiss affordance data, but they cannot visually
inspect the installed VS Code sidebar after VSIX install/reload. That is now a concrete non-web Visual QA consumer.

Direction recorded:

- v1: `agent-screen` plugin, screenshot-only, explicit commands, fail-closed, first backend chosen for the observed
  WSLg/Linux dogfood host if viable.
- v2: explicit bounded screen recording for short dogfood clips, with hard duration/size limits, cleanup, and no
  background capture.

Current pin note: the older handoff referenced `p-406332`, but the active `.tachyon/pins.json` no longer contained an
`agent-screen` pin with that id. Created replacement tracking pin `p-c7d306`.

2026-07-02 Claude Fable probe (`probe-283-agent-screen-fable`) verdict was effectively ship-with-changes for v2
recording detail. Folded three risks: recording may need a different backend than screenshot capture, interrupted MP4
writes can create unplayable evidence unless the container/finalize strategy is designed, and videos need frame
extraction/sampling so agents can consume them rather than only humans.
