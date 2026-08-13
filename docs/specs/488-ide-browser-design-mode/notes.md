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
| `t-348c9a` | Design Mode draft-clobber refuse | **done** — `agent.input` + `probeComposerOccupied`; no source-size budget test (reminder = migration task) |
| `t-7aef5a` | disambiguate `ide_browser_*` vs `user_browser_*` tool descriptions | **done** — IDE_BROWSER_SCOPE / USER_BROWSER_SCOPE prefixes |
| `t-2b948e` | **migrate Design Mode chrome off string inject → Preact app** | **triaged P1** — product reminder (not a CI size guard) |
| `t-83723d` | move dogfoodBootstrap out of production shell path | triaged P2 |
| `t-08f08e` | retire or isolate ide-browser-proto stream prototype | triaged P2 |
| `t-64edaf` | hybrid D step 1 — chat/card to Preact webview | triaged P1 — fold into / pair with `t-2b948e` |
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

## F3 runtime matrix (`t-dd46a4`, 2026-08-06)

Living dogfood for `design_mode_chat_reply` tool-call reliability (blocks confident F1).

| Runtime | Binary | Listed | Called | turnId in args | Markers | Panel land |
|---------|--------|:------:|:------:|:--------------:|:-------:|:----------:|
| Claude | 2.1.223 | ✓ | ✓ | ✗ (`text` only) | ✗ | **?** IDE browser offline |
| Codex | 0.146.0 | ✓ | ✓ | ✓ | ✗ | **?** offline |
| Grok | 0.2.118 | ✓ | ✓ | ✓ (1st call) | ✗ | **?** offline |
| Pi | — | **?** unmeasured | **?** | **?** | **?** | **?** |

- **How:** headless CLI runs (no spawn_agent) with `formatDmChatPrompt`-shaped prompt including
  `Turn id: dm-turn-f3matrix01` and required tool call. Evidence under
  `docs/research/evidence-t-dd46a4-f3/`; narrative
  `docs/research/design-mode-chat-reply-runtime-matrix-t-dd46a4.md`; parity §3.1.3 / row 19.
- **Historical Codex “listed, used markers”** (2026-08-04 notes above) did **not** reproduce on
  0.146.0 under the current tool-only prompt.
- **F1 verdict:** tool-compliance green for claude/codex/grok → F1 no longer blocked by “Codex
  won’t call the tool.” Marker deletion still needs a live panel dogfood (IDE Browser Bridge up)
  before removing `extractDmChatReplyMarkers`. Do not do F1 from this task.
- **Live schema gap:** running Bridge `tools/list` omitted `turnId` despite 0.62.0 source; engine
  process was long-lived. Re-check after engine reload when dogfooding panel land.

## F8 Visual QA evidence pack (`t-7f994f`, 2026-08-12)

- **How:** `TACHYON_ENGINE_CHANNEL=dev npm run build` → `scripts/dev-host/cli.sh point --fixture ide-browser-dogfood` → `node scripts/dev-host/headless-session.mjs up` (Xvfb `:97` + CDP) → commands `Tachyon: Open IDE Browser` / `Tachyon: Design Mode On` → pick via in-page click with picker armed → reply via real host `POST /design-mode/chat-reply` (same door as MCP tool).
- **Artifacts:** `evidence/design-mode-toolbar.png`, `pick-attach.png`, `chat-reply.png`, `status-bar-cluster.png` (~510 KiB total).
- **Post t-47503a:** inject UI + status bar cluster still paint after manager/hostServer/browserSession split; no regression visible in chrome layout.
- **Defect noted:** Selection card covers Design Mode chat transcript when both open (reply present in DOM, not visible until card closed). Filed as separate bug task; not fixed in F8.
- **visual-qa skill:** not used for capture path (web-only skill; this surface is EDH + CDP inject). Judgment still recorded under Visual QA Evidence/Verdict for `/sdd close`.

## t-330a51 — Selection card vs chat transcript (`2026-08-12`)

- **Defect (measured, not guessed):** both defaults share the right edge. Card `top:16px; right:16px; 360×min(70vh,560)`. Chat `right:12px; bottom:40px; 360×min(420,100vh-56)`. Vertical overlap whenever viewport **height < ~1036px** — every typical EDH editor-browser, not a small-viewport-only bug. Fail-before at 880×660: card covered the landed agent bubble (`elementFromPoint` hit `#tachyon-dm-card`).
- **Fix:** `data-both-open` on the inject root when both panels are open. Undragged card parks just left of the chat slot (`right: min(12 + chatWidth + 8, clamp-on-screen)`). Chat z-index stays above the card. User drag/resize still writes inline `left/top` via `mountFloatingPanel` and wins.
- **Threshold after the fix:** side-by-side with no geometric overlap at viewport **width ≥ 748px**. Below that the card is clamped on-screen and the panels still intersect; stack order keeps the transcript hit-testable. 360×660 is that fallback (chat on top, reply readable).
- **Evidence:** `evidence/t-330a51-before.png` / `t-330a51-after.png` (880×660, same page, both panels open). 360 pair: `t-330a51-before-360.png` / `t-330a51-after-360.png`.
- **Not done:** did not merge the two surfaces; did not touch `manager.ts` or delivery.

## t-1c8195 — what ends the CDP child and leaves inject painted (`2026-08-12`)

Actor × trigger matrix, measured before any reconnect/cleanup work.

**Owner incident (VS Code 1.117, exthost3 PID 1125100, same host 12:20–14:32):**
`/home/goat/.vscode-server/data/logs/20260812T094001/exthost3/output_logging_20260812T122021/3-Tachyon IDE Browser.log`.
Three launches, three child deaths. Two while Design Mode was on (`reattach Target.* failed (Connection is closed)` then `debug session ended (tab closed?)`). One immediately after `opened about:blank` with DM off. Same shape in exthost1 and exthost6. Host HTTP stayed up; page on globo.com still showed painted card/chat (`t-a4060b`).

**Discarded as this incident's trigger:**
- Extension / VSIX reload — deaths are intra-host; PID 1125100 only later exited at 14:32 (`received terminate message from renderer`).
- Our `resetBrowserSession` / `manager.stop` — that path `dispose()`s CDP first, so the terminate handler would not log. Owner's line requires `cdp.session` still set.
- Presence-watch as a required cause — death also happens with Design Mode off (no reattach).
- Tab close, toolbar Stop, and Disconnect **on EDH 1.128** — all three end child then parent and **destroy the page**. No orphan. Signatures are indistinguishable at the terminate event (`active` is still the dying session; VS Code has not updated `activeDebugSession` yet).
- Idle Design Mode, `example.com`, address-bar nav to `example.org`, globo.com homepage for 30s, article-link click — child stayed `cdp=connected` on 1.128.

**Measured live (EDH 1.128, fixture `ide-browser-dogfood`, Xvfb `:97`):**
- Opening the browser creates parent + CDP child (`pwa-editor-browser`). Child is `activeDebugSession` and draws the floating debug toolbar (`t-414540`).
- globo.com then spawns a **forest** of further `pwa-editor-browser` sessions (ads, blobs, safeframes) as children/grandchildren of our CDP child. Input for `t-849f52` (first-child-with-parent adoption); not implemented here.
- 1.128 couples the editor tab to the debug family: Stop and Ctrl+W both teardown parent+child and drop the frame. The owner's 1.117 orphan (child dead, globo.com tab still painted) was **not reproducible** on 1.128.
- Once CDP is gone we cannot remove inject. Auto-reconnect is not implemented (duplicate-chrome risk). Remaining choice: a page-side heartbeat that self-removes chrome when the host stops answering — propose, do not build until OK.

**Product change in this pass:** classify terminate (`controller-reset` vs `external` / `child-ended-*` / `parent-ended`), log session start family, and after 150ms log `child ended and parent survived` when only the child died (the orphan discriminator). No auto-reattach. `manager.ts` untouched.

**Evidence:** `evidence/t-1c8195-design-on.png`, `t-1c8195-after-stop.png`, `t-1c8195-globo-forest.png`, `t-1c8195-after-tab-close.png`.

## Ratify log

- 2026-08-04 — Product lean agreed in conversation: Design Mode viable as Tachyon product slice;
  v1 = reliable single-agent visual loop; document follows; **no merge to main** until explicit.
  Formal maintainer checkbox ratify of Q1–Q5 still open.

## Hybrid D step 1 visual anchor (`t-64edaf`, written before implementation)

At both **880 px** and **360 px**, the Design Mode editor panel should read as quiet VS Code chrome
beside the shared page: the active running agent and picker state are immediately legible; the attached
selection is a compact inspector/context card rather than a second conversation; the transcript remains
the primary reading surface; and the composer/send action remains reachable without horizontal scrolling,
clipping, or overlap. At 360 px the same information stacks in one column without shrinking controls or
hiding selection state. The surface must use the existing Tachyon design-system tokens and must not mimic
or inject page styling. Turning Design Mode off disarms page picking but does not erase or close the durable
conversation panel.

### Hybrid D step 1 result

- **Evidence:** `docs/specs/488-ide-browser-design-mode/evidence/t-64edaf-design-mode-880.png`
  and `docs/specs/488-ide-browser-design-mode/evidence/t-64edaf-design-mode-360.png`, captured from
  the shipped Preact bundle through the repository preview harness.
- **Verdict:** pass after one correction round. The first capture exposed undefined spacing/surface
  token names and an unhydrated transcript; the final captures use only existing `--ds-*`/VS Code
  tokens and shared control classes. At 360 px, agent controls, selection, transcript, and composer
  stack without horizontal clipping or panel overlap.
- **Page-realm exception:** `internalNav` remains beside pick because the page must observe same-tab
  link/form intent so the host can re-inject the picker after navigation. No chat, inspector, agent
  menu, responsive control, Trusted Types chrome, or selection-clear UI remains in the page inject.
- **F6 eval doors:** host chat push (`window.__tachyonDmChatPush(payload)`) is retired; it is now a
  typed host→webview `postMessage`. HTTP/MCP eval, encoded click, the thin inject/re-inject, and the
  pick presence/queue probes remain necessary and unchanged in authority. The page binding remains,
  but accepts only pick payloads and `internalNav`, so page script can no longer forge `chat.send`.
- **Live dogfood attempt:** the checkout-local headless EDH opened the Integrated Browser, but enabling
  Design Mode failed before inject with `Timed out waiting for editor-browser child debug session (CDP)`.
  The session and pointer were cleared. This run therefore does not attest pick→chat→reply; the focused
  production-path tests and preview evidence are green, but live dogfood remains the exact next action.
