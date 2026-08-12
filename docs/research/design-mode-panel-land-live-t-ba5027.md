# Design Mode panel-land live remeasurement (`t-ba5027`)

**Attempted:** 2026-08-12 · **Tree:** `60f7ec217d534c2473dfd1ae82abdd9e89b3edc3`

## Verdict

The production IDE Browser Bridge was still offline, so this attempt produced **zero panel-land
observations**. No runtime is marked green from it. The original F3 gap remains open: a Bridge tool
call reaching its handler is not evidence that the reply entered the current turn's chat JSONL and
rendered in the panel.

This is the task's declared blocked outcome, not a substitute headless result. The coordinator also
reproduced the same refusal and asked the human to start **Tachyon: IDE Browser Bridge Start**, open
the Integrated Browser, and enable Design Mode in the fleet VS Code window. The measurement cannot
mint a production chat turn or inspect its panel while that host is absent.

## Exact live checks

From the isolated worktree:

```text
$ mcp__tachyon_bridge__ide_browser_status({})
error: IDE browser bridge offline. In VS Code: Tachyon: IDE Browser Bridge Start (Dev Host / Extension Development).
```

The check was repeated four times during the attempt, before and after coordinator escalation; all
four returned the same refusal. Consequently there were **0 current Design Mode turns**, **0
candidate agent replies in `.tachyon/design-mode-chat/chat.jsonl`**, and **0 panel messages** to bind
to a turn.

The current installed binaries were present:

| Runtime | Installed version | Live turns sent | Tool calls observed in this attempt | Current-turn JSONL + panel land |
|---------|-------------------|:---------------:|:-----------------------------------:|:-------------------------------:|
| Claude | 2.1.228 | 0 | 0 | **?** bridge offline |
| Codex | 0.146.1 | 0 | 0 | **?** bridge offline |
| Grok | 1.0.0 (`3cd0d0cbce`, stable) | 0 | 0 | **?** bridge offline |
| Pi | 0.80.10 | 0 | 0 | **?** bridge offline |
| OpenCode | 1.18.15 | 0 | 0 | **?** bridge offline |

Pi is **applicable**, not `—`: it is an active Tachyon agent runtime with Bridge MCP support, and
Design Mode selects a running agent rather than branching on runtime family. Calling Pi
not-applicable merely because no Pi agent was running would falsify the product path. Its row
therefore remains `?` until a live Pi turn is measured. The same reasoning applies to OpenCode.

## Changed fact: live schema now carries `turnId`

The Bridge tool catalog visible to this Codex session declares:

```ts
design_mode_chat_reply(args: {
  agent?: string;
  edit?: { files: string[]; patch: string; summary: string };
  text: string;
  turnId?: string;
})
```

That differs from the 2026-08-06 measurement, whose long-lived 0.62.0 Bridge omitted `turnId` from
`tools/list`. It removes the catalog mismatch for this session, but it does **not** prove any model
sends the value or that the host accepts it for the outstanding turn. Those remain per-runtime live
observations.

## Reproduction plan once the host is online

For each runtime independently, use the production panel to send a unique nonce, record the minted
`dm-turn-*` id from the delivered prompt, and require `design_mode_chat_reply({text, turnId})`. A pass
requires all of the following for that same nonce and turn id:

1. the runtime lists and calls `design_mode_chat_reply`;
2. the call arguments include the prompt's current `turnId` and contain no pane markers;
3. the agent event is appended after the matching user event in
   `.tachyon/design-mode-chat/chat.jsonl`; and
4. the same agent text is visible in the Design Mode panel.

Measure Claude, Codex, Grok, Pi, and OpenCode separately; do not generalize from one runtime. Until
that run exists, F1 must not delete the pane-marker fallback unconditionally.
