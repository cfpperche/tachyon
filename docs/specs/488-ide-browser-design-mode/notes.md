# 488 — ide-browser-design-mode — notes

_Created 2026-08-04._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- **2026-08-04 pragmatic productize (post adversarial review)** — Do not block dogfood on SpaceX-grade
  security. Shipped on branch: (1) chat prompt is **tool-only** (no pane marker instructions);
  (2) IDE browser start/stop **does not** call `forceToolListRefresh` (avoids killing live MCP
  sessions; tools already always-register); (3) UI is **single-agent** copy + selector lists
  **running** agents only. Marker extract kept as dead-code unwrap for legacy tool payloads only.
- **2026-08-04 unified agent channel** — Selection card is **inspect-only** (no note, no “Send to
  agent”). Pick attaches `lastPick` + chat chip; **only** chat Send calls `sendAgentInput` via
  `formatDmChatPrompt({ pickContext })`. After a successful send, attach is consumed.
- **Two bridges are intentional** — Operator confusion (“is this the Tachyon bridge?”) is expected.
  Answer for docs: MCP = Tachyon Bridge; IDE Browser Bridge = shell only. Agents never connect to
  the shell HTTP API directly.
- **Always-register over live-gate** — Gating `registerTools` on `isIdeBrowserBridgeAvailable()` at
  MCP session create caused agents spawned before browser-up (or with dead instance PID) to miss
  `design_mode_chat_reply` for the life of the session. Companion already taught the better pattern:
  list tools, fail closed at call time. Changed on `tachyon/grok` before this SDD was scaffolded.
- **`bridge.refresh-tools`** — op exists for catalog flips; **not** called on IDE browser start/stop
  (always-register makes that refresh destructive and unnecessary).
- **Chat history = workspace JSONL** — One file per workspace
  (`.tachyon/design-mode-chat/chat.jsonl`). Prompts pass the path + instruction, not the full
  transcript, to avoid context bloat and “WhatsApp dump” noise.
- **Single active agent for sends** — v1 routes each send to one running agent. Multi-agent F2.
- **Markers are not the product** — tool-only happy path; marker extract is legacy unwrap only.
- **Two-bridge rewrite deferred** — Review of merge should discuss fit (`architecture-fit.md`); rewrite
  is not a merge gate. Recommended land: keep two bridges (Companion pattern).
- **Merge gate** — Branch prepared for review; maintainer merge to `main` is F10 (not auto).

## Dogfood log

### 2026-08-04 — human (maintainer) Design Mode unified channel

- **Scenario:** pick element → chat with attached selection → agent receives selection context.
- **Result:** **PASS** — agent received the selected element (unified chat channel).
- **Runtime:** in-session dogfood on Extension Development Host.
- **Notes:** Theme surface tokens for picker blocks landed same day; reply-tool reliability still
  runtime-dependent (Codex may list tool and not call it — F3).

## Merge-review readiness

- Branch `tachyon/grok` prepared for main merge **review** (no auto-merge).
- Maintainer commissioned **architecture adversarial review** (not security): brief
  `adversarial-review-architecture-brief.md` → dispatch to **claude** + **codex**.
- Deliverables: `review-architecture-claude.md`, `review-architecture-codex.md`.

## Board tasks (2026-08-04)

Registered after architecture reviews (author: human; deps → umbrella).  
Triaged 2026-08-04 (priority 0 = highest).

| id | title | lane |
|---|---|---|
| `t-d49ef0` | **Umbrella** — SDD 488 Design Mode merge review follow-ups | triaged P1 |
| `t-4d2892` | honest architecture memo — three paths + Companion claim | **done** (architecture-fit.md rewritten) |
| `t-348c9a` | inject size budget + Design Mode draft-clobber check | triaged P1 |
| `t-7aef5a` | disambiguate `ide_browser_*` vs `user_browser_*` tool descriptions | triaged P2 |
| `t-83723d` | move dogfoodBootstrap out of production shell path | triaged P2 |
| `t-08f08e` | retire or isolate ide-browser-proto stream prototype | triaged P2 |
| `t-64edaf` | hybrid D step 1 — chat/card to Preact webview | triaged P1 |
| `t-47503a` | split IdeBrowserBridgeManager + type engine↔host protocol | triaged P2 |
| `t-3ef9ea` | thin shell — engine DesignModeService for turns/chat | triaged P3 |

## Prototype inventory (as of 2026-08-04, branch `tachyon/grok`)

Present in code (exploratory / dogfood quality — not a ship claim):

| Piece | Location | Notes |
|---|---|---|
| HTTP+CDP manager | `src/webview/ide-browser-bridge/manager.ts` | start/stop, instance file, chat HTTP, attention poll |
| Inject UI | `designModeInject.ts` | toolbar, chat panel, Trusted Types constraints |
| Chat store | `designModeChat.ts` | JSONL, prompt format, marker extract |
| Engine client | `src/ide-browser/client.ts` | discover, sweep dead PIDs, request |
| MCP tools | `src/bridge/tools.ts` | `ide_browser_*`, `design_mode_chat_reply` |
| Status bar cluster | `register.ts` | adjacent priorities, shared name |
| Fixture | `test/fixtures/ide-browser-dogfood/` | clean roster intended for human create flow |
| Token heal (related) | `src/bridge/agentTokenHeal.ts`, caller identity | dogfood 401 path; not Design Mode core but same branch |

## Deviations

- Spec drafted **after** substantial prototype (reverse of pure SDD “intent first”). Acceptable for
  exploratory track; this document freezes product boundaries so further code does not sprawl.
- Codex dogfood showed tools **listed** while the model claimed they were unavailable and used
  markers — product risk is not only registration, but **runtime compliance**. F3 tracks matrix;
  prompt hardening is P1.

## Tradeoffs

- **Always listing offline tools** may slightly pollute tool lists when browser never used —
  accepted vs silent missing tool (worse UX and harder support).
- **forceToolListRefresh closes MCP sessions** — brief reconnect cost vs stale catalog; same as
  companion `tabTools` toggle.
- **Group-chat UI aesthetics without group orchestration** — may set wrong user expectations;
  mitigate with copy (“active agent: X”) until F2.

## Dogfood observations (2026-08-04)

- Instance file for fixture workspace could exist with **dead PID** → availability false after sweep.
- Codex tool dump included `design_mode_chat_reply` yet model used fallback markers; Design Mode
  panel showed system: finished turn without chat reply.
- Chat hydrate / dropdown positioning / scrollbar / “and” marker false positive were fixed in
  prototype iteration; keep regression tests where cheap.
- Status bar long dual labels looked like separate products; cluster pattern preferred.

## Open questions

_See also `spec.md` Q1–Q5._

- Does Extension Development Host always share the same operator `homedir` for instance files when
  runtimes rewrite `$HOME`? Client uses `operatorHomedir()` / passwd home — re-verify if private
  runtime homes regress discovery.
- Should `bridge.refresh-tools` be general-purpose (settings flips) or IDE-browser-only naming?
  Currently general; fine.

## Verification log

_None yet under this SDD id. Related unit tests pass on branch as of scaffold day:_

- `npx vitest run test/unit/designModeChat.test.ts test/unit/ideBrowserClient.test.ts` — pass (2026-08-04)

## Ratify log

- 2026-08-04 — Product lean agreed in conversation: Design Mode viable as Tachyon product slice;
  v1 = reliable single-agent visual loop; document follows; **no merge to main** until explicit.
  Formal maintainer checkbox ratify of Q1–Q5 still open.
