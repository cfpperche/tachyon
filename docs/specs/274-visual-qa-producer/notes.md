# 274 — notes

## Origin
First PRODUCER of the spec-273 evidence channel. Owner chose Tachyon's own webview UI first, then a consumer app.
Research (web + codex `…20260627T173406Z`): universal visual QA via ONE mechanism is impossible (headless/no-display,
OS permission gates, Wayland portals, mobile, incomplete a11y); achievable as a LAYERED primitive — OS screen
capture (pixels, tech-agnostic) as the foundation, accessibility APIs (macOS AX / Windows UIA / Linux AT-SPI) as a
structural COMPLEMENT, not a visual-fidelity replacement. Tools noted: XCap, ksnip, xa11y, macapptree; VS Code
webview screenshottable via Electron `--remote-debugging-port` (CDP); existing screenshot MCP servers + Claude
`computer-use` (build-vs-buy for the later agent-screen primitive).

## Codex design dueto — SHIP-WITH-CHANGES (`…20260627T175735Z`), all folded
1. **Webview standalone is under-proven** → added a webview-HOST-ADAPTER contract (stub acquireVsCodeApi + capture
   postMessage, inject theme vars/classes, serve asWebviewUri-rewritten asset/font paths, localhost server not file://).
2. **Scope too big** → v1 = ONE webview, 2-3 fixtures, screenshot, durable artifact, advisory recipe; CDP demoted to
   a non-blocking parity probe.
3. **Anchor must not become a screenshot oracle** → primary anchor = written design intent/design-system; reference
   screenshots are contextual only; NO pixel-diff gate / baseline ritual (avoids the retired frozen visual contract).
4. **Artifact durability must fold now** → the spec-273 managed-dir COPY folds into this spec (a vanished screenshot
   makes the verdict unauditable).
5. **Producer = recipe/tooling, not core** → dev recipe/runbook + a thin dev helper; core contract stays
   attach_evidence/list_evidence.
6. **Fail-loud hooks** → console/page errors, blank/partial render, missing fonts/icons, fixture drift all FAIL.

OQ1-5 resolved in spec.md. Build order: harness (+ host adapter) → fold 273 artifact-copy → Visual QA recipe →
(optional) CDP smoke probe.

## Build progress
- **Harness — DONE + PROVEN (commit `14c0162`).** Extracted the sidebar inline `<style>` → `src/webview/sidebar/
  sidebar.css` (ONE source, real webview links it + harness reuses, no drift). `scripts/webview-preview/`
  (serve.mjs + parameterized index.html + Dark+ `theme-dark.css` + named FleetVM fixtures incl. evidence-badge),
  `npm run preview:webview`. PROVEN headless via `google-chrome --headless --screenshot`: the real sidebar renders
  standalone + the spec-273 evidence badge shows (⊙3 / ⊙2(2⊘) / ⊙5(1⊘)). Fail-loud caught a fixture drift live.
- **Artifact durability — DONE (commit `0382191`).** `copyEvidenceArtifacts` (`src/worktree/evidenceArtifacts.ts`)
  copies worktree artifacts into `.tachyon/evidence/<agent>/<id>/`; `Workspace.attachEvidence` stores the managed
  ref (survives a worktree rebuild); missing source fails cleanly; basenames de-collided. 5 unit tests.
- **Recipe — DONE.** `docs/recipes/visual-qa.md` (build+serve → headless screenshot inside the worktree → judge vs
  written design intent → `attach_evidence`). NOT a plugin/skill; references no Agent0 tool (capture = generic
  headless Chrome). Includes a "graduating to a consumer project" section: a recipe-as-doc has NO discovery — to be
  discoverable a consumer needs it as a SKILL (description-matched), a verify-gate step (auto), or a convention.
- **CDP smoke probe** — deferred (non-blocking, per spec).
- **Discoverability insight (owner Q):** nothing "guesses" a recipe; the trigger is a skill/gate/convention. v1
  (Tachyon) = doc, human/agent-invoked. Consumer = the recipe must graduate to a skill/plugin (or gate step).
