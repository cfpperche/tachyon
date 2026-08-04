# Adversarial review brief — architecture / structure / location / widget stack

**Requested by:** the human maintainer (cfpp), relayed via grok.  
**Not** an agent self-review. Treat this as a maintainer-commissioned adversarial pass.  
**Date:** 2026-08-04  
**Branch:** `tachyon/grok` @ worktree  
`/home/goat/.cache/tachyon/worktrees/b349073a/grok`

## Role

You are an **adversarial** code + architecture reviewer for Tachyon Design Mode / IDE Integrated Browser.

- **Read-only.** Do not implement features. Do not merge to `main`. Do not open PRs.
- **Do not** expand into a full security program (threat models, eval allowlists, page-binding theater). Mention security only when it **forces** a stack or location choice.
- Focus **only** on the four lenses below.

## Context (do not re-litigate product)

- Design Mode: pick element → **chat is the sole agent channel** → reply via `design_mode_chat_reply`.
- Two bridges today: **Tachyon Bridge (MCP/engine)** vs **IDE Browser Bridge (shell HTTP+CDP)**.
- Human dogfood: selection attach → agent received element. That works.
- Prior security review: `review-codex.md` — **out of scope** for this pass (architecture only).
- Fit memo (starting point, not gospel): `architecture-fit.md`.

## In scope (attack all four)

### 1. Architecture
- Two-bridge split: cohesion, ownership, failure modes, naming.
- Design Mode vs Companion (414/420) vs agent-browser (267+).
- Coupling: Workspace ↔ manager ↔ client ↔ tools; tool catalog lifecycle.
- Engine-side vs shell-side vs pure libs.

### 2. Code structure
- Modules under `src/webview/ide-browser-bridge/*`, `src/ide-browser/*`, `src/bridge/tools.ts`, `src/workspace/Workspace.ts`.
- God files (manager, designModeInject, tools): size, mixed duties, testability.
- Dual paths, dead marker paths, inject lifecycle on navigation.

### 3. Artifact location
- Right place for Tachyon conventions (shell vs engine vs shared)?
- JSONL `.tachyon/design-mode-chat/`, instances `~/.tachyon/ide-browser-instances/`, SDD `docs/specs/488-…`.
- What must move before main vs fine for v1?

### 4. Widget stack (decision required)
Today: large **JS string inject** (`designModeInject.ts` → Runtime.evaluate / Trusted Types).

| Option | Description |
|--------|-------------|
| **A** | Keep string/IIFE inject (status quo) |
| **B** | Preact/React app → bundled JS injected into the page |
| **C** | VS Code webview for chrome (chat/card); thin pick overlay in page |
| **D** | Hybrid (thin inject pick + webview/sidebar chat) |

For each: Tachyon fit, cost, Trusted Types / third-party pages, theme tokens, drag/resize, re-inject on nav.

**Required:** pick A/B/C/D for **merge now** vs **post-merge**, primary + rejected (one line why each).

## Out of scope
- Security deep-dive as the main thesis.
- Multi-agent group chat product.
- Mandating a full two-bridge process merge unless you show S/M cost path.
- GA marketing copy.

## Method
1. Call graph: pick click → host (no agent) → chat send → MCP tool path.
2. File map by role (table).
3. Cite `file:line` on every finding.
4. Prefer structural advice that fits **existing** Tachyon patterns (Companion shell, webview Preact, bridge tools).

## Deliverable (name by runtime)

Write **exactly one** of:

- If you are **claude**: `docs/specs/488-ide-browser-design-mode/review-architecture-claude.md`
- If you are **codex**: `docs/specs/488-ide-browser-design-mode/review-architecture-codex.md`

Absolute paths under the worktree root above.

### Required sections
1. **Verdict** (1 paragraph): merge-as-is / merge-with-structure-followups / restructure-before-merge
2. **Findings table:** `id | severity P0–P3 | lens (arch|structure|location|stack) | claim | evidence (path:line) | recommendation`
3. **Artifact map:** ideal vs current (table)
4. **Widget stack decision:** A/B/C/D + pick for now vs later
5. **Two-bridge fit:** keep / thin / eventual unify — migration cost S/M/L
6. **Top 5 structural actions** (ordered, post-review)
7. **What is solid** (keep)

## Attribution
State in the doc header: **Review commissioned by the human maintainer (via grok dispatch).** Your agent name as reviewer.

When done: short terminal summary + path to your deliverable file.
