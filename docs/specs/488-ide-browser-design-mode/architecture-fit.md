# 488 — How Design Mode fits Tachyon (two hosts + three paths)

_Review memo for merge discussion on `tachyon/grok`. Not a rewrite plan._  
_Current-at-commit: `tachyon/grok` tip (see board umbrella `t-d49ef0`)._

## Product fit

Design Mode is the **in-IDE shared viewport** product:

| Surface | Owner | Job |
|---|---|---|
| **agent-browser** (267+) | Agent session | Headless / provisioned automation |
| **Companion** (414/420) | Human everyday browser | Pair, tab tools, real SSO session |
| **IDE Browser + Design Mode (488)** | VS Code editor-browser | Human + agent share the editor tab |

It sits next to Companion as an **extension-host browser surface**, not as a second orchestrator.

## Three paths (not only “two bridges”)

There are **two long-lived hosts** and **three runtime paths**. The product headline channel (human chat → agent) is the third path and must be named in reviews.

```text
(1) Agent acts on the page
Agent runtime
    │  MCP (Bearer / caller identity)
    ▼
Tachyon Bridge (engine)          Bridge.ts + tools.ts
    │  HTTP 127.0.0.1 + token
    ▼
IDE Browser Host (shell)         webview/ide-browser-bridge/*
    │  CDP
    ▼
Integrated Browser tab + page overlay

(2) Page / UI speaks to the shell
Page inject / Design Mode chrome
    │  CDP Runtime binding (or host push)
    ▼
IDE Browser Host (manager)
    │  append chat.jsonl, selection attach, screenshots
    ▼
(no agent yet)

(3) Human reaches the agent  ← PRIMARY Design Mode send channel
IDE Browser Host (chat Send)
    │  WorkspaceShellHandle.activity.sendAgentInput
    ▼
sendManagedAgentInput → tmux sendKeys → agent pane
    (same family as notify_agent delivery — not MCP, not shell HTTP)
```

| Path | Direction | Transport | Used for |
|---|---|---|---|
| **(1)** | Agent → page | MCP → HTTP → CDP | `ide_browser_*`, `design_mode_chat_reply` (agent → panel) |
| **(2)** | Page/UI → shell | CDP binding / inject | pick capture, chat UI events, open/hydrate |
| **(3)** | Human → agent | **tmux pane input** | Design Mode chat Send with optional pick context |

Path **(3)** is intentional and matches how Tachyon already wakes agents from the shell. It is **not** a bug that it skips MCP. Reviewers must not ratify a diagram that only shows (1).

## Two hosts — keep the process split

| Layer | Preferred name | Owns | Does not own |
|---|---|---|---|
| **Tachyon Bridge** | MCP Bridge | Auth, tool catalog, caller identity, tool handlers | CDP, page DOM, inject UI, tmux typing |
| **IDE Browser Host** | shell / extension host | VS Code commands, local HTTP+instance file, CDP, inject/webview UI, pick capture | Agent spawn, MCP session catalog |

Wire name “IDE Browser Bridge” is transport legacy; product language can say **IDE Browser Host** so it does not compete with **Tachyon Bridge**.

### Relation to Companion (honest asymmetry)

**Process shape** is Companion-like: engine authority + thin-ish shell, agents never dial the shell HTTP API themselves.

**Tool catalog policy is not the same as Companion tab tools:**

| | Companion `user_browser_*` | Design Mode `ide_browser_*` |
|---|---|---|
| Registration | Gated by `settings.companion.tabTools` (avoid list pollution) | **Always registered** when `ideBrowserRequest` is wired |
| Offline / unpaired | Fail closed at call time | Fail closed (`bridge_offline`) at call time |
| Why different | Opt-in human browser actuation | Design Mode chat requires tools discoverable before/without a live browser session |

Do **not** claim “mirrors Companion” for registration policy. Always-register is a deliberate 488 tradeoff (MCP freeze at connect); Companion stays settings-gated.

### Why not rewrite hosts for this merge

| Option | Verdict for Tachyon |
|---|---|
| One process (MCP+CDP) | Couples engine lifetime to extension-host reload — worse than today |
| Agent-native CDP | Duplicates agent-browser; loses shared human viewport |
| Everything in extension host | Undermines engine as auth/tools authority |
| Unified session graph | Long-term vision only — not a gate for Design Mode land |

**Merge recommendation:** land Design Mode on **two hosts + three paths**. Thin the shell later (`t-64edaf`, `t-47503a`, `t-3ef9ea`); do not unify processes as a merge gate.

## Codebase map (what lands)

| Area | Paths |
|---|---|
| Shell host | `src/webview/ide-browser-bridge/*` (not a VS Code webview app — location debt, `t-47503a` / move later) |
| Engine client | `src/ide-browser/client.ts`, `protocol.ts` |
| MCP tools | `src/bridge/tools.ts` (`ide_browser_*`, `design_mode_chat_reply`) |
| Human→agent | `manager` chat send → `activity.sendAgentInput` → tmux |
| Wiring | `src/workspace/Workspace.ts` (`ideBrowserRequest` always wired) |
| Optional ops | `bridge.refresh-tools` (catalog flips; **not** on browser start/stop) |
| Token dogfood | `agentTokenHeal.ts`, `callerIdentity` supersede/adopt |
| Fixture | `test/fixtures/ide-browser-dogfood/` |
| Spec | `docs/specs/488-ide-browser-design-mode/` |

## Product contracts already in the tree

1. **Single human→agent channel (path 3)** — Design Mode chat Send only; Selection card is inspect + attach.  
2. **Tool-only agent→panel replies (path 1)** — `design_mode_chat_reply`; no marker happy path.  
3. **Always-register tools** when `ideBrowserRequest` is wired; offline fails at call time (not Companion-gated).  
4. **Running agent only** in selector.  
5. **Theme tokens** from VS Code probe for in-page chrome (`themeTokens.ts` → `--ds-*`).

## Follow-ups (board)

Umbrella **`t-d49ef0`**. Independently shippable children:

| id | Topic |
|---|---|
| `t-4d2892` | This memo honesty (three paths + Companion claim) |
| `t-348c9a` | Inject size budget + draft-clobber check |
| `t-7aef5a` | Disambiguate `ide_browser_*` vs `user_browser_*` descriptions |
| `t-83723d` | Move dogfoodBootstrap out of production path |
| `t-08f08e` | Retire/isolate ide-browser-proto |
| `t-64edaf` | Hybrid D step 1 — chat/card → Preact webview |
| `t-47503a` | Split manager + typed engine↔host protocol |
| `t-3ef9ea` | Engine DesignModeService (thin shell) |

Also tracked in architecture reviews: naming Host vs Bridge (B1), instance arbitration (B2), lifecycle without session kill (B3), execution-graph join (B4).

## Reviewer checklist

- [x] Agree: **two hosts** stay for this land (not one process)  
- [x] Agree: **three paths** are the accurate model (MCP/HTTP/CDP, page→shell, tmux human→agent)  
- [ ] Agree: Design Mode is experimental / opt-in posture until GA settings (Q1 in spec)  
- [x] Dogfood: pick → chat attach → agent received selection (2026-08-04)  
- [ ] Dogfood: full reply via `design_mode_chat_reply` on primary runtime  
- [ ] Unit tests for design-mode + ide-browser client green on merge PR  
- [ ] No accidental merge of unrelated dirty state  

## Explicit non-goals for this merge

- Unifying the two hosts into one process  
- Multi-agent group orchestration  
- GA on-by-default  
- Full security program beyond local dogfood posture  
- Completing hybrid D / DesignModeService before land (tracked as board tasks)  
