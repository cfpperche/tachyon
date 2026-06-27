# 274 — visual-qa-producer

_Created 2026-06-27._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

> **Origin:** spec 273 shipped the neutral evidence channel (non-binary records on a worktree, read over the
> bridge). This spec builds its FIRST PRODUCER — **Visual QA**: an agent that looks at a UI a worktree produced,
> judges "does it look right vs the design intent", and attaches an advisory verdict + screenshots via
> `attach_evidence`. The producer is a recipe/dev-tooling ON TOP of the channel, never core governance.
>
> **Codex design dueto (2026-06-27) — SHIP-WITH-CHANGES, folded** (`…20260627T175735Z-…`): the harness needs a real
> webview-HOST-ADAPTER contract (not just "no vscode import"); v1 scope tightened to ONE webview + 2-3 fixtures;
> anchor on WRITTEN design intent (screenshots are context, NOT a pass/fail oracle — avoids the retired frozen
> visual contract); the spec-273 artifact-durability COPY folds in NOW; CDP smoke is a non-blocking probe; add
> fail-loud acceptance hooks. Research (web+codex `…173406Z`): universal visual QA is layered + degrades per OS.

## Intent

Let an agent produce a VISUAL QA verdict on a UI change in a worktree and attach it to the spec-273 evidence
channel — advisory, anchored on written intent, never a gate. v1 scopes to **Tachyon's own webview UI** (a VS Code
webview, not at a navigable URL), via a deterministic **component-preview harness** + the existing `agent-browser`.

## The component-preview harness (dev tooling — the load-bearing piece)

Tachyon's UI is a VS Code WEBVIEW with no URL a browser can open. The webview bundles
(`dist/webview/{sidebar,…}.js`) render from a view-model (`FleetVM`, with a `SAMPLE` in `src/sidebar/types.ts`). We
render ONE webview standalone at a localhost URL from VM fixtures, and `agent-browser` (CDP/Chrome, already shipped)
screenshots it. BUT "no vscode import" ≠ "localhost-safe" — the runtime needs a **webview-host-adapter contract**:

- **stub `acquireVsCodeApi()`** (capture outbound `postMessage` calls instead of dropping them);
- **inject the VS Code theme** CSS vars + classes the components read;
- **serve rewritten asset/font paths** (codicons etc.) that `asWebviewUri` would normally produce;
- a tiny **localhost static server + one parameterized host** (`?view=sidebar&fixture=evidence-badge`) — NOT
  `file://` (which hides asset/CSP/origin issues);
- **fail LOUD**: a console/page error, a blank/partially-hydrated render, or a missing font/icon must FAIL the
  harness, not silently produce a misleading screenshot.

## The Visual QA recipe (the producer — a recipe, not core)

An agent-driven flow living as a Tachyon dev recipe/runbook + a thin dev-tooling shell helper (NOT in core evidence
semantics): serve the harness → `agent-browser` loads the target view+fixture → capture screenshot(s) → a
vision-capable reviewer agent judges against the ANCHOR → `attach_evidence` (kind `judgment`, the verdict +
screenshot artifact refs + concrete observations) on the worktree agent. Verdict ∈
`pass|concern|fail|unable_to_judge` — ADVISORY, never a gate (the verify badge stays the gate).

## Anchoring (avoid the retired frozen-visual-contract trap)

The PRIMARY anchor is **written design intent / design-system invariants** (text). A reference screenshot may be
attached as CONTEXTUAL evidence, but is NOT canonical pass/fail truth — a baseline-screenshot-as-contract recreates
the brittle frozen visual contract (spec 206 retired it). v1 has **NO pixel-diff gate and NO baseline-update
ritual**. The verdict cites concrete observations ("button clipped at 320px", "contrast below the design token"),
and `unable_to_judge` is always allowed.

## Artifact durability (folds in the spec-273 deferral — required here)

Spec 273 ships worktree-relative, NON-DURABLE artifact refs (a screenshot can dangle after a worktree rebuild). A
visual verdict whose screenshot has vanished is unauditable — so this spec FOLDS the spec-273 managed-dir COPY:
`attach_evidence` copies a provided artifact into a Tachyon-managed evidence dir (`.tachyon/evidence/<agent>/<id>/`)
and stores the managed ref, so the screenshot survives a worktree rebuild. Traversal-checked; a missing source
fails cleanly.

## Acceptance criteria (v1 — tight)

- [ ] **Harness renders ONE webview standalone, with the host adapter:** a localhost page renders the sidebar from a
  `FleetVM` fixture (incl. the spec-273 evidence-badge state), with `acquireVsCodeApi` stubbed + theme/assets
  injected; `agent-browser` drives + screenshots it headless.
- [ ] **Fail-loud:** a console/page error, a blank/partial render, or a missing font/icon FAILS the harness (no
  silent misleading screenshot); fixtures are typed against the real VM (drift fails).
- [ ] **Durable evidence artifact:** `attach_evidence` copies the screenshot into the managed evidence dir; the ref
  resolves after the worktree is rebuilt/removed; traversal rejected; missing source fails cleanly.
- [ ] **Visual QA recipe attaches an advisory verdict:** the flow produces a `judgment` record (verdict +
  durable screenshot refs + concrete observations) readable via `list_evidence`/`verify_agent`; it never changes
  the verify badge; the anchor is written design intent (screenshots contextual only).
- [ ] **No new core governance / product surface:** harness is dev-only; producer is a recipe; channel +
  agent-browser reused; nothing provisioned or gated.

## Out of v1 (non-blocking / later)

- **CDP real-webview smoke** (Extension-Dev-Host + `--remote-debugging-port` → screenshot the real shell): a
  non-blocking PARITY PROBE, not an acceptance criterion — fragile (`vscode-webview://` origins, version variance).
- Multiple webviews / many fixtures / responsive-viewport matrix.

## Open questions — RESOLVED (codex leans folded)

- **OQ1 (serving):** a tiny localhost static server + one parameterized host (`?view=&fixture=`); avoid `file://`.
- **OQ2 (fixtures):** named, VM-typed fixtures (`default`, `empty`, `error`, `evidence-badge`) — not just `SAMPLE`.
- **OQ3 (recipe home):** Tachyon dev docs or a Tachyon-local skill/runbook + a dev-tooling shell helper; NOT core.
- **OQ4 (anchor):** design-system/intent TEXT primary; reference screenshots contextual only, never canonical.
- **OQ5 (durability):** FOLD the spec-273 artifact-copy now (a non-auditable first producer is unacceptable).

## Non-goals (later specs — see roadmap)

- The general **`agent-screen`** OS-capture primitive (window capture + optional a11y tree) for projects with NO
  browser route (native/desktop/mobile). A SEPARATE later spec.
- Visual QA for **consumer web apps** (the clean localhost case) — after the Tachyon-own flow proves out.
- Mobile / native / TUI capture; OCR; baseline-management UX; a pixel-diff regression gate.
