# Screenshot rig

Every image in the README and on the landing page is a **real capture** of the
extension driving itself — no mockups. This rig reproduces them headlessly.

## How it works

A headless VSCode host (`Xvfb`) loads the extension against a committed example
workspace and runs `runner.js` as its `extensionTestsPath`. The runner
choreographs the scene (spawns agents, splits panes, opens terminals), writes a
`ready-<name>` marker, and waits; `capture.sh` polls for the marker and grabs the
frame with `ffmpeg`. `crop.sh` then cuts the raw frames into the doc assets.

## Prerequisites

- `tmux`, `xvfb`, `ffmpeg`
- the VSCode test binary — downloaded once by `npm run test:integration`
- example deps installed: `(cd examples/orbit-api && npm install)`
- the AI CLIs you want to show on `PATH` (the hero/lineage scenes launch real
  `claude` / `codex` TUIs; they cost a small real interaction)

## Usage

```bash
scripts/screenshots/capture.sh hero            # claude orchestrates a codex review
scripts/screenshots/capture.sh observability   # running / needs-input / idle / crashed
scripts/screenshots/capture.sh lineage         # claude > worker > researcher
scripts/screenshots/capture.sh studio          # the four Agent Studio tabs
scripts/screenshots/capture.sh multiroot       # two folders, two Bridges
scripts/screenshots/crop.sh                     # raw frames -> docs/screenshots/*.png
```

Raw frames land in `scripts/screenshots/out/` (gitignored); crops overwrite the
committed assets in `docs/screenshots/`. The crop rectangles assume a maximized
1600×1000 host — nudge them in `crop.sh` if your window chrome differs.
