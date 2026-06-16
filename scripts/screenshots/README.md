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
- the demo workspace: the standalone [`tachyon-examples`](https://github.com/cfpperche/tachyon-examples)
  repo. `capture.sh` auto-clones it to `~/tachyon-examples` (override with `$TACHYON_EXAMPLES`)
  and `npm install`s it. It must be its OWN git repo so the worktree/verify scenes fork for real.
- the AI CLIs you want to show on `PATH` (the hero/lineage scenes launch real
  `claude` / `codex` TUIs; they cost a small real interaction). The worktree/verify/review/studio
  scenes are deterministic and need no real AI.

> The rig `unset`s `ELECTRON_RUN_AS_NODE` (some agent/CLI runtimes set it, which makes the VSCode
> binary run as Node and reject every flag), and isolates its tmux socket + worktree cache
> (`XDG_CACHE_HOME` under a temp dir) so it never touches your live editor/agents.

## Usage

```bash
scripts/screenshots/capture.sh hero            # claude orchestrates a codex review
scripts/screenshots/capture.sh observability   # running / needs-input / idle / crashed
scripts/screenshots/capture.sh lineage         # claude > worker > researcher
scripts/screenshots/capture.sh studio          # the Agent Studio tabs
scripts/screenshots/capture.sh worktree        # a worktree agent: ⎇ branch + ✓ verify badge
scripts/screenshots/capture.sh review          # the C2 diff editor (base ↔ worktree)
scripts/screenshots/capture.sh multiroot       # two folders, two Bridges
scripts/screenshots/crop.sh                     # raw frames -> docs/screenshots/*.png
```

Raw frames land in `scripts/screenshots/out/` (gitignored); crops overwrite the
committed assets in `docs/screenshots/`. The crop rectangles assume a maximized
1600×1000 host — nudge them in `crop.sh` if your window chrome differs.

## Known limitation — hover/selection-gated UI

The runner is **command-driven** (`vscode.commands.executeCommand`), with no pointer. So it can
capture anything that renders persistently — tree rows, their **description badges** (`⎇` branch,
`✓/✗/⊘` verify, `· resumable` / `· fresh start`), panels, the diff editor, dialogs you open via a
command — but **NOT** anything gated on a real mouse: a tree row's **inline action icons** (e.g.
Review / Verify / **Create PR** / Remove) and **hover tooltips** only appear on hover or for the
focused row. That's why those features are documented in text rather than shown — the frame just
shows the badges, not the icons.

When a feature genuinely needs the icon/hover shown (none has yet — don't pre-build), reach for these
in order:

1. **Reveal + select via a test-hook** (cheapest). Add a tiny command that calls
   `treeView.reveal(node, { select: true, focus: true })` and call it from the scene before `frame()`.
   The focused/selected row usually renders its inline actions persistently. Verify on the target
   VSCode version — if selection alone doesn't surface them, use (2).
2. **Synthetic pointer with `xdotool`** under the same Xvfb display: `xdotool mousemove <x> <y>` to a
   row → a genuine hover (inline icons **and** tooltips, exactly as a user sees), and `xdotool click`
   to drive a click→dialog flow. Coordinate-fragile (row Y shifts with the tree) and adds a dep.
3. **Short driven GIF** for intrinsically multi-step interactions (hover→click→dialog): drive it with
   (2) and grab a few seconds with the `ffmpeg` already wired here, instead of a frozen frame.

Never mock/compose a frame — every asset is a live capture (the rig's whole point).
