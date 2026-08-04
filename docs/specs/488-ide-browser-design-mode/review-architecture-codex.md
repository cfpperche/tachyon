# Adversarial architecture review — SDD 488

**Review commissioned by the human maintainer (via grok dispatch). Reviewer: codex.**  
Date: 2026-08-04  
Scope: architecture, code structure, artifact location, and widget stack only. Branch `tachyon/grok`; read-only review.

## Verdict

**Restructure before merge.** Keep the two-process/two-bridge topology, but do not merge its present allocation of responsibilities or widget implementation. The engine↔extension-host boundary is legitimate: MCP identity/catalog belongs to the persistent engine, while VS Code commands and CDP belong to the extension host. The implementation nevertheless turns the supposed thin shell into a second application backend: `manager.ts` owns HTTP, CDP coordination, agent roster, prompt delivery, attention polling, chat persistence, UI messages, screenshots, and lifecycle; a 1,720-line string program owns the visible product. The smallest Tachyon-native correction is option D: retain a genuinely thin in-page picker/highlight overlay and move chat/selection chrome into a Preact VS Code webview using the existing shell/protocol/design-system conventions. Chat/turn state and agent delivery should be engine-owned. This is a medium restructuring, not a two-bridge rewrite.

## Findings

| id | severity | lens | claim | evidence | recommendation |
|---|---|---|---|---|---|
| AR-01 | P1 | stack | The 1,720-line generated IIFE is already an application framework hidden inside a template string: DOM construction, styles, chat virtualization, drag/resize, agent menu, responsive toolbar, selection card, messaging, and cleanup. It bypasses Tachyon's Preact app, typed protocol, bundle-budget, preview, and surface-conformance machinery. | `src/webview/ide-browser-bridge/designModeInject.ts:1-70,902-1204,1212-1371,1518-1617,1681-1720`; established webview build at `esbuild.mjs:228-238,294-318` | Choose D before merge. Reduce injection to picker/highlight/capture/navigation lifecycle only; implement chat and selection inspector as a normal Preact webview surface with a versioned protocol. |
| AR-02 | P1 | structure | `IdeBrowserBridgeManager` is a god object with at least seven ownership axes: HTTP server/discovery, CDP lifecycle, pick assembly/crop, roster, chat persistence/hydration, prompt delivery, and attention/typing. Its 1,062 lines make independent lifecycle and domain testing impractical. | `src/webview/ide-browser-bridge/manager.ts:37-57,113-160,160-289,291-382,384-503,504-730,736-1062` | Split into `IdeBrowserHostServer`, `BrowserSessionController`, `SelectionController`, and a narrow UI adapter. Move chat/turn orchestration and persistence to an engine Design Mode service. Keep pure pick formatting separate. |
| AR-03 | P1 | arch | The fit memo calls the IDE Browser Bridge a thin shell, but it directly queries agents, sends terminal input, polls attention, formats privileged prompts, and persists chat. This duplicates engine orchestration responsibilities and makes the shell depend on the broad `WorkspaceShellHandle`. | memo `architecture-fit.md:32-37`; `manager.ts:304-333,440-503,504-730`; broad resolver at `manager.ts:46,76-78`; wiring `register.ts:49-57,280-289` | Preserve two bridges but thin the shell: shell owns VS Code/CDP/UI hosting; engine owns agent selection validation, turns, chat log, prompt delivery, and reply ingestion. Exchange typed Design Mode commands/events through the existing extension-operation/presentation seam. |
| AR-04 | P1 | structure | The cross-process protocol is effectively untyped. `protocol.ts` types only a generic `{data: unknown}` envelope, status, and instance file; every route/body/result is an ad-hoc string/object duplicated between `tools.ts`, `client.ts`, and `manager.ts`. | `src/ide-browser/protocol.ts:1-30`; route strings `src/bridge/tools.ts:3639-3797`; client transport `src/ide-browser/client.ts:103-157`; server dispatch `manager.ts:816-924` | Define a versioned discriminated route map with request/response types and one decoder. Keep HTTP as transport, not contract. Generate or type both client and server against that map. |
| AR-05 | P1 | structure | Two browser prototypes are registered simultaneously: the rejected external-Chrome stream prototype remains reachable in Dev/Test beside the Integrated Browser implementation. That leaves duplicate commands, lifecycle code, CDP abstractions, terminology, and dogfood doors in the same product tree. | `src/extension.ts:67,3784-3793`; `src/webview/ide-browser-proto/register.ts:4-35`; six files under `src/webview/ide-browser-proto/` | Remove the retired stream prototype from production registration and source before merge, or move it to test fixtures/history. One dogfood door must exercise the implementation proposed for shipment. |
| AR-06 | P1 | location | `src/webview/ide-browser-bridge/` is a misleading location: most files run in the Node extension host or as code injected into a third-party page; none is a VS Code webview app. This conceals execution realms during review and invites imports across boundaries. | Node/vscode imports in `manager.ts:6-16` and `register.ts:12-20`; injected source builder `designModeInject.ts:44-64`; actual webview convention at `src/webview/shared/SectionPanelManager.ts:354-426` | Move host code to `src/ide-browser/shell/` (or `src/shell/ide-browser/`), page overlay to `src/ide-browser/page-overlay/`, and the new Preact UI to `src/webview/design-mode/`. Keep `src/ide-browser/` root for pure protocol/client/domain modules. |
| AR-07 | P2 | arch | `Workspace` wiring is acceptably narrow at the call site, but tool registration lives as another 180-line island inside the 5,995-line `bridge/tools.ts`. Browser policy, schemas, handlers, and transport mapping cannot be reviewed or tested as a subsystem. | `src/workspace/Workspace.ts:1784-1793`; `src/bridge/tools.ts:3618-3800`; file size 5,995 lines | Extract `registerIdeBrowserTools(mcp, deps, caller)` into `src/bridge/tools/ideBrowser.ts`, with schemas and typed protocol mapping beside it. Leave `tools.ts` as composition. |
| AR-08 | P2 | arch | Discovery through an operator-home instance file is a reasonable cross-process rendezvous, but the global directory plus parent/child matching makes browser-host ownership implicit. This is structural ambiguity between windows/worktrees, not merely a later feature. | `src/ide-browser/client.ts:13-30,71-97`; instance write `manager.ts:774-800`; memo defers arbitration at `architecture-fit.md:75-80` | Keep the artifact location, but add exact workspace identity/host instance id and deterministic arbitration before merge. Treat parent/child fallback as an explicit compatibility policy, not default matching. Cost S–M. |
| AR-09 | P2 | location | Workspace chat JSONL and cropped picks are placed under `.tachyon/`, which is the right locality, but ownership is split into two unrelated folders and the shell writes domain state directly. Retention, cleanup, schema version, and whether screenshots belong to a turn are implicit. | chat path `src/webview/ide-browser-bridge/designModeChat.ts:9-10,65-70`; screenshots `manager.ts:291-297`; ignore policy `.gitignore:35-55` | Keep runtime artifacts workspace-local and ignored, but group them under `.tachyon/design-mode/` (`chat.jsonl`, `attachments/`, optional metadata). Let an engine Design Mode store own writes and retention; shell submits captures as attachments. |
| AR-10 | P2 | stack | Option B changes syntax, not architecture. A Preact bundle injected into the inspected page still lives in the page realm, must be reinstalled on navigation, carries framework/runtime weight, cannot naturally use VS Code webview messaging/CSP, and duplicates the existing Tachyon webview stack outside its host. | current reinjection `src/webview/ide-browser-bridge/cdpSession.ts:515-609,730-775`; Preact webview build conventions `esbuild.mjs:228-238,294-318` | Reject B. Use Preact only inside a VS Code webview; keep page code framework-free and intentionally small. |
| AR-11 | P2 | stack | Option C is not physically an overlay replacement: a VS Code webview cannot render chrome over the native Integrated Browser editor. If placed beside it, C becomes D; if placed in another editor tab, it breaks the shared-viewport interaction. | Integrated Browser/CDP ownership `manager.ts:1-4`; current overlay requirement `designModeInject.ts:1-10`; webviews are separately created panels `SectionPanelManager.ts:354-426` | Reject C as phrased. Name the implementable shape D: native browser editor + thin page overlay + adjacent/sidebar Design Mode webview. |
| AR-12 | P2 | structure | Navigation reliability is spread across binding events, target events, a 250 ms pick-queue poll, a presence watcher, delayed reinjection, and cleanup globals. The widget's size magnifies every reinjection path and makes lifecycle behavior harder to establish. | `src/webview/ide-browser-bridge/cdpSession.ts:45-60,113-128,515-609,730-787`; globals/cleanup `designModeInject.ts:67-70,1681-1719` | Make `BrowserSessionController` expose one document-generation state machine. Reinstall only the small overlay per generation; webview chat survives independently and reattaches through host state. |
| AR-13 | P2 | location | `themeTokens.ts` reverse-probes VS Code styles and serializes a parallel `--ds-*` token surface into the page because the full UI lives there. This is expensive coupling to remove once chat/card use the real Tachyon webview shell. | `src/webview/ide-browser-bridge/themeTokens.ts:1-362`; consumption `designModeInject.ts:10-14,55-61`; host warming `register.ts:155-162` | With D, use standard webview design-system CSS for chat/card. Retain only a tiny semantic overlay palette (accent, border, label foreground/background) passed to page code. |
| AR-14 | P2 | arch | Naming two things “Bridge” obscures which one owns authority and encourages lifecycle operations such as tool refresh to leak across the boundary. The IDE component is more accurately an extension-host browser adapter/server. | diagram and names `architecture-fit.md:17-37`; HTTP host class `manager.ts:37`; engine Bridge tools `tools.ts:3618-3800` | Keep wire compatibility but rename product/internal concepts toward `IDE Browser Host` or `Browser Control Adapter`; reserve `Tachyon Bridge` for MCP. Cost S for docs/types, M if command ids are migrated. |
| AR-15 | P3 | location | The SDD and architecture memo are correctly colocated, but the memo states implementation facts (“chat only”, “tool-only replies”, “running agent only”) without pinning a verified commit or distinguishing target from current behavior. | `architecture-fit.md:50-69`; SDD directory `docs/specs/488-ide-browser-design-mode/` | Keep the location. Label tables as current-at-commit vs target architecture and link evidence/verification rather than letting the memo become a second mutable specification. |

## Artifact map

| Concern | Current artifact/location | Ideal owner/location | Move before main? |
|---|---|---|---|
| MCP tool registration | IDE-browser block inside `src/bridge/tools.ts` | Engine: `src/bridge/tools/ideBrowser.ts` composed by `tools.ts` | Yes |
| Cross-process contract | `src/ide-browser/protocol.ts` generic envelope; route strings elsewhere | Pure/versioned `src/ide-browser/protocol.ts` with route request/response union and decoders | Yes |
| Engine transport/discovery | `src/ide-browser/client.ts` | Keep under `src/ide-browser/client.ts`; add deterministic host identity | Yes, refine in place |
| Extension-host HTTP server | `src/webview/ide-browser-bridge/manager.ts` | `src/ide-browser/shell/IdeBrowserHostServer.ts` | Yes |
| CDP lifecycle | `src/webview/ide-browser-bridge/cdpSession.ts` | `src/ide-browser/shell/BrowserSessionController.ts` | Yes |
| Page picker/highlight | Part of `designModeInject.ts` string | Small framework-free `src/ide-browser/page-overlay/` bundle/expression with typed capture messages | Yes |
| Chat/selection UI | Part of same 1,720-line page injection | Preact app `src/webview/design-mode/{App,main,messages}.tsx` using shared shell/design system | Yes |
| Chat/turn orchestration | Mixed into shell `manager.ts` | Engine service `src/design-mode/DesignModeService.ts` (or equivalent engine domain) | Yes |
| Chat persistence | `.tachyon/design-mode-chat/chat.jsonl`, shell-owned | `.tachyon/design-mode/chat.jsonl`, engine-owned versioned store | Prefer before main; migration unnecessary for prototype state |
| Pick screenshots | `.tachyon/ide-browser-picks/*.png` | `.tachyon/design-mode/attachments/*`, referenced by turn/selection id | Prefer before main |
| Instance rendezvous | `~/.tachyon/ide-browser-instances/*.json` | Keep operator-local; enrich with exact workspace/host instance identity | Keep location |
| Theme | 362-line page token probe | Standard webview CSS for app; tiny overlay palette for inspected page | Yes with D |
| Retired stream prototype | `src/webview/ide-browser-proto/*`, still registered | Delete from shipped graph; preserve through git/fixture only | Yes |
| SDD/reviews | `docs/specs/488-ide-browser-design-mode/` | Keep | No move |

## Widget stack A/B/C/D decision

### Decision

**For merge: D — hybrid, after restructuring.** The inspected page gets only the interaction that must share its coordinate space: hover outline, click interception, compact selection indicator, and capture. Chat, agent selection, selection details, history, working state, drag/layout, and Tachyon chrome live in a Preact VS Code webview, preferably a sidebar view or a dedicated adjacent document app depending the validated workflow.

**Post-merge: remain on D.** Improve the typed host↔webview protocol and choose the final panel cardinality/location from dogfood; do not schedule a second framework migration. The overlay may later become an isolated-world bundle if the CDP proxy supports it reliably, but it stays framework-free.

| option | now | later | reason |
|---|---|---|---|
| **A — string/IIFE inject** | Reject as product stack | Keep only a drastically reduced picker bootstrap | Lowest prototype cost, highest ongoing maintenance/reinjection cost; bypasses Tachyon UI conventions. |
| **B — Preact/React injected bundle** | Reject | Reject | Makes the wrong execution realm heavier without solving navigation, isolation, theming, or ownership. |
| **C — VS Code webview for all chrome** | Reject literally | Reject literally | A webview cannot overlay the native browser editor; once placed beside it with a page picker, it is D. |
| **D — thin page inject + webview chat** | **Choose before merge** | **Keep** | Matches physical constraints and existing Tachyon Preact/protocol/design-system/build infrastructure. |

Estimated migration cost: **M**. Most domain logic already exists as separable pure functions (`pick.ts`, `designModeChat.ts`); the cost is moving state and UI, not rediscovering CDP.

## Two-bridge fit

**Keep the two-process split, thin the shell boundary; do not unify processes.** Migration cost for thinning: **M**. Cost of full unification: **L**, with no demonstrated benefit and a worse lifetime coupling.

The desired split is:

```text
Human page interaction
  → thin page overlay
  → IDE Browser Host (extension host: VS Code + CDP + webview host)
  → typed extension operation/event
  → DesignModeService (engine: turn/chat/agent authority)
  → agent input

Agent
  → Tachyon Bridge MCP design_mode_chat_reply
  → DesignModeService persists reply
  → engine presentation event
  → Design Mode webview

Agent browser-control tool
  → Tachyon Bridge MCP
  → typed IDE-browser HTTP client
  → IDE Browser Host
  → CDP
```

This preserves the reason for two bridges: the persistent engine owns agent-facing authority and durable orchestration; the extension host owns APIs that exist only inside VS Code. HTTP+instance discovery remains appropriate specifically for engine→CDP operations. Chat need not round-trip through the shell HTTP server merely because its current pixels are injected into the page.

The current name `IDE Browser Bridge` should be treated as transport legacy. `IDE Browser Host`/`Browser Control Adapter` expresses its actual role and prevents it from competing conceptually with the Tachyon Bridge.

## Top 5 structural actions

1. **Adopt D and cut the widget at the realm boundary:** page overlay only; Preact webview for chat/selection chrome.
2. **Introduce an engine-owned `DesignModeService`:** turns, agent validation/delivery, chat persistence, reply ingestion, and presentation events leave `manager.ts`.
3. **Type the engine↔browser-host protocol:** versioned route map/decoders shared by client, server, and extracted MCP tool module.
4. **Split and relocate shell code:** `IdeBrowserHostServer`, `BrowserSessionController`, `SelectionController`; remove the false `src/webview/ide-browser-bridge` grouping.
5. **Delete the retired stream prototype and consolidate runtime artifacts:** one production dogfood door; `.tachyon/design-mode/{chat.jsonl,attachments/}`; deterministic instance ownership.

## What is solid

- The fundamental engine/extension-host process split fits Tachyon and should survive.
- Design Mode is correctly distinct from Companion and agent-browser by viewport ownership and user job (`architecture-fit.md:5-15`).
- `src/ide-browser/client.ts` is already a small engine-side adapter rather than CDP logic leaking into Bridge tools.
- Pure pick shaping is well isolated in `pick.ts`; it is a good seed for a domain package.
- The status-bar registration is separated from CDP internals and uses a compact cluster (`register.ts:22-47,81-170`).
- Runtime instance files belong in operator-local state, while chat/attachments belong in ignored workspace-local `.tachyon/` state; the locality choice is sound even though ownership/naming needs consolidation.
- Tachyon already has the exact UI infrastructure needed for D: Preact bundles, shared chunks, a standard shell, typed host↔webview protocols, surface declarations, bundle budgets, and preview tooling (`esbuild.mjs:228-238,294-318`; `src/webview/shared/studio/protocol.ts:1-17,109-125`).
- The latest code correctly makes selection context-only and chat the sole send channel (`manager.ts:212-281,436-495`); that product simplification also creates a clean architectural seam for the hybrid split.
