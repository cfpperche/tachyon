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

2026-07-02 implementation pass: added `agent-screen` plugin in `/home/goat/tachyon-plugins`, commit `6d5bb80`
(`feat: add agent-screen plugin`). V1 includes `doctor`, `list-windows`, `screenshot --active --out <png>`, and
`screenshot --window <query> --out <png>` using Linux/WSLg X11 `ffmpeg` x11grab plus `xdotool`/`xwininfo` for optional
window targeting. Local smoke results:

- `agent-screen doctor` passed with `DISPLAY=:0`, `ffmpeg=/home/goat/bin/ffmpeg`, `xdotool=/usr/bin/xdotool`,
  `screen_size=2560x1600`, `xwininfo=/usr/bin/xwininfo`.
- `DISPLAY= agent-screen doctor` failed closed with `status=unavailable reason=no-display`.
- `agent-screen screenshot --active --out /tmp/agent-screen-plugin-smoke/active.png` wrote a 2560x1600 PNG in
  `mode=screen-fallback`.
- `agent-screen list-windows` returned no visible X11 windows on this host.

Dogfood limitation: the generated screenshot is real but nearly black, so this validates the X11 backend only. It does
not yet validate the installed VS Code sidebar visually. For that, the target window must be exposed on the captured X11
display or a host-side Windows/desktop backend must follow.

2026-07-02 follow-up after maintainer screenshot: the black X11 capture was not sufficient for VS Code dogfood because
VS Code is a Windows desktop window, not a WSLg X11 window. Added a Windows-host backend in `/home/goat/tachyon-plugins`,
commit `aec4c3e` (`fix: prefer windows host screenshots in agent-screen`). In WSL, `screenshot --active` now prefers
PowerShell/.NET `CopyFromScreen` of the Windows foreground window and falls back to X11 only if host capture is
unavailable. Smoke:

- `agent-screen doctor` reports `windows_host=available powershell=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`.
- `DISPLAY= agent-screen doctor` still succeeds via `windows-host` and reports X11 unavailable.
- `DISPLAY= agent-screen screenshot --active --out /tmp/agent-screen-plugin-smoke/active-host-nodisplay.png` wrote a
  foreground-window PNG of the Windows desktop/VS Code, not the black X11 display.

Updated dogfood source: `github:cfpperche/tachyon-plugins@aec4c3e#path=agent-screen`.

2026-07-02 v1.1 planning: `--active` is not enough for requests involving multiple open apps. The next increment should
make the agent's target-selection loop explicit: Windows-host `list-windows --json`, precise `--window-id`, query-based
`--window` with fail-closed ambiguity, and `--screen` for human-arranged layouts like Chrome + Discord side by side.

2026-07-02 Claude Fable v1.1 probe (`probe-283-agent-screen-v11-fable`) flagged privacy as the main planning gap.
Folded: `list-windows --json` is a desktop inventory and can leak email subjects, document names, chat channels, and
banking tabs into agent context/logs; `--screen` is more invasive than foreground-window capture because it can include
unrelated apps and notifications. V1.1 now requires bounded/redacted titles by default, no automatic evidence attachment
for full window inventories, `--window-id` preferred over `--screen`, and a Tachyon UI/Bridge consent-affordance decision
before implementation.

2026-07-02 owner decision: v1.1 should proceed with explicit user consent as the privacy gate. If the user asks for
screen/window capture and accepts the risk, the plugin may run `list-windows`, `--screen`, and targeted captures.
Sensitive-data detection/redaction/blur is desirable, but explicitly deferred to a future plugin evolution.

2026-07-02 v1.1 implementation: added Windows-host window targeting in `/home/goat/tachyon-plugins`, commits `8987f1e`
(`feat: add agent-screen window targeting`) and `ebd2d53` (`fix: include monitor in agent-screen inventory`), and
bumped plugin manifest to `0.2.0`. Implemented:

- `agent-screen list-windows --json [--verbose]` using Windows `EnumWindows`, bounded titles by default, process/pid,
  bounds, monitor, minimized state, and foreground marker.
- `agent-screen screenshot --screen --out <png>` using Windows virtual screen bounds.
- `agent-screen screenshot --window-id <id> --out <png>`.
- Windows-host `agent-screen screenshot --window <query> --out <png>` matching title/process and failing closed on
  zero/ambiguous matches.

Smoke evidence:

- `list-windows --json` returned valid JSON, found VS Code as process `Code`, included `monitor=\\\\.\\DISPLAY1`, and
  capped a long Chrome title.
- `screenshot --screen` wrote `/tmp/agent-screen-v11-final/screen.png`, 1707x1067 PNG showing the real VS Code desktop.
- `screenshot --window-id <Code id>` wrote `/tmp/agent-screen-v11-final/code-id.png`, 1721x1033 PNG.
- `screenshot --window Code` wrote `/tmp/agent-screen-v11-final/code-query.png` and reported `process=Code`.
- Ambiguous `screenshot --window Settings` failed closed with bounded candidate summaries.
- Minimized `screenshot --window Discord` failed closed with "restore it before capture".

Updated dogfood source: `github:cfpperche/tachyon-plugins@v0.28.0#path=agent-screen`. Do not use short SHA refs in
the Tachyon plugin install UI; use a pushed tag/branch/full advertised ref.

2026-07-02 installed dogfood of `v0.28.0`: `doctor`, `list-windows --json`, `--screen`, and VS Code `--window-id`
worked from the installed plugin. `--window chrome` selected the Chrome window but captured the visible screen bounds,
so if Chrome was covered by VS Code the PNG showed VS Code instead of Chrome. Fixed in `/home/goat/tachyon-plugins`,
commit `ef4b4e2` (`fix: capture covered windows in agent-screen`), by using Windows `PrintWindow` for `--window-id` and
query-based `--window` captures. Local validation confirmed the covered Chrome window captured its own content. Updated
dogfood source: `github:cfpperche/tachyon-plugins@v0.28.1#path=agent-screen`.

2026-07-02 installed dogfood of `v0.28.1`: maintainer installed the updated plugin and Codex tested the installed copy
from `.tachyon/plugins/agent-screen` (not the local checkout). Results:

- manifest version was `0.2.1`.
- `doctor` passed with `windows_host=available`, `ffmpeg=/usr/bin/ffmpeg`, `xdotool=/usr/bin/xdotool`.
- `list-windows --json` wrote `.tachyon/evidence/agent-screen-v0281-dogfood/windows.json`; it found VS Code, Chrome,
  minimized Discord, and two Settings windows with bounded titles.
- `screenshot --screen --out .tachyon/evidence/agent-screen-v0281-dogfood/screen.png` captured the real desktop.
- `screenshot --window-id <VS Code id>` wrote `.tachyon/evidence/agent-screen-v0281-dogfood/vscode-window-id.png`.
- `screenshot --window chrome` wrote `.tachyon/evidence/agent-screen-v0281-dogfood/chrome-query.png` and visually
  confirmed Chrome/Gmail content even while Chrome was covered by VS Code.
- `screenshot --window Settings` failed closed as ambiguous.
- `screenshot --window Discord` failed closed because Discord was minimized.

Dogfood verdict: v0.28.1 satisfies the v1.1 window-selection/capture contract on this Windows/WSL host. Remaining known
limit: minimized windows must be restored before capture.
