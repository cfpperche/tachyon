# 488 — How Design Mode fits Tachyon (two bridges)

_Review memo for merge discussion on `tachyon/grok`. Not a rewrite plan._

## Product fit

Design Mode is the **in-IDE shared viewport** product:

| Surface | Owner | Job |
|---|---|---|
| **agent-browser** (267+) | Agent session | Headless / provisioned automation |
| **Companion** (414/420) | Human everyday browser | Pair, tab tools, real SSO session |
| **IDE Browser + Design Mode (488)** | VS Code editor-browser | Human + agent share the editor tab |

It belongs next to Companion as a **shell**, not as a second orchestrator.

## Two bridges — current shape (keep for this merge)

```text
Agent runtime
    │  MCP (Bearer / caller identity)
    ▼
Tachyon Bridge (engine)     Bridge.ts + tools.ts
    │  HTTP 127.0.0.1 + token
    ▼
IDE Browser Bridge (shell)  webview/ide-browser-bridge/*
    │  CDP
    ▼
Integrated Browser tab + Design Mode inject/chat
```

| Layer | Owns | Does not own |
|---|---|---|
| **Tachyon Bridge** | Auth, tool catalog, agent identity, `design_mode_chat_reply` / `ide_browser_*` | CDP, page DOM, inject UI |
| **IDE Browser Bridge** | Local HTTP, instance discovery file, CDP, chat JSONL UI, pick capture | MCP sessions, agent spawn |

This mirrors **Companion**: thin shell + engine authority. Agents never call the IDE Browser Bridge directly.

### Why not rewrite for this merge

| Option | Verdict for Tachyon |
|---|---|
| One process (MCP+CDP) | Couples engine lifetime to extension host reload — worse than today |
| Agent-native CDP | Duplicates agent-browser; loses shared human viewport |
| Everything in extension host | Undermines engine as auth/tools authority |
| Unified session graph | Long-term vision only — not a gate for Design Mode land |

**Merge recommendation:** land Design Mode **on the two-bridge shape**. Track a possible later unification as backlog (see below), not as a prerequisite.

## Codebase map (what lands)

| Area | Paths |
|---|---|
| Shell | `src/webview/ide-browser-bridge/*` |
| Engine client | `src/ide-browser/client.ts`, `protocol` |
| MCP tools | `src/bridge/tools.ts` (`ide_browser_*`, `design_mode_chat_reply`) |
| Wiring | `src/workspace/Workspace.ts` (`ideBrowserRequest` always wired) |
| Optional ops | `bridge.refresh-tools` (settings-like flips; **not** on browser start/stop) |
| Token dogfood | `agentTokenHeal.ts`, `callerIdentity` supersede/adopt |
| Fixture | `test/fixtures/ide-browser-dogfood/` |
| Spec | `docs/specs/488-ide-browser-design-mode/` |

## Product contracts already in the tree

1. **Single human→agent channel** — Design Mode chat only; Selection card is inspect + attach.  
2. **Tool-only replies** — `design_mode_chat_reply`; no marker happy path.  
3. **Always-register tools** when `ideBrowserRequest` is wired; offline fails at call time.  
4. **Running agent only** in selector.  
5. **Theme tokens** from VS Code probe (`themeTokens.ts` → `--ds-*` on inject).

## Follow-ups that may touch “two bridges” (post-merge)

Do **not** block merge. Open as separate work after ratify:

| ID | Topic | Fit |
|---|---|---|
| B1 | Naming in product UI (“Tachyon Bridge” vs “IDE Browser”) | Docs / status bar only |
| B2 | One live instance per workspace (strict arbitration) | `ide-browser/client.ts` |
| B3 | Optional later: shared lifecycle events engine↔shell without session kill | Bridge + manager |
| B4 | Session-graph / execution-graph join for browser turns | SDD 480 family — long horizon |

## Reviewer checklist

- [ ] Agree: two bridges stay for this land  
- [ ] Agree: Design Mode is experimental / opt-in posture until GA settings (Q1 in spec)  
- [ ] Dogfood loop: pick → chat → `design_mode_chat_reply` (maintainer or CI human)  
- [ ] No accidental merge of unrelated dirty state  
- [ ] Unit tests for design-mode + ide-browser client green  

## Explicit non-goals for this merge

- Unifying the two bridges into one process  
- Multi-agent group orchestration  
- GA on-by-default  
- Full security program (eval allowlist etc.) beyond local dogfood posture  
