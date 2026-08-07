# 488 — the path to hybrid D

_The route, not the destination. The destination was ratified in `architecture-fit.md` and the two
adversarial reviews; this document answers **how we get there, in what order, and what dies on the way**._

**Task:** `t-d49ef0` (umbrella). **Author:** `chatpane`, 2026-08-07.
**Measured against:** `main` @ `b234bcd7`, in worktree `tachyon/tmp.chatpane.20260807-172502-7ebf`.
**Status:** plan. No production code was written for it.

## What is already closed and does not reopen here

From the umbrella body, written by the owner:

- **Two processes** — MCP Bridge (engine) + IDE Browser Host (extension host). Do **not** unify.
- **Destination UI: hybrid D** — thin page overlay, Preact webview chrome.
- Owner dogfood passed 2026-08-04: pick → chat → the agent received the selection.

This document takes all three as given. Where it adds anything, it is a measurement of the *route*.

---

## 1. What leaves the injected JS, and what stays

**Confirmed, with a sharpening the reviews did not make.** The line is not "the pick"; it is
**"code that must read or paint in the page's own DOM and coordinate space"**. That set is slightly
larger than the pick and much smaller than the file.

Every line of the injected body (`designModeInject.ts:63-1719`, 1657 lines) attributed:

| lines | % | realm | region |
|---:|---:|---|---|
| 23 | | page | preamble — binding name, `__tachyonDmQueue`, `post`, `isChrome` |
| 20 | | page | `captureEl` — serialize tag/id/class/text/html/bounds/styles |
| 8 | | page | `focusColor` — read one accent for the outline |
| 7 | | page | `clearHover` |
| 31 | | page | `onPageMove` + `onPageClick` — hover outline and `elementFromPoint` hit-test |
| 10 | | page | `onKey` — Esc |
| 20 | | page | `onInternalNavIntent` — link/form intent, so the host can re-inject |
| 21 | | page | `attachListeners` / `detachListeners` |
| **140** | **8.4%** | **page** | **must be in the page** |
| 25 | | chrome | `setNodeHtml` — Trusted Types shim |
| 24 | | chrome | `svgEl` + `h` DOM builders |
| 619 | | chrome | `cssText` (**509** of those lines are inside chrome rule bodies; 13 serve the overlay root) |
| 87 | | chrome | `markup` template |
| 109 | | chrome | `styleEl`, icons, toolbar/chat/card DOM construction |
| 30 | | chrome | `querySelector` handles |
| 236 | | chrome | chat — bubbles, merge, push handler, agent menu, send |
| 136 | | chrome | `mountFloatingPanel` — drag + resize |
| 204 | | chrome | card, responsive presets, picker UI, selection chip, `clearPick`, `showPick`, handlers |
| **1470** | **88.7%** | **chrome** | **moves to the webview** |
| 47 | 2.8% | both | root element, `cleanup`, `finishInstall` + bootstrap |

**Two corrections to how this has been described.**

- `onInternalNavIntent` (20 lines) **is not the pick** and must still stay. It observes clicks and
  submits in the page so the host knows to re-inject. A future reader tidying "everything that is not
  the pick" out of the overlay would delete the mechanism that keeps the overlay alive across a link
  click. Name it in the code: the page realm holds *pick* **and** *page-lifecycle signal*.
- "The pick stays" does **not** imply "`themeTokens.ts` stays". The overlay reads **one** token
  (`--ds-focus`, for the outline). `themeTokens.ts` mints **44** across 363 lines, and the injected
  block currently carries all of them because the chat and the card needed them. See § 4.

**Contested: nothing.** I looked for a reason the chat *must* be in the page and found the opposite —
the page is where it is worst (§ 2).

---

## 2. Where state lives today, where it moves, and what crosses

### 2a. The finding that settles the argument

**Nine of the ten pieces of visible Design Mode UI state are destroyed by any in-page link click, and
the host does not send them back.**

`finishInstall` (`designModeInject.ts:1698`) restores exactly one field —
`setPickMode(RESTORE_PICK)`. `reinstallAfterInternalNav` (`cdpSession.ts:623`) re-injects the script
and re-pushes **nothing**.

| page state (closure) | survives a same-tab navigation? |
|---|---|
| `pickMode` | **yes** — the only one, via `restorePickMode` |
| `chatItems` (the loaded history window) | no — and the host does not re-push it |
| `chatOpen` | no — resets to closed, so the human must reopen to trigger `action:'open'` |
| composer draft text | no |
| `chatWorkingOn` / typing phase | no |
| `agents[]` / `activeAgent` | partly — the page re-posts `agents.list` on install |
| `selected` / `hoverEl` | no |
| `activePreset` | no — the CDP override survives; the page forgets which button was lit |
| panel layout (x/y/w/h, two panels) | no |
| scroll position / `hasMoreBefore` | no |

A webview panel is not in the page. It survives navigation because it is not reloaded by one. That is
the whole architectural argument, and it is a measurement rather than a preference.

### 2b. Host and disk state (unchanged by D)

- **`IdeBrowserBridgeManager`:** `designAgent`, `lastPick`, `chatWait{turnId, agent, sawBusy}`,
  three timers, `pickHandling`.
- **`IdeBrowserCdpSession`:** `designModeOn`, `designPickMode`, `pendingInternalNav`, `lastUrl`.
- **Disk:** `.tachyon/design-mode-chat/chat.jsonl` (append-only, `lineNo`, per-workspace lock, `0o600`)
  — the durable truth; `.tachyon/ide-browser-picks/*.png`; `~/.tachyon/ide-browser-instances/*.json`.

**`chatWait` must not move in this migration.** `t-181925` bound the reply to a minted turn id so a
late or foreign reply cannot clear a newer wait. That binding is host-side and stays host-side; the
webview renders the wait, it does not own it.

### 2c. What crosses the boundary — before and after

**Today, page → host** (CDP binding `tachyonDesignModePick`, JSON strings) — six families:

`pick payload` · `__layout:'pickMode'` · `__layout:'responsive'` · `__layout:'internalNav'` ·
`__layout:'agents'` · `__layout:'chat'` · `__clearSelection`

**Today, host → page** (`Runtime.evaluate` calling `window.__tachyonDmChatPush`, **five-attempt retry
loop** — review finding X1) — eight payload types: `selection`, `agents`, `agent_switch`, `chunk`,
`message`, `system`, `error`, `working`.

**After D, page ↔ host** — two families out, one in:

| direction | message | form |
|---|---|---|
| page → host | the pick payload | unchanged shape |
| page → host | `internalNav` | unchanged |
| host → page | `__tachyonDmSetPickMode(on)` | **new** — the webview owns the toggle, the page obeys |

Everything else becomes **host ↔ webview `postMessage`**: typed at both ends, no retry loop, no
`Runtime.evaluate`, and gated by `SectionPanelManager`'s visibility gate (a hidden panel's push is
dropped and arms a resync on reveal, rather than being fired at a page that may not have the
function yet).

**Honest limit — D does not stop the polling.** With Design Mode on, the host runs a presence watch
every 400 ms and a pick-queue drain every 250 ms: ~6.5 `Runtime.evaluate` per second through the
js-debug proxy, whether or not anyone is doing anything. Both exist for the *pick*, so both survive D.
What D removes is the chat push traffic (1–5 evaluates per pushed event). Anyone selling D as "fewer
CDP round trips" should quote that number and not a larger one.

**One probe must change or D breaks re-inject.** The presence watch and the re-inject success check
both test for `#tachyon-dm-picker` (`cdpSession.ts:658-700`) — the **toolbar button**, which D
deletes. Left alone they will report the overlay missing forever and re-inject in a loop. They must
test the overlay root instead. This is the single highest-risk line in the migration and it is not
mentioned in either review.

---

## 3. Order of the eleven children

### 3a. Premise check first — three task bodies are stale

Project guidance: a written task is not an accepted task. Verified at the point of use, 2026-08-07:

| task | body claims | measured now |
|---|---|---|
| `t-47503a` | split manager, type the protocol, "optional extract `registerIdeBrowserTools` from `tools.ts`" | **partly done** — `src/bridge/tools/ide-browser.ts` exists (210 lines) and `tools.ts` contains **zero** `ide_browser` occurrences. Manager (1104 lines) and the generic `protocol.ts` envelope are untouched. **Re-scope before executing.** |
| `t-45b266` (F1) | "After runtime matrix (F3) is green" — delete markers | F3 landed (`t-dd46a4`), but `parity.md` row 19 states in writing that **panel land is unmeasured** and that tool-call green "does **not** imply F1 may delete markers without a land dogfood". **The premise is not met.** |
| `t-83723d` | `dogfoodBootstrap.ts` has zero importers | **holds** — zero importers outside itself; no coupling to the inject. Safe to move at any time. |

Two smaller residues found while measuring, neither worth its own task:
`manager.ts:180` still handles `__cancel`, which no page code posts any more (dead branch — delete it
inside slice 1); and `t-2b948e` currently carries **no** dependency while its twin `t-64edaf` carries
one, which is the half-undone edit the umbrella journal already mentions.

### 3b. `t-2b948e` and `t-64edaf` are one task, not two

Both say the same sentence: chrome off the string inject, page keeps a thin picker, done when
pick → chat → `design_mode_chat_reply` still works. `t-2b948e`'s own body says "may be folded into
this or vice-versa; one shippable outcome", and grok's inventory says "fold/pair".

**Recommendation:** execute `t-64edaf`; **drop `t-2b948e` as a duplicate**, quoting `t-64edaf`. Two
open tasks for one outcome is how a slice ends up half-done by two people.

### 3c. The order

**Lane A — independent of the UI, runnable now, in parallel with anything.**

| task | why it is free | slice check |
|---|---|---|
| `t-83723d` move `dogfoodBootstrap` | pure move, zero importers, no inject coupling | deliverable alone; nothing breaks if it never happens except reader confusion |
| `t-a7d951` document the residual no-CAS send race | docs only; `parity.md` already documents no-CAS for `notify_agent` but never names Design Mode | deliverable alone |
| `t-464e2d` (F9) instance discovery arbitration | touches `client.ts` + the instance file, never the UI | deliverable alone; **note codex called this "v1, not F9"** — it is a correctness item wearing a follow-up's number |

**Lane B — the spine. Everything visual waits behind it.**

**B1 — `t-64edaf` part one: build the app, do not wire it.**
New `src/webview/design-mode/` (Preact app + protocol) and its `SectionPanelManager` host, rendered
**only** from a preview fixture. Not contributed as a command, not reachable from the product — the
same posture `section-app-fixture` already has and the same reason.
*Verifiable alone:* preview screenshots at 880 and 360, executable component tests.
*Leaves no second live implementation, because it is not live.*

**B2 — `t-64edaf` part two: cut over, atomically.**
Manager pushes to the webview instead of the page; webview actions drive the manager; the inject drops
to pick-only; the chrome is **deleted**; the presence/re-inject probes stop looking for
`#tachyon-dm-picker`; `designModeInject.test.ts` flips from asserting chrome present to asserting it
absent.
*Verifiable alone:* dogfood pick → chat → `design_mode_chat_reply` with no injected chat UI.
**This slice cannot be left half-done** — see § 4 for why that is enforced rather than requested.

**Lane C — after B2, and only after.**

| task | why it must wait |
|---|---|
| `t-7f994f` (F8) visual evidence pack | screenshots of a UI that B2 deletes are worth nothing. Capture the new one. |
| `t-45b266` (F1) delete markers | its real gate is a **panel-land dogfood**, and after B2 the panel is a different program. Measuring land on the surface about to be deleted is a measurement of nothing. |
| `t-47503a` split manager + typed protocol (re-scoped) | B2 rewrites the manager's whole UI-push surface. Splitting first means splitting a file that is about to change shape, then splitting again. |
| `t-3ef9ea` engine `DesignModeService` | the largest authority change; wants the manager already split. Also see decision **D4** — it may not be wanted at all. |

**Lane D — leave the umbrella.**

| task | recommendation |
|---|---|
| `t-9d3919` (F5) pick → structured edit | **its own SDD.** Its body already says "prefer later SDD when starting". It is a new product (patch proposals, undo), not a merge-review follow-up. Keeping it here guarantees the umbrella never closes. `editquality` is measuring it now and has the constraint in `t-9d3919` journal `j-acdc23532fa6`. |
| `t-a394e3` (F2) multi-agent group thread | **its own design task or SDD**, as its own body asks. It is product rules, not architecture follow-up. It gets *cheaper* to build once the chrome is a Preact app — which is exactly why the rule must exist before anyone can. |
| `t-26232e` (F7) cookbook | **keep, gate on GA posture** (decision **D7**). A cookbook for an opt-in developer feature has no operator audience yet. |
| `t-2b948e` | **drop as duplicate of `t-64edaf`** (§ 3b). |

### 3d. What breaks if work stops midway

| stopped after | state of the product |
|---|---|
| any Lane A task | fine — each is independent and complete |
| **B1** | fine — a dev-only app exists and nothing in the product changed |
| **inside B2** | **the failure mode this plan exists to prevent.** Two chat implementations, one in the page and one in a webview, both fed by the same manager. Mitigated structurally, not by discipline: see § 4 |
| **B2** | better than today, and coherent. Lane C is genuinely optional from here |
| any Lane C task | fine — each is independent of the others |

---

## 4. What dies

The brief names the trap precisely: a migration that only adds leaves two implementations alive, and
this repository has paid for it — `t-41117e` existed because the Fleet app and the sidebar list were
two owners of one VM, and the more visible one rendered 2 of 9 states.

**The kill list is part of slice B2, in the same commit as the addition.**

| dies | size | note |
|---|---:|---|
| chrome inside `designModeInject.ts` | **1470 lines** | toolbar, chat, card, agent menu, drag/resize, 509 CSS lines |
| `cdpSession.pushDesignModeChat` + its 5-attempt retry loop | 21 lines | this is review finding **X1**: "a retry loop is a handshake nobody could write" |
| `window.__tachyonDmChatPush` | the global | the entire host→page push channel |
| `__layout: 'chat' \| 'agents' \| 'responsive' \| 'pickMode'` | 4 of 6 page→host families | plus the dead `__cancel` branch at `manager.ts:180` |
| `setNodeHtml` Trusted Types shim, `svgEl`, `h` | 49 lines | no chrome HTML in the page ⇒ no Trusted Types policy to negotiate |
| `mountFloatingPanel` | 136 lines | a webview panel is an editor tab; VS Code already does splitting and resizing |
| most of `themeTokens.ts` | 44 minted tokens → ~1 needed | the three-step no-flash warm (`seedDmThemeTokensFromKind`, `warmDmThemeTokensInBackground`, `invalidateDmThemeTokenCache`, and the `onDidChangeActiveColorTheme` re-warm in `register.ts:196-204`) exists **only** because the chat and card lived in a page with no `--vscode-*`. Retire it to a tiny overlay palette. Deleting it entirely is wrong — the outline still needs one accent |
| the string-grep test suite | 30+ assertions | review finding **S2**. `designModeInject.test.ts` must flip to negative assertions, and behaviour moves to executable component tests |

### How "it actually died" is enforced

Prose does not hold this; the file grew to 1720 lines under prose. Three mechanisms, all inside B2:

1. **`designModeInject.test.ts` inverts.** Today it asserts `tachyon-dm-toolbar`,
   `tachyon-dm-chat`, `__tachyonDmChatPush`, `mountFloatingPanel` and `data-preset` are **present**.
   After B2 it asserts each is **absent**. A surviving second implementation fails the suite; it
   cannot be forgotten, because the same file has to be edited either way.
2. **A line ceiling on the generated expression** (a few hundred), with the reason written beside it.
   Note this is *not* the size-budget test `t-2b948e` rejected: that one was proposed as a
   *reminder to migrate*, and the board task was the better reminder. This one is a *post-migration
   ratchet* on a boundary that has already been drawn.
3. **No flag, no fallback, no setting.** The cutover ships one implementation. A toggle that keeps the
   inject chrome reachable "just in case" is the two-owners defect with a config key on it.

**Watch the fail-first.** Guidance in this repo has been paid for twice here: `0.56.159` shipped green
tests against one entry point while five call sites bypassed it, and a static guard written to catch
exactly that was itself blind until someone watched it fail. Flip each negative assertion **before**
deleting the chrome and confirm it goes red.

---

## 5. Decisions the agent must not take alone

Each has a recommendation. None should be resolved by whoever picks up the slice.

| # | decision | why it is not the agent's | recommendation |
|---|---|---|---|
| **D1** | **Where the Design Mode webview lives** — an editor panel beside the browser tab, or a sidebar view? And one panel per window, per project, or per identity? | Product shape of the shared-viewport workflow. Codex explicitly left it open ("sidebar view or a dedicated adjacent document app depending on the validated workflow", AR-11) | Editor panel opened **beside** the browser tab, cardinality `window` (one panel, no project key). The IDE Browser host is already a per-window singleton keyed on `workspaceFolders[0]`, and a 340 px sidebar is a poor home for a conversation you read while looking at the page. Cheap to revisit — cardinality is one row in `webviewApps.ts` |
| **D2** | **Does the chat panel outlive Design Mode being off?** Today the chat dies with the overlay because it *is* the overlay. A webview does not have to. | Product behaviour the human will feel every session | **Yes, it outlives it.** The conversation is durable (`chat.jsonl`); turning Design Mode off should disarm the pick, not end the conversation. This is a genuine behaviour change and should be stated, not slipped in |
| **D3** | **F1 — delete pane markers, or keep a documented emergency fallback?** | Product risk: the fallback is what saves a runtime that cannot call the tool | **Delete, but only after a panel-land dogfood on the new webview.** `parity.md` row 19 already refuses to let tool-call-green stand in for this |
| **D4** | **Does chat/turn authority move to the engine (`t-3ef9ea`)?** | Authority boundary between the two processes — the one axis the owner has already reserved | **Defer, and re-ask after B2.** Nothing measured says the shell owning `chat.jsonl` hurts today. This is the one child that may honourably die unbuilt |
| **D5** | **Multi-agent group thread (F2)** | Pure product rules — who answers, `@`-routing, concurrent speakers | Keep it out of every D slice. Write the rules first, in its own task |
| **D6** | **Does `src/webview/ide-browser-bridge/` get renamed?** Both reviews call the location misleading (`AR-06`, artifact map) | ~10 files of churn and a merge-collision cost that depends on what else is in flight | **After B2, as its own slice.** B2 adds the first thing under `src/webview/` here that genuinely *is* a webview, which changes what the remaining directory should be called |
| **D7** | **GA posture** — is Design Mode still experimental/opt-in? | Open question Q1 in `spec.md`; drives whether F7's cookbook has an audience | Stay opt-in through B2. Revisit with F8's evidence pack in hand |

---

## Scope note

Everything above is planning. **No production code was written for this task.** No throwaway prototype
was needed either: every number here comes from reading the tree at `b234bcd7` and attributing lines,
so there is nothing to discard and nothing pretending to be a prototype.

## Sources

- `review-architecture-claude.md` (A1–A4, S1–S4, L1–L3, X1) and `review-architecture-codex.md`
  (AR-01–AR-15) — the destination and its findings
- `architecture-fit.md` — two hosts, three paths, and the contracts already in the tree
- `docs/runtimes/parity.md` row 19 + § 3.1.3 — the F3 matrix, and the sentence that keeps F1 shut
- `t-d49ef0` journal `j-4ffbc2576367` (grok's inventory) and `j-63b88a84005a` (the dependency measurement)
- The tree itself: `designModeInject.ts`, `cdpSession.ts`, `manager.ts`, `designModeChat.ts`,
  `themeTokens.ts`, `register.ts`, `src/bridge/tools/ide-browser.ts`, `src/ide-browser/protocol.ts`
