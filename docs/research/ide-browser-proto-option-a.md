# IDE Browser prototype — Option A (extension + external Chrome/CDP + stream panel)

_Status: worktree prototype for Dev Host dogfood only. Not a product SDD. Not a release surface._  
_Date: 2026-08-03. Worktree: `tachyon/grok`._

## Intent

Prove we can approximate Orca-style “browser in the IDE” **without** Companion and **without**
forking VS Code:

1. Chrome/Chromium runs **outside** the extension host (real browser, CDP).
2. A Tachyon **webview panel** shows a live **screenshot stream** of that page.
3. Human can navigate, click-through, and toggle a **Design Mode** picker that extracts element
   context (tag, text, HTML snippet, styles, bounds) for later “send to agent” wiring.

## Why this shape

| Constraint | Consequence |
|---|---|
| VS Code extensions cannot embed Chromium / BrowserView | Real browser must be external (Puppeteer/CDP) |
| Webview is an iframe sandbox | Panel is a **viewer + input surface**, not the browser |
| Stable VSIX must not ship experimental UX as product | Gate on `ExtensionMode.Development` (+ Test); palette `when` context |
| Dev Host is the dogfood door | F5 / `npm run dogfood -- dev-host` only; no `package` / marketplace |

## Architecture (prototype)

```text
[Command: Tachyon: IDE Browser (prototype)]
        │  only when tachyon.ideBrowserProto.enabled
        ▼
[Webview panel — stream UI]
   postMessage: navigate | click | designMode | ready
        │
        ▼
[IdeBrowserSession — puppeteer-core]
   launch system Chrome ──CDP──► page
   Page.startScreencast (jpeg, everyNth=1) ──data URL──► panel
   fallback: ~15fps page.screenshot if screencast fails
   click / elementFromPoint ──pick payload──► panel
```

**Option 4 polish (2026-08-03):** replaced ~3 fps `setInterval(screenshot)` with CDP
`Page.startScreencast` + immediate `screencastFrameAck` and coalesced delivery (latest frame wins).
Canvas double-buffer (no `img.src` thrash). UI-design defaults: **PNG**, **dpr=2**, viewport
**1440×900** CSS → ~2880×1800 device pixels (no maxWidth downscale). Env:
`TACHYON_IDE_BROWSER_SC_FORMAT`, `TACHYON_IDE_BROWSER_DPR`, `TACHYON_IDE_BROWSER_WIDTH/HEIGHT`,
`TACHYON_IDE_BROWSER_SC_QUALITY` (jpeg only), `TACHYON_IDE_BROWSER_SC_EVERY_NTH`.
Still not native video — heavier bandwidth is intentional for styling fidelity.

Code lives under `src/webview/ide-browser-proto/` (shell allowlist already covers `src/webview/`).

| File | Role |
|---|---|
| `register.ts` | Context key + command registration (dev/test only) |
| `panel.ts` | Webview HTML/JS + host message loop |
| `session.ts` | Launch, navigate, stream, click, pick |
| `chrome.ts` | Resolve Chrome executable (env + common paths) |
| `coords.ts` | Map click on displayed image → CSS viewport coords |
| `types.ts` | Message + pick payload shapes |

## Scope for this prototype (in)

- Open one panel, one Chrome session (headless by default; headed if `TACHYON_IDE_BROWSER_HEADED=1`).
- URL bar + Go / Reload.
- CDP screencast JPEG stream (target tens of fps on static/UI; video still framed).
- Normal click → `page.mouse.click` on mapped coords.
- Design Mode → click captures element payload (no agent Bridge yet; show + **Copy for agent**).
- Dispose panel → close browser.
- Unit tests for coordinate mapping (no Chrome required).

## Out of scope (deliberate)

- Bridge / `user_browser_*` / Companion.
- Multi-tab, multi-worktree session registry.
- Full-page interactivity parity (text input focus, hover CSS, scroll chaining polish).
- Product SDD, changelog, stable packaging.
- Visual design-system tokens (inline styles are fine for proto).

## Dogfood (Dev Host only)

1. Build worktree: `npm run build` (or `watch`).
2. Point Dev Host at this worktree:
   - `npm run dogfood -- dev-host -- point --fixture <slug>`  
   - or F5 **Tachyon: Dev Host** with extension path = this worktree.
3. In the Extension Development Host window: Command Palette →  
   **Tachyon: IDE Browser (prototype — Dev Host)**.
4. Navigate to a public page or local `http://127.0.0.1:…`.
5. Toggle Design Mode → click an element → **Copy for agent** → paste into an agent terminal.

**Do not** run `npm run package` / `build:stable` for this. Prototype validation is EDH-only.

## Gate / non-release contract

| Mode | Behavior |
|---|---|
| `ExtensionMode.Development` (F5 / Dev Host) | Context `tachyon.ideBrowserProto.enabled` = true; command registered |
| `ExtensionMode.Test` | Same (automated harness) |
| `ExtensionMode.Production` (installed VSIX) | Context false; command registered as no-op/hidden; session never launches |

Palette entry uses `"when": "tachyon.ideBrowserProto.enabled"` so production users do not see it.

## Risks / honest limits

- Stream latency and JPEG quality ≠ native Chromium embed.
- Headless may differ slightly from headed rendering.
- Some sites block automation; sandbox flags needed on Linux/WSL.
- Click mapping assumes `object-fit: contain` letterboxing math in `coords.ts`.
- Puppeteer is bundled into `dist/extension.js` (size cost — acceptable for proto; revisit before product).

## Next steps after human validation

1. “Send to agent” → existing shell prompt path (not Companion).
2. Optional headed window for auth login, then headless restore.
3. Per-worktree session id.
4. Only then consider product SDD vs kill the prototype.

## Acceptance for this worktree drop

- [ ] Plan checked in (`docs/research/ide-browser-proto-option-a.md`).
- [ ] Code under `src/webview/ide-browser-proto/` + thin wire in `extension.ts` + `package.json`.
- [ ] Unit test for coords green.
- [ ] Typecheck / focused test green on worktree.
- [ ] Human dogfood on Dev Host (screenshot + copy payload) — **maintainer**, not CI release gate.
