# 488 — ide-browser-design-mode — plan

_Drafted from `spec.md` on 2026-08-04. The approach, not the steps (those go in `tasks.md`)._

## Approach

Productize the **existing prototype** on `tachyon/grok` into a **thin v1 loop**, without expanding into
multi-agent chat product or Companion/agent-browser territory.

### Shape of the solution

1. **Keep the two-bridge architecture**  
   Tachyon Bridge (MCP, engine) remains the only agent-facing surface. IDE Browser Bridge stays a
   shell HTTP+CDP service with instance-file discovery. Document the split so implementers do not
   “merge” them into one process by accident.

2. **Always-register IDE tools on the Tachyon Bridge**  
   When `ideBrowserRequest` is wired (production Workspace), register `ide_browser_*` and
   `design_mode_chat_reply` unconditionally. Offline → call-time `bridge_offline` (companion-style,
   SDD 414 pattern: list tools, fail closed on pair/offline).

3. **Refresh MCP catalog on shell lifecycle**  
   On IDE Browser Bridge start/stop, invoke engine `bridge.refresh-tools` →
   `Bridge.forceToolListRefresh()` so sessions created earlier re-run `registerTools`. Document that
   some runtimes still require reconnect if they ignore `tools/list_changed`.

4. **Design Mode v1 UX = single active agent + durable chat**  
   - Toolbar: agent selector among **running/saved** agents (prototype has this; lock to one active
     speaker for sends).  
   - Chat: floating panel, drag/resize, hydrate from workspace JSONL, virtualize if needed.  
   - Prompt: path to chat store + current user text + hard instruction to call
     `design_mode_chat_reply`.  
   - Working state: poll attention (not fixed timeouts alone).

5. **Use one reply path after the live tool matrix is green**
   F1 was completed by `t-45b266` after the live Claude/Codex/Grok matrix closed;
   `design_mode_chat_reply` is the sole reply path.

6. **Ship gate is dogfood, not feature completeness**  
   v1 green = pick + chat + tool reply on ≥1 primary runtime + offline tool still listed. Follow-ups
   F2–F10 stay tracked in `spec.md`, not silently implemented.

7. **No merge to `main` from this plan alone**  
   Implementation continues on `tachyon/grok` (or a successor feature branch). Merge is F10 /
   maintainer decision after ratify + dogfood.

### Delivery phases

| Phase | Name | Outcome |
|---|---|---|
| **P0** | Contract + catalog reliability | Spec ratified; tools always listed; refresh on start/stop; unit tests green |
| **P1** | Loop reliability | Pick → agent → `design_mode_chat_reply` lands; chat hydrate + attention working |
| **P2** | Dogfood gate | Human checklist on fixture; multi-runtime notes; tool-only reply path proven live |
| **P3** | Follow-ups (separate) | F2 group chat, F4 GA gate, F5 pick quality, F6 security, F7 cookbook — new tasks/SDDs |

P0–P2 are **this SDD**. P3 is explicitly split.

## Key decisions

- **Two bridges, not one** — chosen because shell CDP lifecycle belongs in the extension host and
  MCP auth/tooling belongs in the engine; rejected “agent talks CDP directly” (bypasses Tachyon
  identity and makes multi-runtime worse).
- **Always-register tools** — chosen after dogfood: gating on live instance at MCP connect left
  agents without `design_mode_chat_reply`; rejected “only list when online” as product-hostile.
- **Single active agent in v1** — chosen to avoid answer-routing product design; rejected default
  multi-agent group orchestration (F2).
- **JSONL chat store for v1** — chosen for simplicity and human-readable dogfood; rejected SQLite
  until concurrency/size requires it (Q3).
- **Tool name `design_mode_chat_reply`** — chosen to sit beside `ide_browser_*` and stay distinct
  from `user_browser_*` (Companion); rejected reusing Companion tool namespace.
- **Stay on feature branch** — maintainer request; rejected opportunistic main merge from prototype.

## Files touched (prototype map → productize)

| Area | Paths (current prototype) | Role |
|---|---|---|
| Shell manager | `src/webview/ide-browser-bridge/manager.ts` | HTTP bridge, start/stop, chat routes, attention poll |
| CDP / inject | `src/webview/ide-browser-bridge/cdpSession.ts`, `designModeInject.ts` | Design Mode overlay, chat UI inject, Trusted Types |
| Chat store | `src/webview/ide-browser-bridge/designModeChat.ts` | JSONL append/tail and tool-only prompt format |
| Pick | `src/webview/ide-browser-bridge/pick.ts` | Pick payload + agent prompt assembly |
| Commands / bars | `src/webview/ide-browser-bridge/register.ts` | Commands, status-bar cluster |
| Engine client | `src/ide-browser/client.ts`, `protocol.js` | Discovery, sweep, `ideBrowserRequest` |
| Bridge tools | `src/bridge/tools.ts` | `ide_browser_*`, `design_mode_chat_reply` registration |
| Bridge session | `src/bridge/Bridge.ts` | `forceToolListRefresh`, `announceToolListChanged` |
| Workspace wiring | `src/workspace/Workspace.ts` | deps: `ideBrowserRequest` / enabled probe |
| Extension ops | `src/runtime-api/extensionOperations.ts`, `src/engine-service/extensionOperationService.ts` | `bridge.refresh-tools` |
| Fixture | `test/fixtures/ide-browser-dogfood/` | Clean dogfood workspace |
| Tests | `test/unit/designModeChat.test.ts`, `designModeInject.test.ts`, `ideBrowserClient.test.ts`, … | Unit gate |

New for P0 if not already present: tighten registration gate; ensure start/stop refresh; tests for
“tools registered without live instance”.

## Risks & unknowns

| Risk | Mitigation |
|---|---|
| Runtime ignores `tools/list_changed` after refresh | Document restart; dogfood Codex/Claude reconnect; always-register reduces need for mid-session add |
| Agent lists tool but does not call it (seen with Codex) | Stronger prompt; demote markers; optional system nudge when Design Mode message is injected |
| Trusted Types / inject breakage on page navigation | Re-inject on nav; unit tests for sanitize; human dogfood after SPA navigations |
| Instance path mismatch (fixture vs repo root) | Discovery already allows parent/child root match; dogfood on fixture root only |
| Chat UI “working” false positives | Attention poll + grace for tool reply (prototype); keep in acceptance |
| Scope creep into multi-agent chat | F2 deferred; reject PRs that make group orchestration default before v1 green |
| Security of `ide_browser_eval` | F6 before GA; local loopback + token for now |

## Visual impact

- **Surfaces:** Integrated Browser tab chrome (toolbar inject), Design Mode chat floating panel,
  status-bar icon cluster, optional dropdown for agent select.
- **Risks:** dropdown mis-positioned under `transform` (fixed with absolute anchoring in prototype);
  scrollbar double-bars; panel not draggable; dense status-bar labels.
- **Proof for close:** human screenshots under `docs/specs/488-ide-browser-design-mode/evidence/`
  (F8) — not required to draft the SDD.

## Sources consulted

- `docs/specs/414-browser-user-companion/spec.md` — companion vs agent-browser matrix; always-register /
  fail-closed tool pattern
- `docs/specs/420-companion-tab-tools-v2/spec.md` — tab tools productization style; phased follow-ups
- Prototype on `tachyon/grok`: `src/webview/ide-browser-bridge/*`, `src/ide-browser/*`,
  `src/bridge/tools.ts` (ide browser block), `src/bridge/Bridge.ts` (`forceToolListRefresh`)
- Dogfood session 2026-08-04: Codex listed `design_mode_chat_reply` yet used markers; instance PID
  death; tool catalog race when gated on live instance at MCP connect
- Product lean conversation: v1 = reliable single-agent visual loop; not multi-agent WhatsApp product
