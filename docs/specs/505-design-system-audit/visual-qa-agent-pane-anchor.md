# Visual QA anchor — agent-pane terminal theme (t-5554b4 / SDD 505 §8)

Written from the task's problem statement **before** this session edited a pixel.
An anchor written afterwards only proves the screenshot matches itself.

The owner decided (Q2 = b) that colour comes from the VS Code theme, and the
audit found the agent terminal was the one place that did not: 21 literals,
Dark+ forever, a dark rectangle inside a light editor.

## What the screen must satisfy

- **A1.** The agent terminal is not a Dark+ rectangle inside a light editor.
  Background and foreground come from the editor theme. The ANSI-16 come from
  `--vscode-terminal-ansi*`. In Light+ the cells sit on a light ground; in
  Dark+ they sit on a dark ground.
- **A2.** This is a theme *read*, not a redesign. Hue identities stay whatever
  the active VS Code theme publishes. An indistinguishable pair in a theme is
  a finding to record, not a defect to invent a replacement for.
- **A3.** Chrome — identity strip, stage bar, Pin / Template / Stage / Submit —
  uses the shared `--ds-*` vocabulary already live in this document. No private
  `--agent-pane-*` palette and no hand-copied `--ds-1…4`.
- **A4.** Hold at **880** and **360** in **both** themes (Dark+ and Light+).
  At 360 the stage actions wrap inside the pane and the terminal keeps the
  remaining height. At 880 the identity and stage chrome stay one row each.
- **A5.** The three inject-marker hexes (stage / submit / template) are not
  the 21-colour terminal palette. They may stay the identifying literals the
  lint already excepts.

## What this is not

Not a new palette. Not a workaround for a theme that publishes two identical
ANSI roles. Not a font change (the pane still skips `faces.css`).
