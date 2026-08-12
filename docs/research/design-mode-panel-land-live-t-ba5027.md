# Design Mode panel-land live remeasurement (`t-ba5027`)

**Measured:** 2026-08-12 · **EDH:** Tachyon 0.83.0 · **Final source tree:** recorded at delivery

## Verdict

The headless Extension Development Host removed the original offline blocker. Two real runtimes —
Codex 0.146.1 and Pi 0.80.10 — each listed and called `design_mode_chat_reply`; both calls carried a
`turnId`, used no markers, appended exactly one nonce-bearing event to the Design Mode JSONL, and
painted exactly one matching bubble in the live panel DOM.

The remaining current-turn claim is **not green**. Design Mode v1 deliberately lists only running
Saved Agents, while the no-`tachyon.yml`-edit fixture can create only Temporary agents. Therefore the
panel refused to send a chat turn (`No running agents`), no host-minted `dm-turn-*` wait existed, and
both accepted calls were orphan/no-wait replies. This proves runtime MCP → handler → JSONL → panel,
but not that the same tool call resolves the outstanding current turn.

## Phase 1 — production host offline

The production status door returned the same refusal four times:

```text
$ mcp__tachyon_bridge__ide_browser_status({})
error: IDE browser bridge offline. In VS Code: Tachyon: IDE Browser Bridge Start (Dev Host / Extension Development).
```

That phase had 0 current turns, 0 JSONL candidates, and 0 panel observations. It was recorded before
the EDH route below removed the host-offline condition.

## Phase 2 — live EDH runtime calls

Recipe (fixture `ide-browser-dogfood`, no `tachyon.yml` edits):

```text
TACHYON_ENGINE_CHANNEL=dev npm run build
scripts/dev-host/cli.sh point --fixture ide-browser-dogfood
node scripts/dev-host/headless-session.mjs up
Tachyon: Open IDE Browser
Tachyon: Design Mode On
```

The EDH Bridge was `http://127.0.0.1:42370/mcp`; its production IDE Browser host was
`http://127.0.0.1:45657`. Temporary Codex and Pi agents were spawned through that Bridge, not by
editing the fixture.

| Runtime | Listed | Called | Sent `turnId` | Markers | JSONL nonce | DOM bubble | Pending current wait |
|---------|:------:|:------:|:-------------:|:-------:|:-----------:|:----------:|:--------------------:|
| Codex 0.146.1 | ✓ | ✓ | ✓ `dm-turn-f3live-no-wait-7f41a2` | ✗ | 1 | 1 | **✗** no wait |
| Pi 0.80.10 | ✓ (`Tachyon 88 tools`) | ✓ | ✓ `dm-turn-f3live-no-wait-a89c31` | ✗ | 1 | 1 | **✗** no wait |

Raw JSONL evidence:

```json
{"v":1,"at":"2026-08-12T01:58:44.522Z","kind":"message","role":"agent","agent":"f3codex","text":"F3LIVE-CODEX-7f41a2","activeAgent":"f3codex","source":"tool","lineNo":1}
{"v":1,"at":"2026-08-12T02:00:53.078Z","kind":"message","role":"agent","agent":"f3codex","text":"F3LIVE-PI-a89c31","activeAgent":"f3codex","source":"tool","lineNo":2}
```

The live DOM query found one `.dm-chat-bubble` for each nonce. Durable advisory evidence
`ev-2026-08-12T02:02:08.154Z-1` attaches the screenshot and structured counts.

Pi is therefore no longer `?` for listing, calling, `turnId`, marker avoidance, or physical panel
arrival. It is **partial (`~`) overall** because the outstanding-current-turn bind was unreachable
under this fixture. The Pi orphan event inherited active speaker `f3codex`; that is expected from
the no-wait fallback and must not be presented as a correctly bound Pi turn.

## Exact remaining blocker

`IdeBrowserBridgeManager.listRunningAgents()` filters `!r.temporary` before Design Mode may send.
The fixture has `agents: {}` and its own README requires Agent Studio to create Saved Agents. That
would mutate the mirrored `tachyon.yml`, explicitly forbidden by this task. Measured counts:

- Bridge `list_agents`: 2 running Temporary runtimes (`f3codex`, `f3pi`).
- Design Mode agent menu: 0 eligible agents, exact row `No running agents`.
- Host-minted current turns: 0.
- Runtime MCP calls reaching JSONL + DOM: 2 of 2.

## Changed fact: live schema now carries `turnId`

The Bridge tool catalog visible to Codex and Pi declares optional `turnId`, unlike the stale 0.62.0
catalog measured on 2026-08-06. Both runtimes sent it and the host accepted it with no wait;
outstanding-wait acceptance remains unmeasured.

## Reproduction plan once a Saved Agent is available

One Saved Agent is enough to close the generic current-wait path requested by the resumed task:
send one unique nonce through the panel, capture its host-minted id from the delivered prompt, and
require the same runtime's MCP call. A pass requires the matching user event before the agent event
in JSONL and one matching DOM bubble. Until that run exists, F1 must not delete the pane-marker
fallback unconditionally.
