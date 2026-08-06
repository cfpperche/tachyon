# Design Mode `design_mode_chat_reply` — runtime parity matrix (F3 / `t-dd46a4`)

**Measured:** 2026-08-06 · **Task:** `t-dd46a4` · **SDD:** 488 F3  
**Host package:** Tachyon `0.62.0` · **Evidence dir:** [`evidence-t-dd46a4-f3/`](./evidence-t-dd46a4-f3/)

## Why this exists

SDD 488 F1 wants to remove pane-marker (`START`/`END`) reply fallback. F1 is gated on F3: a living
matrix that says, per runtime, whether the agent **lists**, **calls**, and (when the shell is up)
**lands** a reply through Bridge tool `design_mode_chat_reply` under the current Design Mode prompt
shape — not under the pre-0.62.0 marker-advertising prompt that taught models to skip MCP.

Historical seed (not re-run here): 2026-08-04 Codex dogfood listed the tool yet answered with
markers (`docs/specs/488-ide-browser-design-mode/notes.md`).

## What was measured (and what was not)

| Question | How | Scope |
|----------|-----|--------|
| Tool **listed** by Bridge for the runtime | `tools/list` via each runtime's MCP connection; Claude stream-json `init.tools`; `codex mcp list`; `grok mcp doctor` | Live workspace Bridge `http://127.0.0.1:42897/mcp` |
| Model **calls** the tool on a Design Mode prompt | Headless one-shot CLI runs with the **same** instruction shape as `formatDmChatPrompt` (incl. `Turn id: dm-turn-…` and required `design_mode_chat_reply({ text, turnId })`) | claude / codex / grok only (workspace fleet) |
| Reply **lands** in Design Mode chat panel | Would require IDE Browser Bridge + chat wait | **Unmeasured** — live Bridge returned `IDE browser bridge offline` on every call |

**Not done (constraints):** no `spawn_agent`, no marker-fallback removal, no `verify:full`, no Pi.

## Prompt used

Exact text in [`evidence-t-dd46a4-f3/dm-prompt.txt`](./evidence-t-dd46a4-f3/dm-prompt.txt). Shape matches
`formatDmChatPrompt` after `t-181925` / 0.62.0: `Turn id: dm-turn-f3matrix01`, required tool call with
that `turnId`, no marker instructions.

## Live Bridge schema note (load-bearing)

Direct MCP `tools/list` on the **running** Bridge (2026-08-06) returned `design_mode_chat_reply`
with properties **`text`** and **`agent` only** — **no `turnId`**, despite:

- source `src/bridge/tools/ide-browser.ts` declaring optional `turnId` (worktree + primary both at
  0.62.0 text), and
- the Design Mode prompt requiring `turnId`.

The engine process `tachyon-engine:b349073a` had been up since 2026-08-05. Agents therefore saw a
schema that disagrees with the prompt and with the tree under measurement. Calls that included
`turnId` still reached the handler (offline error, not schema refuse). Claude omitted `turnId` and
still reached the handler. **Panel bind correctness under an outstanding chat wait was not
exercisable** without IDE browser + a live wait.

## Binary versions and invocations

| Runtime | Version | Invocation (summary) |
|---------|---------|----------------------|
| Claude | **2.1.223** (Claude Code) | `HOME=/home/goat CLAUDE_CONFIG_DIR=/home/goat/.claude claude -p "$PROMPT" --mcp-config <meas>/claude/mcp.json --dangerously-skip-permissions --output-format stream-json --verbose --max-turns 4` |
| Codex | **codex-cli 0.146.0** | `CODEX_HOME=<meas>/codex-home codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json -c 'mcp_servers.tachyon_bridge.default_tools_approval_mode="approve"' "$PROMPT"` with private `config.toml` pointing at Bridge URL + `bearer_token_env_var` |
| Grok | **0.2.118** (`1e1687c1cf` stable) | `GROK_HOME=<meas>/grok HOME=<meas>/grok grok -p "$PROMPT" --always-approve --output-format json --no-memory --max-turns 4 --cwd /tmp` with private `config.toml` Bridge MCP + seeded `auth.json` |

Private measurement root: `/tmp/replymatrix-f3-*` (copies under `evidence-t-dd46a4-f3/`).

## Matrix

Legend for this matrix only:

| Mark | Meaning |
|------|---------|
| **✓** | Observed on the stated binary + invocation |
| **~** | Partial / caveated observation |
| **✗** | Observed failure of the capability (not merely offline shell) |
| **?** | Unmeasured — declared with reason |

| Runtime | Version | Tool listed | Tool called (headless DM prompt) | Passed `turnId` in args | Markers used | Reply lands in panel | Notes |
|---------|---------|:-----------:|:--------------------------------:|:-----------------------:|:------------:|:--------------------:|-------|
| Claude | 2.1.223 | **✓** `mcp__tachyon_bridge__design_mode_chat_reply` in `init.tools`; MCP `connected` | **✓** after `ToolSearch` select | **✗** called with `{text}` only | **✗** not used | **?** IDE browser bridge offline | Evidence: `claude4-stdout.jsonl` |
| Codex | 0.146.0 | **✓** `codex mcp list` → tachyon_bridge enabled | **✓** `mcp_tool_call` | **✓** `{text, turnId: "dm-turn-f3matrix01"}` | **✗** not used | **?** offline | Evidence: `codex2-stdout.jsonl` item.started/completed; first non-JSON run also logged `mcp: tachyon_bridge/design_mode_chat_reply started/(failed)` |
| Grok | 0.2.118 | **✓** `grok mcp doctor` → 113 tools, handshake OK | **✓** `use_tool` ×2 | **✓** first call `{text, turnId}`; second `{text}` only after offline | **✗** not used | **?** offline | Evidence: `grok-chat-tool-calls.jsonl`, `grok-stdout.json` |
| Pi | — | **?** | **?** | **?** | **?** | **?** | Not a workspace fleet runtime for this measurement; left unmeasured on purpose |

### Call-time result (all three)

Every successful tool invocation returned the same Bridge error (isError / failed status):

```text
error: IDE browser bridge offline. In VS Code: Tachyon: IDE Browser Bridge Start (Dev Host / Extension Development).
```

That proves: runtime → MCP → Bridge tool handler path is live. It does **not** prove chat JSONL /
panel append.

## F1 (remove pane-marker fallback) verdict

| Claim | Verdict |
|-------|---------|
| Claude / Codex / Grok **can call** `design_mode_chat_reply` when given the current tool-only Design Mode prompt | **Yes — measured** |
| Historical Codex “listed but used markers” under the **current** prompt shape | **Not reproduced** on 0.146.0 in this headless probe |
| Safe to **delete** `extractDmChatReplyMarkers` / marker primary path (F1) for all runtimes | **Not yet** — (1) panel land unmeasured (IDE bridge offline); (2) Pi unmeasured; (3) live Bridge `tools/list` still omits `turnId` while the prompt requires it, so turn-bind behavior under a real chat wait is unproven on the running engine |
| Safe to treat F1 as **unblocked for tool-compliance on claude/codex/grok** (the risk that motivated F3) | **Yes, with the caveats above** — F1 implementer should re-dogfood once with IDE Browser Bridge **up** on each of the three before deleting the fallback |

Plain language for the coordinator: **F1 is no longer blocked by “Codex won’t call the tool” on the
versions above.** It remains blocked on a short live panel dogfood (and optional Pi row) if the bar
is “markers never needed in production,” not merely “models can invoke the MCP tool.”

## Raw evidence files

Under [`evidence-t-dd46a4-f3/`](./evidence-t-dd46a4-f3/):

- `versions.env` — binary versions + date
- `dm-prompt.txt` — prompt
- `claude4-stdout.jsonl` — Claude stream-json (listed + call)
- `codex2-stdout.jsonl` — Codex JSONL tool call with turnId
- `grok-stdout.json`, `grok-chat-tool-calls.jsonl`, `grok-mcp-doctor.txt`
- earlier failed Claude auth probes (`claude-stdout.jsonl`, `claude3-*`) kept for the trail
