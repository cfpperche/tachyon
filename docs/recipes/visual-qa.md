# Recipe — Visual QA on a worktree's UI change

The first **producer** for the worktree evidence channel (spec 273): an agent looks at a UI change a worktree
produced, judges it against the **design intent**, and attaches an advisory verdict + screenshots via
`attach_evidence`. It is **advisory** — it never gates (the verify badge stays the gate). This recipe is the v1 for
**Tachyon's own webview UI**; see *Graduating to a consumer project* for how it generalizes.

> A recipe is content, not a trigger. In v1 it runs when a human/agent invokes it (or you reference it from your
> project's agent context). It produces evidence; it decides nothing on its own.

## When to run

After a worktree changed a UI surface, before accepting its handoff — to capture "does it look right vs the design
intent", which the binary verify gate can't express.

## Steps

1. **Build + serve the preview harness** (the webview is a VS Code webview with no URL; the harness renders the real
   bundle standalone):
   ```bash
   npm run build && npm run preview:webview
   # → http://localhost:5174/scripts/webview-preview/index.html?view=sidebar&fixture=<name>
   ```
   Fixtures live in `scripts/webview-preview/fixtures.js` (`default`, `empty`, `error`, `evidence-badge`). Add a
   fixture for the state your change touches. The harness **fails loud** on a page error / blank render / unknown
   fixture — treat any of those as a Visual QA failure, not a passable screenshot.

2. **Capture screenshot(s)** with a headless browser, saving them **inside the worktree** (so `attach_evidence` can
   copy them into durable storage). Any browser automation works; the simplest is headless Chrome:
   ```bash
   google-chrome --headless=new --no-sandbox --hide-scrollbars --virtual-time-budget=3000 \
     --window-size=360,640 --screenshot="<worktree>/.vqa/sidebar-evidence-badge.png" \
     "http://localhost:5174/scripts/webview-preview/index.html?fixture=evidence-badge"
   ```
   Capture the relevant states (default + the changed one; an `error`/`empty` state if the change touches them).

3. **Judge against the ANCHOR — written design intent, not a pixel oracle.** Look at the screenshot and compare it
   to the project's design intent (the design-system + the component's purpose), NOT a stored baseline as truth.
   Cite **concrete observations**: "the evidence badge `⊙ 5 (1⊘)` reads clearly and tints on the failing row";
   "the spacing matches the dense-list rhythm"; or a problem: "badge clipped below 320px width". Pick a verdict:
   - `pass` — matches the intent, no concerns.
   - `concern` — works but a noted issue (→ `severity: warn`).
   - `fail` — a real visual defect (→ `severity: error`).
   - `unable_to_judge` — couldn't render/capture, or no anchor to judge against.

4. **Attach the verdict** to the worktree agent via the `attach_evidence` bridge tool (spec 273):
   ```
   attach_evidence(
     targetAgent: "<the worktree agent>",
     producer:    "<your agent name>",
     kind:        "judgment",
     severity:    "info" | "warn" | "error",
     summary:     "Visual QA: <verdict> — <one-line>",
     detail:      "<concrete observations, what you compared against>",
     artifacts:   [".vqa/sidebar-evidence-badge.png"],   // worktree-relative; Tachyon copies it to durable storage
   )
   ```
   The parent reads it via `list_evidence` / the `verify_agent` summary alongside (not instead of) the verify badge.

## Discipline (what keeps this useful, not noise)

- **Anchor on written intent.** No anchor → `unable_to_judge`, not a guess. A baseline screenshot is *context*, never
  canonical pass/fail (that recreates the retired frozen visual contract).
- **Advisory only.** Never block a merge on a Visual QA verdict; it informs a human/parent.
- **Concrete or nothing.** "Looks good" is not a verdict — cite what you saw and what you compared against.
- **Fail loud.** A blank/error render is a `fail`/`unable_to_judge`, never a silent pass.

## Graduating to a consumer project

This doc is the **content**; a consumer doesn't discover a doc. To make Visual QA discoverable/triggerable elsewhere
(a later spec), the same flow graduates to one of:
- **a SKILL/plugin** — a `SKILL.md` whose description ("use when reviewing UI changes for visual fidelity") lets the
  agent select it for a UI task by description-matching (the normal skill-selection mechanism — not guessing);
- **a verify-gate step** — wired into a runbook the `verify:` runs, so it fires automatically at the gate;
- **a project convention** — a rule/AGENTS.md line pointing agents at it for UI changes.

A consumer **web app** needs no harness (it has a real `localhost` URL — point the browser straight at it); a
**native/desktop** app needs the future OS-capture primitive. In every case the producer brings the running UI + the
one thing it can't guess: the **design-intent anchor**.
