# Agent pane: first-party surface (layer 2) alongside VS Code integrated terminal (layer 1)

**Status:** product decision recorded 2026-07-24 · implementation task tracks build  
**Related research:** Mission Control task `t-5726dc` (evaluation framing)  
**Related product:** spec 381 prompt-templates (inject already dogfoods on layer 1)

---

## Decision (binding)

| Layer | Meaning | Product stance |
|---|---|---|
| **1 — VS Code integrated terminal** | Host the **runtime’s own TUI** via tmux + VS Code Terminal API | **Keep forever as first-class default.** Zero Tachyon maintenance of the emulator host; native tabs, splits, find, IME, a11y, theme, multi-root attach. |
| **2 — First-party terminal surface** | Still host the **runtime’s own TUI**, but the pane/PTY **viewport is Tachyon-owned** (webview + xterm.js or equivalent, tmux backend) | **Build.** Additive path for operator chrome. Not a forced replace of (1). |
| **3 — Tachyon-native TUI** | Replace the runtime TUI with product UI on a protocol (ACP / Codex app-server / stream-json / SDK) | **Future, out of scope** for this work. Do not mix into the (2) spike. |

**Coexistence, not replace.** Operators can keep opening agents in the integrated terminal (1). First-party surface (2) is an optional/preferred host when product features need a controlled viewport.

**1 ≠ 2 ≠ 3.** Layer (2) still renders the CLI TUI of Claude / Codex / Grok / … Layer (3) would stop depending on that TUI.

---

## Why (2) at all

Today delivery is largely **tmux** (session, capture, paste/sendKeys) + attach into a **host terminal the extension does not own**. Spec 381 proved inject works on (1), but more composer/operator UX is constrained by the host surface.

VS Code extension model:

- Extensions have **no access to the DOM** of VS Code UI, including the integrated terminal’s internal xterm.js instance.
- Public Terminal API is narrow: create/focus, `sendText`, name/icon/color, lifecycle, `TerminalLinkProvider`, `Pseudoterminal` (data plane only — still inside core terminal chrome).
- No public API for: cell decorations, reading selection, intercepting keys before PTY, HTML overlays, product toolbar inside the pane.

`Pseudoterminal` does **not** unlock (2): it only lets the extension own the data stream while the visual host remains the integrated terminal.

Market pattern for (2): **webview panel + real PTY** (node-pty or attach to existing tmux). Example: Ghostty Terminal extension (ghostty-web WASM in WebviewPanel + node-pty). Trade-offs of that pattern are real (not in `vscode.window.terminals`, no native terminal tab bar, DnD path limitations) — acceptable if (1) remains available.

When **we** embed xterm.js, the **embedder** APIs open: markers, decorations (including positioned DOM), overview ruler, search addon, full buffer/selection control, custom input handling.

---

## Architecture sketch (target)

```
┌─────────────────────────────────────────────────────────────┐
│  Tachyon Agent Pane (webview)                               │
│  ┌─ chrome ───────────────────────────────────────────────┐ │
│  │ identity · attention · toolbar · inject/stage bar      │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌─ viewport ─────────────────────────────────────────────┐ │
│  │ xterm.js (or equiv.)  ←→  postMessage bridge           │ │
│  │ decorations / markers / selection handlers             │ │
│  └────────────────────────────────────────────────────────┘ │
└───────────────────────────────┬─────────────────────────────┘
                                │
                    extension host (Node)
                                │
                    tmux session for agent  (existing)
                                │
                    runtime CLI TUI (unchanged)
```

- **Backend stays tmux** where we already win (resume, capture, paste, multi-agent isolation).
- **Frontend pane** becomes optional first-party host; (1) path keeps using VS Code `createTerminal` / attach as today.
- Operator chooses surface per agent or via setting: `integrated` | `tachyon` | `last-used`.

---

## Capabilities: what (2) unlocks that (1) cannot

Grouped for prioritization. “Hard no on (1)” = not available via public extension API without polluting the PTY stream or fighting the host.

### A. Operator chrome outside the PTY stream

| Capability | (1) integrated | (2) first-party |
|---|---|---|
| **Composer / input bar separate from runtime TUI** | Input is the CLI composer inside the PTY | Sticky HTML stage/submit bar; stream untouched |
| **Rich staging (381+)** | Inject ≈ paste/`sendText`; weak preview/edit | Stage in React; edit, attach pin, choose agent; submit → clean PTY bytes |
| **Agent toolbar** (attention, stop, fork, worktree, share) | Sidebar/commands only; terminal limited to name/icon/color | Header/footer on the pane with live badges |
| **Product multi-pane layout** (terminal + rails) | VS Code terminal view layout only | Webview grid: viewport + side rails (pins, activity strip) |

### B. Annotations on the buffer without rewriting runtime TUI

| Capability | (1) | (2) |
|---|---|---|
| **Provenance markers** (template inject, nudge, handoff) | Only by writing ANSI into the stream (pollutes agent session) | xterm markers/decorations/gutter/overview ruler — no extra PTY bytes |
| **Semantic highlights + actions** | `TerminalLinkProvider` = linkify line fragments only | Range highlight + context menu (Pin / Share / task) |
| **Overview ruler of events** | Not for extensions | Event ticks (attention, inject, error) |
| **HTML overlays** (local toast, popover, status strip) | Forbidden (no DOM on core UI) | Webview DOM over/beside terminal |

### C. Selection and “what the human saw”

| Capability | (1) | (2) |
|---|---|---|
| **Read user selection in pane** | No public selection API for extensions | xterm selection → Pin / Share / create task |
| **Product context menu** | Native terminal menu; little extension surface | Our menu with agent provenance |
| **Search + jump to markers** | Native find (text only) | Search addon + jump to last inject / attention |

### D. Input and paste policy

| Capability | (1) | (2) |
|---|---|---|
| **Intercept keys before PTY** | User keys go to core terminal | Webview keydown → PTY / composer / Tachyon shortcut |
| **Paste policy** | Host + shell behavior; large pastes fragile | Normalize newlines, chunk, confirm if large, strip secrets, “paste as template” vs “into agent” |
| **Multi-line staging / IME-friendly compose** | Competes with runtime TUI mode | HTML textarea/editor; submit sends clean sequence |
| **Operator-locked input** | Hard without hacks | Disable xterm input while agent busy; inject-only mode |

### E. Multi-agent product layout

| Capability | (1) | (2) |
|---|---|---|
| **Pane = Tachyon entity** (agent id, worktree, attention) | VS Code tab identity only | Identity line + Mission/sidebar linkage |
| **Multi-agent mosaic** | VS Code terminal splits | Our grid, focus, broadcast inject |
| **Design-system theming** | `terminal.integrated.*` only | Webview tokens shared with sidebar/Mission |
| **Empty / loading / error states** | Blank terminal or attach noise | “Attaching to tmux…”, retry, readable failure |

### F. Same-host Tachyon integration

| Capability | (1) | (2) |
|---|---|---|
| **DnD pin → stage bar** | Cross webview↔terminal DnD weak | Same webview: pin strip + stage + terminal |
| **Product hotkeys while pane focused** | Global keybindings; fight shell/TUI | e.g. mod+enter = submit template |
| **Controlled pane capture** | OS/agent-screen | Canvas/DOM capture with caveats |

---

## What (1) already does well (do not reimplement as a gate)

Keep relying on (1) + existing tmux for:

- Session lifecycle, resume, reattach  
- Inject via paste/`sendText` (381 path)  
- Open/focus, name, icon, color  
- Terminal link providers  
- Zero maintenance of emulator, IME, find, a11y, native tabs  

These are reasons **(1) stays first-class**, not arguments against (2).

---

## Risks of (2) (must plan for)

| Risk | Mitigation |
|---|---|
| IME / paste fidelity regressions | Golden paste suite; keep (1) fallback always one click away |
| Performance / scrollback | Cap scrollback; WebGL/canvas renderer options; don’t attach huge historical dumps by default |
| Accessibility | Explicit a11y pass; (1) remains the accessible default until (2) matches |
| Resume / multi-root attach | Reuse tmux session identity; surface only reattaches viewport |
| Parity with “Open terminal” actions | Dual open paths; setting + per-agent preference |
| Not in `vscode.window.terminals` | Document; other extensions won’t see (2) panes — OK |
| No native terminal tab bar | Own tab UI inside Tachyon or editor-area tabs |
| Explorer path DnD into webview | Known sandbox limit; offer paste path / picker |
| Maintenance cost | Thin viewport first; chrome features behind flags; never delete (1) |

---

## Suggested ship slices (not a formal SDD yet)

### Slice 0 — Spike (time-boxed)

- Webview panel + xterm.js + attach **existing** tmux session for one fixture agent  
- Bidirectional I/O (keys → tmux, capture/stream → xterm)  
- Prove resize, focus, basic paste  
- Side-by-side open of same session in (1) and (2) (read-only second attach or exclusive attach — decide in spike)  
- Exit criteria: human can type in runtime TUI through (2) for 5 minutes without obvious fidelity break  

### Slice 1 — MVP product pane

- Open agent in (2) **or** (1) (setting + action)  
- Identity strip (agent name, status)  
- Stage/submit bar wired to existing inject/delivery path (381)  
- Default remains (1) until dogfood flips preference  

### Slice 2 — Operator annotations

- Markers on inject/nudge  
- Selection → Pin / Share  
- Minimal overview ruler  

### Slice 3 — Multi-agent chrome

- Toolbar actions parity with sidebar  
- Optional mosaic / dual pane  
- Paste policy + operator lock  

Formal SDD (`docs/specs/NNN-…`) should be opened before Slice 1 lands; Slice 0 may stay spike-only.

---

## Non-goals

- Replacing or removing VS Code integrated terminal path (1)  
- Building Tachyon-native agent TUI / protocol client (3)  
- Blocking or reworking 381  
- Perfect parity with every VS Code terminal nicety on day one  

---

## Research sources (2026-07-24)

- VS Code Extension Capabilities — no DOM access to core UI  
- VS Code Terminal / Pseudoterminal API — data plane, not visual host ownership  
- xterm.js embedder APIs — decorations, markers, overview ruler, selection  
- Ghostty Terminal VS Code extension — webview + PTY architecture and known limitations  
- Prior product framing on Mission Control task `t-5726dc`  

---

## MVP implementation notes (t-610355, 2026-07-24)

Started on branch `tachyon/change/agent-pane-first-party`.

| Choice | Decision |
|---|---|
| Viewport | `@xterm/xterm` + `@xterm/addon-fit` in Preact webview `tachyonAgentPane` |
| Transport | `script -qfc 'tmux … attach-session -d …'` userspace PTY (no `node-pty`; honors 186 native-module rejection for default path) |
| Exclusive attach | **Yes (`-d`)** for MVP — same as layer 1; opening (2) detaches other clients |
| Resize | `tmux resize-window -x -y` from FitAddon (script does not reliably forward SIGWINCH) |
| Open path | Command **Tachyon: Open Agent Pane** (`tachyon.openAgentPane` / `…Item`); layer 1 remains **Open Agent Terminal** default |
| Chrome (slice 1 start) | Identity strip + status + button to open integrated terminal |
| Not yet | Stage/submit inject bar, markers, selection→pin, multi-agent mosaic |

### Commands
- `tachyon.openAgentPane` — palette pick agent → layer 2 pane  
- `tachyon.openAgentPaneItem` — sidebar primary action `openPane`  
- Layer 1 integrated terminal: sidebar **Open terminal** (`inspect`) only — no in-pane button

## Open questions for implementers

1. Exclusive vs shared attach when both (1) and (2) open the same tmux session — **MVP: exclusive**  
2. Editor-area WebviewPanel vs dedicated view container vs both — **MVP: editor WebviewPanel**  
3. xterm.js vs ghostty-web (or other) for the viewport renderer — **MVP: xterm.js**  
4. Default surface for new agents after MVP dogfood  
5. How far Slice 1 goes on i18n / design-system before annotations  
6. Whether `script`-PTY fidelity is enough or we later allow optional node-pty

---

## One-line product statement

> **Default today and forever: render the runtime TUI in VS Code’s integrated terminal (1). Optionally host the same runtime TUI in a Tachyon-owned pane (2) so we can ship operator chrome (staging, markers, selection actions, multi-agent UI) without waiting for a protocol-native Tachyon TUI (3).**
