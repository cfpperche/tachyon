# t-77e1db - External Tool Attribution

## Goal

When a Tachyon agent opens an external GUI tool, the sidebar should show which agent owns or touched that surface so a
busy fleet does not leave the human guessing. The immediate dogfood case is Chromium opened on the Windows host from a
WSL agent, but the design should also cover `agent-browser`, `agent-desktop`, `agent-screen`, headless Chrome, and the
host-action broker path.

This is a design-only note. No product implementation is included here.

## What Counts as an External Tool

An external tool is a process or host surface whose user-visible or host-mutating state outlives the immediate shell
command or appears outside the agent pane:

- Display-backed GUI windows: Chrome/Chromium, Edge, VS Code windows, native Windows apps launched from WSL, WSLg/X11
  apps, and app windows reached through `agent-desktop`.
- Browser automation surfaces: `agent-browser` headed Chrome windows, headless Chrome sessions that keep a browser
  process alive, and browser profiles/sessions opened through plugin launchers.
- Desktop inspection/control surfaces: `agent-screen` screenshots/list-windows and `agent-desktop` launch/open/focus
  commands, especially when they return a host `window_id`, pid, or session id.
- Governed host actions that mutate the host UI or VS Code host, including the host-action Computer Use direction from
  t-e23e57/t-359.

Pure network CLI calls, short-lived compilers/tests, normal shell subprocesses, and file-only tools are not external
tools for v1 unless they launch one of the visible surfaces above.

## Existing Surfaces

Relevant repo inventory:

- `AgentManager` already injects `TACHYON_AGENT_NAME` on spawn, restart, resume, and fork, alongside Bridge env and
  per-agent tokens. That gives cooperative child processes an inherited identity.
- The sidebar row model is `AgentVM` in `src/sidebar/types.ts`, mapped through `src/sidebar/agentModel.ts`, and rendered
  as compact badges in `src/webview/sidebar/App.tsx`.
- `agent-desktop` specs 334/336/338 already define Windows-host launch/open/focus, JSON output, session ledgers, Chrome
  profile isolation, conservative window ownership, and cleanup.
- `agent-screen` spec 283 already lists/captures Windows-host windows from WSL and can report process/window metadata.
- `agent-browser` specs 267/268/269/271 route the browser CLI through Tachyon's plugin launcher. Launcher policy is
  cooperative and honest about same-user bypass; it is still the correct place for first-class attribution when used.
- Host actions from spec 359 already route through `run_host_action`, using Bridge-resolved caller identity and an audit
  sink. Computer Use should reuse that caller identity rather than invent another attribution channel.

## Recommended v1 Strategy

Use a two-lane design:

1. **Positive attribution through cooperative launch paths.**
   Tachyon should record external tool sessions when a known launch surface runs with a caller identity:
   `agent-desktop`, `agent-browser`, `agent-screen`, `_tachyon-tool`, and `run_host_action`. These paths can stamp
   `agent`, `tool`, `kind`, `sessionId`, `pid`, `windowId`, `startedAt`, and bounded command metadata at the moment of
   launch or host mutation.

2. **Best-effort discovery from live pane process trees.**
   A lightweight watcher can map each live agent to its tmux pane root pid and walk `/proc` descendants looking for
   known GUI/browser processes. It should read `/proc/<pid>/environ` for `TACHYON_AGENT_NAME` when permitted, and fall
   back to ancestor ownership when the descendant is still in the pane process tree. This catches direct `chromium`,
   `google-chrome`, `msedge.exe`, `powershell.exe Start-Process`, `cmd.exe /c start`, `wslview`, and similar launches
   when they remain attributable long enough.

The cooperative lane is authoritative. The process-tree lane is advisory and should never overclaim ownership after a
process detaches, crosses the WSL/Windows boundary without pid continuity, or routes through a single-instance app.

## Why Not Process Tree Only

Process-tree attribution is attractive because Tachyon already knows pane pids and every agent inherits
`TACHYON_AGENT_NAME`. It is not enough for v1:

- Windows-host GUI launches from WSL can detach or route through `powershell.exe`, `cmd.exe`, `explorer.exe`, or a
  browser single-instance handoff, losing a useful Linux descendant relationship.
- Chromium/Chrome may forward a URL to an existing browser process; the visible window may not be a child of the agent
  shell.
- `/proc/<pid>/environ` may be unavailable or stale after exec, and Windows processes do not expose a Linux env in the
  same way.
- Scanning all processes can become noisy on a busy fleet and creates privacy risk if commands/URLs are captured
  naively.

Therefore process scanning is a fallback signal, not the source of truth.

## Fallbacks

Fallback order for an external surface:

1. **Explicit session record:** tool launcher, `agent-desktop`, `agent-browser`, `agent-screen`, or host-action broker
   reports caller identity.
2. **Inherited env proof:** target process environment contains `TACHYON_AGENT_NAME=<agent>`.
3. **Pane descendant proof:** target pid is still a descendant of the agent's pane pid.
4. **Window-session proof:** `agent-desktop` or `agent-screen` returns a window that matches a previously recorded
   session profile/window id/pid tuple.
5. **Unattributed surfaced event:** if a known GUI appears but attribution is weak, show a neutral fleet-level entry in
   diagnostics, not an agent badge.

If signals conflict, prefer explicit Bridge/tool-launch caller identity over env over process tree. Conflicts should be
logged as diagnostics with redacted command metadata.

## Data Model

Add a runtime-owned external tool registry, projected into the sidebar VM.

Ephemeral state is the source for UI:

```ts
interface ExternalToolSession {
  id: string;
  agent: string;
  kind: "browser" | "desktop" | "screen" | "host-action" | "gui" | "unknown";
  tool: string;
  source: "tool-launcher" | "agent-desktop" | "agent-browser" | "agent-screen" | "host-action" | "proc-env" | "proc-tree";
  confidence: "strong" | "medium" | "weak";
  startedAt: string;
  lastSeenAt: string;
  pid?: number;
  windowId?: string;
  sessionId?: string;
  title?: string;
  commandLabel?: string;
  state: "active" | "exited" | "stale";
}
```

Durable data should be minimal:

- Keep existing plugin-owned ledgers for cleanup where they already exist, such as `agent-desktop` session ledgers.
- Add an optional append-only diagnostic log under `.tachyon/external-tools/events.jsonl` only for launch/exit/audit
  events. It should be off the critical sidebar path and safe to delete.
- Do not persist full URLs, full command lines, screenshots, window titles, or environment blocks by default.
- On extension reload, rebuild active UI state from plugin ledgers plus a fresh process/window scan; durable logs are
  for postmortem, not truth.

## Sidebar UX

Extend `AgentVM` with an optional compact external-tools summary:

```ts
externalTools?: {
  active: number;
  kinds: Array<"browser" | "desktop" | "screen" | "host-action" | "gui">;
  strongestConfidence: "strong" | "medium" | "weak";
  items: Array<{
    id: string;
    kind: string;
    tool: string;
    title?: string;
    pid?: number;
    windowId?: string;
    startedAt: string;
    source: string;
    confidence: string;
  }>;
}
```

Rendering:

- Show a small badge in the existing row-meta badge cluster: `browser`, `desktop`, or `tools N`.
- Use warning tone only for weak attribution or stale cleanup-needed sessions. Strong active sessions should be
  informational, not alarming.
- Badge title/detail should show bounded metadata: tool, source, pid/window id when available, started time, and whether
  cleanup is available.
- Clear the badge when the process exits, the owned window closes, cleanup marks the session closed, or no signal has
  been seen past a short stale threshold.
- If several sessions are active, collapse to `tools N` and expose details through a click/hover popover or existing row
  action pattern.
- Optional later: toast once per newly attributed visible GUI launch, e.g. `cxExtTools opened Chrome`, with rate limiting
  to avoid noisy automation loops.

## Privacy

Default to attribution, not surveillance:

- Store/display process names, coarse tool kind, pids/window ids, timestamps, and ownership source.
- Redact or omit URLs by default. If a URL is needed for debugging, show origin only and persist the full URL only behind
  an explicit diagnostic mode.
- Bound window titles and treat them as sensitive. Avoid durable title storage unless the existing tool ledger already
  requires it for cleanup; even then, use it for revalidation, not sidebar display.
- Never persist environment variables. Read only `TACHYON_AGENT_NAME` from `/proc/<pid>/environ` when needed.
- Do not capture screenshots or accessibility trees for attribution.
- Do not use this feature to close or kill user apps. Cleanup remains delegated to existing conservative tool ownership
  flows like `agent-desktop cleanup`.

## Phased Implementation Tasks

1. **Detect**
   Add a small host-side `ExternalToolRegistry` and process/window detector. Start with Linux/WSL `/proc` descendant
   scanning from pane pids and known process-name heuristics. Add unit tests with fake proc trees.

2. **Attribute**
   Wire cooperative event producers: `_tachyon-tool` launch wrapper, `agent-desktop` JSON/session output,
   `agent-browser` launcher invocation, `agent-screen` host-window commands, and `run_host_action`. Normalize all of
   them into `ExternalToolSession` records with source/confidence.

3. **UI**
   Extend `AgentVM`, `toAgentVM`, sidebar fixtures, and row badges with the compact summary. Add webview tests for
   single browser, multiple tools, weak attribution, and clear-on-exit.

4. **Lifecycle**
   Reconcile active sessions on refresh/reload. Clear by pid exit, owned-window disappearance, plugin cleanup events, or
   stale timeout. Keep durable event logging optional and bounded.

5. **Optional Toast**
   Add a rate-limited notification for newly attributed visible GUI launches after the badge is stable. Keep it disabled
   for headless/browser-only automation unless dogfood shows the badge is not discoverable enough.

## Open Questions

1. Should weak process-tree-only attribution appear on the agent row by default, or only after a cooperative source has
   been seen for that agent/tool class?
2. Where should the detail UI live: a badge popover inside the sidebar row, an existing inspector/detail panel, or both?
3. Should `agent-desktop` and `agent-browser` share a Tachyon-generated session id format so cleanup/session links can be
   displayed uniformly?

## Explicit Non-goals

- No full audit of every process an agent starts.
- No guarantee against same-user bypass; direct raw executable launches can evade cooperative launchers.
- No killing, force-closing, or stealing focus from user-owned apps.
- No multi-user host attribution or cross-account process inspection.
- No durable storage of full URLs, full command lines, screenshots, accessibility trees, or env blocks.
- No implementation of Computer Use itself; host-action attribution should reuse that feature's broker/audit identity.
- No product code in this design task.
