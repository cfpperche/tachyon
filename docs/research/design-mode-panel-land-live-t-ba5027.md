# Design Mode panel-land live remeasurement (`t-ba5027`)

**Measured:** 2026-08-12 · **EDH:** Tachyon 0.83.0 · **Final source tree:** recorded at delivery

## Verdict

The headless Extension Development Host removed the original offline blocker. Two real runtimes —
Codex 0.146.1 and Pi 0.80.10 — each listed and called `design_mode_chat_reply`; both calls carried a
`turnId`, used no markers, appended exactly one nonce-bearing event to the Design Mode JSONL, and
painted exactly one matching bubble in the live panel DOM.

The generic current-turn seam is now **green for Claude only**. Later on 2026-08-12, the production
workspace issued a turn to a live Saved Claude agent, recorded the outstanding `dm-turn-*`, and
accepted the agent's `design_mode_chat_reply` for that exact turn into the chat JSONL. This does not
promote Codex, Grok, Pi, or OpenCode by analogy: the earlier Codex and Pi calls remain orphan/no-wait
measurements, Grok has only the earlier offline headless half, and OpenCode remains unmeasured.

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

## Refuted blocker and exact remaining matrix gap

The initial report attributed the empty Design Mode menu to
`IdeBrowserBridgeManager.listRunningAgents()` filtering `!r.temporary`, and therefore concluded that
the fixture needed a Saved Agent. `t-a4060b` refuted that explanation at the production query door:
`agents.list` rows expose `lifetime`, not a boolean `temporary`, so `!r.temporary` was true for both
Temporary and Saved agents. The menu's empty result was an indistinguishable failure, not proof of
an eligibility rule. Preserve the earlier observed counts as measurements, but not their old cause:

- Bridge `list_agents`: 2 running Temporary runtimes (`f3codex`, `f3pi`).
- Design Mode agent menu: 0 eligible agents, exact row `No running agents`.
- Host-minted current turns in that EDH run: 0.
- Runtime MCP calls reaching JSONL + DOM: 2 of 2.

The later production event closes the missing current-wait chain for Claude:

| JSONL line | Time | Evidence |
|:----------:|------|----------|
| 2 | 12:48:33 | user selection message, active agent `claude` |
| 3 | 12:48:43 | host names pending turn `dm-turn-4fe022b5-58bd-46b5-9d48-44a72c57a477` after Claude finished without a reply |
| 4 | 12:50:08 | agent message for `claude`, `source:"tool"`, produced by `design_mode_chat_reply` with that turn id |

This promotes Claude's §3.1.3 `Sent turnId` and `Panel land` cells to `✓`. The exact remaining F3
gap is runtime-specific pending-turn resolution for Codex, Grok, and Pi, plus the still-unmeasured
OpenCode row. Under `t-45b266`'s explicit “after runtime matrix (F3) is green” criterion, F1 therefore
remains blocked even though the generic host-wait mechanism now has one live end-to-end proof.

## Changed fact: live schema now carries `turnId`

The Bridge tool catalog visible to Codex and Pi declares optional `turnId`, unlike the stale 0.62.0
catalog measured on 2026-08-06. Both runtimes sent it and the host accepted it with no wait;
outstanding-wait acceptance remains unmeasured.

## Reproduction plan for each remaining runtime

For Codex, Grok, and Pi, send one unique nonce through the panel while that runtime is active,
capture the host-minted id from the delivered prompt, and require that same runtime's MCP call.
A pass requires the matching user event and outstanding-turn record before the tool-sourced agent
event in JSONL, plus one matching DOM bubble. Measure the same chain for OpenCode, including its
currently unknown listing/call/marker cells. Until those runtime rows are green (or explicitly made
non-applicable by a separately justified product decision), F1 must not delete the pane-marker
fallback unconditionally.
