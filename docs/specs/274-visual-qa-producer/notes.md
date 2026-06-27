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
