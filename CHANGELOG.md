# Changelog

All notable changes to Tachyon are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). Older history lives in the git log and the
Marketplace release notes.

## Unreleased

## 0.87.0 — Design Mode's chat leaves your page, and answers through one door

The Design Mode chat used to run inside the live document of the site you were inspecting. It does
not any more: the page keeps the element picker and nothing else, while chat and the selection
inspector became an editor tab. The reply path lost its fallback in the same release, so there is now
exactly one way an agent answers.

### Changed

- **Chat and the selection inspector are a Preact webview, not page-injected UI** (`t-64edaf`,
  SDD 488 hybrid D step 1). The injected script went from **1765 lines to 30** and now does pick only.
  The panel opens as an editor tab beside the browser, so you click an element on the left and talk
  about it on the right. Of the six `eval` doors the F6 security review mapped, the chat-push door
  became unnecessary and was removed; five remain, and they are named in the task.
- **`design_mode_chat_reply` is the only reply path** (`t-45b266`, SDD 488 F1). The pane-marker
  fallback — the agent writing START/END into its terminal for Tachyon to scrape off the screen — is
  gone from prompts, extractors, tests and docs. This was blocked for eight days on a distinction
  worth keeping: a headless test proves the tool was CALLED, not that the answer ARRIVED in the panel.
  Deleting the fallback on the first half alone could have left Design Mode with no working voice at
  all, and a green suite would not have noticed. The live half was measured first (`t-727d9c`):
  Claude, Codex and Grok each resolved a host-minted pending turn through the production door, with
  turn ids recorded in `docs/runtimes/parity.md`. Pi, OpenCode and Hermes were measured too and are
  green; Gemini and Qwen declare `bridge: null` and cannot call tools at all, which is recorded rather
  than worked around.
- **"Save to tachyon.yml" is now "Save as terminal declaration", and it stops appearing where it can
  only fail** (`t-7b7701`). The action was offered on every ad-hoc row including forks, while the door
  underneath refuses anything that is not a terminal — a button that failed 100% of the time on a
  fork. It also named the wrong file: the writer moved to `.tachyon/terminals/<name>.yml` and three of
  its four strings still said `tachyon.yml`. The refusal now tells you what to do instead — create a
  Saved Agent in Agent Studio — and says plainly that the fork's session is not adopted.

## 0.86.1 — the IDE Browser could not open in 0.86.0

Hotfix, and it also carried three changes that landed before it.

Design Mode and the Integrated Browser were dead on arrival in 0.86.0: opening the browser timed out
after 20 seconds with `Timed out waiting for editor-browser child debug session (CDP)`.

### Changed

- **SDD 496 is closed: agent and terminal no longer share a box at any level** (`t-34cae5` and the four
  slices before it). Terminal Studio owns its own validator and serializer, and `StudioKind` lost the
  `"agent"` member. Twelve branches of the shared form were removed, each with a written reason for
  why it had existed — caller count answers "who calls this?", never "why does this exist?".

### Fixed

- **IDE Browser attaches CDP again** (`t-54b9c3`). 0.86.0 replaced name matching on the debug session
  (`name.includes("Tachyon")`, which could cross-stop another manager's session) with a private launch
  id plus a type check — the right idea with the wrong type string. The launch config declares
  `type: "editor-browser"`, the debug contributor's name; VS Code resolves that to the
  `pwa-editor-browser` adapter, so the equality never held. The parent session was therefore never
  recognized, the CDP-bearing child was never matched to it, and every open timed out. The check now
  reuses `isBrowserDebugSession`, which already listed `pwa-editor-browser` first among the four types
  it accepts, and keeps the launch id beside it so the cross-manager protection the original change
  existed for is unchanged. No test exercises a real debug adapter, which is why a green suite shipped
  it; the new test hits the extracted predicate directly and that limit is stated rather than papered
  over.

### Internal

- **The gate stopped being a coin flip** (`t-f71795`). `tmuxReap.test.ts` failed 5 times in 10 runs on
  a clean tree. It reproduces a race on purpose — kill a tmux server, catch the forked child still
  alive — and it guarded that race once with a retry, then re-asserted the same fact three lines later
  without one. Measuring liveness through `/proc/<pid>/stat` rather than directory existence also
  stopped a zombie from counting as alive, so the test got stricter, not looser.
- **The `processLock` dual-holder test moved out of the standard gate** (`t-9c01e5`). The residue it
  provokes is real, was measured on 2026-08-05 (zero dual holders in 120 orphan recoveries; roughly
  1 in 750 SIGKILLs under pathological stress) and was deliberately accepted then, with a revisit
  trigger written down: a sustained rate in the field, not a red in a loaded gate. An accepted residue
  with a provoking test in the standard gate turns every run into a coin flip. The scenario still
  lives in `scripts/spikes/`, and the note left in its place carries the measurement, the trigger and
  the exact commands, so nobody returns it to the gate thinking it was forgotten.

## 0.86.0 — installing a plugin stops arming it, and secrets stop travelling with config

The theme of this release is **the product no longer claims a state it does not sustain**. Installing
a plugin used to materialize its skills, hooks, MCP servers and git hooks in one step; now install
records and an explicit apply arms. A cloned agent used to carry its parent's credentials. Three
surfaces promised write isolation that no runtime delivers. Each of those was a written promise the
code did not keep, and each is now either kept or withdrawn in writing.

### Added

- **Explicit apply/unapply for every plugin contribution** (`t-f30f34`, `t-7f52f6`, `t-e85e0e`,
  SDD 486). Install records the payload and the exact removal identity, and materializes nothing.
  Applying is a separate, per-contribution decision, and the Plugins app models "installed, not
  applied" as its own state with a restart notice for an armed hook. This matters most for the two
  loudest kinds: an MCP server is a set of tools the agent can call, and a git hook runs on every
  commit for everyone. Unapply removes only what Tachyon wrote — human-authored content in the same
  file survives, which is covered by a dedicated test rather than a promise.
- **Attention reads native stop hooks on the runtimes that have them** (`t-6b3a0d`, `t-3fd30a`).
  Claude `Stop`, Codex `stopped` and Grok `Stop` now move attention state through the same managed
  lifecycle channel the persistence recorder already uses — deliberately not a second Stop hook,
  because on Codex a second `-c hooks.Stop=` silently replaces the first. Screen reading stays as
  the fallback: a wedged agent emits no `Stop`, and lifecycle still wins over any published status.
  Six runtimes were measured; the three without a Tachyon-managed channel were left out rather than
  fitted with a copy of Claude's shape.
- **Retry-safe Bridge delivery** (`t-3cccef`). `notify_agent` accepts an optional `deliveryId`
  minted before the first attempt; a retry consults the durable record, answers `already-accepted`
  and does not deliver twice. Reusing an id with different content is refused, so the id cannot
  smuggle a new message under an old receipt. Measured after two `notify_agent` calls were lost and
  an `update_task` executed but lost only its response — indistinguishable from the caller's side,
  which is why both reactions were to repeat.

### Changed

- **Secrets no longer live in the same box as configuration** (`t-2ec981`). `environment.secrets` is
  its own shape, separate from `environment.values`, and cloning an agent no longer carries the
  parent's credentials along with its settings.
- **Terminals are declaration files, not a block in `tachyon.yml`** (`t-bc8eed`, SDD 496).
  A terminal now lives at `.tachyon/terminals/<name>.yml`, mirroring the layout agents already used.
  A legacy `terminals:` block still loads, with a warning naming the new location — it warns, it
  never refuses. Fifteen fixture workspaces were migrated in the same commit.
- **The IDE Browser applies one navigation policy, not two** (`t-c294e8`, `t-427fae`). The agent's
  `navigate` now follows the same scheme policy as the configured home URL, but reports a refusal by
  name instead of silently landing on `about:blank` — asking for `about:blank` and falling back to it
  are no longer the same answer. The HTTP `/eval` route inherits the 50,000-character ceiling the MCP
  tool already had, from one shared constant.
- **At most three pending schedule proposals per agent** (`t-e5ecec`), matching the ceiling its
  sibling surface already enforced.

### Fixed

- **`dev-host point` refuses to rematerialize the mirror under a live Dev Host window** (`t-7ee246`).
  Measured with real state loss: an EDH was open with agents created through Agent Studio, `point`
  rewrote the disposable workspace, and a live process was left writing to a file already marked
  `(deleted)`. `point` was already fail-closed for a headless session and destructive for a human
  window. The liveness signal is the owning VS Code/Electron process carrying this pointer's exact
  workspace and extension-development arguments, so a crash cannot leave a stale lock. `--force`
  overrides deliberately. Unreadable pointer metadata now refuses rather than guesses; absent
  metadata still passes, because an unarmed pointer has nothing to destroy.
- **Codex skill revocation reaches the tree it wrote** (`t-f842f0`). Sweeping was previously skipped
  entirely because Codex projects skills into `<cwd>/.agents/skills`, a directory the plugin
  installer also owns. Ownership was measured at the point of use: outside the workspace root the
  tree belongs to this grant path and an empty selection now purges it; at the root it belongs to the
  installer and is never swept, with the inability to revoke recorded rather than ignored. A symlink
  in place of the directory is refused, not followed.
- **Visual QA at 360px now photographs a 360px viewport** (`t-4a477f`). All 117 catalog URLs omit
  `?width=`, so the preview iframe stayed at the route's frame while only the outer window shrank —
  every narrow catalog shot was a crop of the wide layout, and a genuinely broken narrow layout would
  have passed just as easily. The shell now sizes the iframe to the outer window, clamped to the
  route frame, so wide captures are unchanged and no existing evidence is invalidated. An explicit
  `?width=` still wins.
- **The IDE Browser recognizes its own session** (`t-849f52`) through a launch id stamped into the
  debug configuration, replacing name matching on the string "Tachyon".

### Removed

- **Three surfaces stopped promising write isolation no runtime delivers** (`t-5313dc`). The claim was
  measured false and withdrawn in the UI text rather than quietly softened. The follow-up measurement
  (`t-e5441a`) found that only Codex and Grok can express the narrow boundary at all, so detection
  and reporting is the only honest cross-runtime statement; prevention, if it ships, must name its
  runtime and refuse the others instead of silently falling back.
- **`verifyNativeMemory`** (`t-74b75a`), whose owner existed and had already delivered through
  another door.

### Internal

- `parseAgentEntry` is now two parsers and `forceTerminal` is gone with its eight branches, six of
  which were already unreachable in production (`t-8e6011`, SDD 496). The `MOVE_TO_AN_AGENT`
  diagnostic survives as the unknown-key message, because it names which block the entry lives in —
  the whole cost of the `t-9418ac` incident was three increments discovering exactly that.
- `applyContribution`/`unapplyContribution` no longer declare a synchronous return for the git-hook
  path, which returns a Promise (`t-e472a9`).
- Design Mode security review across `eval`, token, Trusted Types and click (`t-2136b6`): no measured
  path returns page content as evaluated JavaScript.
- **IDE Browser child-session death is now classified, not guessed as "tab closed?"** (`t-1c8195`).
  The owner's globo.com tab kept painted Design Mode chrome after CDP died. Production logs from that
  incident (same Extension Host, three launches, three deaths) discard extension reload and our own
  reset path. On Dev Host 1.128, toolbar Stop and closing the tab both tear down parent+child and
  destroy the page — no orphan. globo.com also opens a forest of extra `pwa-editor-browser` sessions
  under the CDP child (input for `t-849f52`). The log now records actor/trigger and, 150ms later,
  whether the parent survived. No auto-reconnect (duplicate chrome). Cleaning the orphaned inject
  without CDP would need a page-side heartbeat; that is a remaining choice, not built here.

## 0.85.1 — an agent was refused because of the subject it had worked on

Hotfix. Resuming an agent failed with `runtime_auth_rejected` while its credentials were perfectly
valid, blocking the maintainer mid-task.

### Fixed

- **Resume no longer rejects a launch because of what the transcript says** (`t-914be3`). The startup
  classifier scans pane output for login failures. On resume the runtime replays its entire transcript
  into the pane — 2,284 lines in the case that surfaced this — and that transcript contained
  "Authentication required" seven times, because that agent had been researching runtime permissions
  and auth. The agent was refused because of the subject it had worked on.

  The defect was an asymmetry inside one function: **rejection scanned the whole buffer while readiness
  scanned only the live tail**, and the three rejections ran first, so a perfectly rendered composer
  immediately below was never consulted. A sentence from yesterday could fail a launch happening now.

  The fix is the region, not the word list: removing one phrase would have left the same hole for the
  other five. All three rejections — auth, model and config — now read the same live tail the ready
  signal already read, in the generic classifier and in the Codex adapter, which had the same shape.

  **It did not become fail-open.** A second test holds the other side: a recent, genuine auth refusal
  is still rejected by both classifiers. Without that, this fix would have traded one defect for a
  worse one — a resume that ignores a truly expired credential.

  Declared limit: a runtime with no measured composer profile keeps scanning the whole buffer, and
  keeps the old behavior. Same rule the composer region reader already follows — without a measured
  ruler, nobody inherits someone else's.

## 0.85.0 — everything here was found by opening the product and using it

No item in this release came off the board. Each one came from the maintainer opening Design Mode,
trying something ordinary, and hitting a wall — an agent list that was empty while three agents ran, a
panel covering the reply it had just received, a bridge that would not start on its own, a debug
toolbar over the page. Two of them also corrected things this project had recorded as true.

### Fixed

- **"No running agents" now says which of three things it means** (`t-a4060b`). The Design Mode agent
  picker reported an empty roster while three agents were live and one was eligible by every rule. The
  list-building function ended in `catch { return []; }`, so *no eligible agent*, *the query failed*,
  and *there is no connection to the page* all collapsed into one sentence — and the right action
  differs in each case. An empty list reads as an answer, not an error.

  The host now distinguishes them: a disconnected page says to reopen the IDE Browser, a failed query
  reports its reason and logs it, and genuinely empty says so. A missing workspace now throws into the
  second case instead of disguising itself as the first.

  **And the filter that everyone blamed was reading a field that does not exist.** The exclusion tested
  `!row.temporary`; production rows carry `lifetime`, and there is no `temporary` boolean on them. The
  condition was always true — the filter had never excluded anything. Two separate investigations read
  that code, believed it, and built conclusions on it, including a line in the runtime parity matrix
  claiming Design Mode excludes Temporary agents. That line is now corrected in place, recorded as
  disproved rather than quietly deleted, so the next reader does not repeat the walk. Behavior is
  unchanged: removing a clause that never fired changes nobody's eligibility, and whether Design Mode
  *should* exclude Temporary agents is a product decision, not a bug fix.

- **The Selection card no longer covers the chat transcript** (`t-330a51`). With both panels open the
  card sat on top of the conversation, so a reply that had already arrived stayed invisible until the
  card was closed. Before/after captures at two viewports are in the spec's evidence directory.

  This was priority one for a reason that is not cosmetic: a reply that *arrives and cannot be seen* is,
  to the person looking, identical to one that never came — and 0.84.0 had just taught the panel to
  print "delivery was not confirmed" when a send fails. That warning is worthless if it is born behind
  the card.

- **`settings.ideBrowser.enabled: true` now means the bridge is up** (`t-7a4c36`). It used to mean only
  that a command existed. A human could click the globe in the status bar, which lazy-starts — which is
  why the palette command is literally titled *(advanced)*. An agent had no door at all: it called, got
  `bridge offline`, and was told to run a palette command it cannot run. That cost a full round of work
  in one day, with one task reporting offline four times while another brought the same host up by
  itself an hour later.

  The host now starts with the extension when the workspace opted in. Measured before shipping: median
  **10.06 ms**, p95 10.82 ms over 30 runs, and 20.32 ms for two windows on one root (they coexist on
  distinct ports). A workspace that did not opt in binds nothing. Only the loopback host starts —
  Chromium and CDP stay lazy until something navigates — and a failed bind is logged rather than thrown,
  because an optional feature must not break activation.

  The offline message now names a condition the caller can check instead of an action it cannot take.
  Turning the setting on with the window already open also reconciles for real now, rather than only
  repainting the status bar icons.

### Internal

- **The debug toolbar over the Integrated Browser is a VS Code limitation, proven in its source**
  (`t-414540`). Tachyon already passes all four suppression options when it starts the browser, and the
  toolbar appears anyway. Measured live: two `pwa-editor-browser` sessions exist; the child owns both
  the toolbar and the CDP connection Design Mode depends on. Reading VS Code 1.117's source at the
  pinned commit shows why — the DAP reverse request creates that child with only `{ parentSession }`,
  and while `noDebug` is inherited from the parent's configuration, the three UI suppression flags are
  not. The extension API cannot set options on an existing session or supply them for that request.

  Removing the child would remove the CDP session, so there is no fix inside Tachyon. The only lever is
  the global `debug.toolBarLocation` setting, which would also hide real debugging controls — the
  product does not mutate a human's global settings to hide its own side effect. Eight lines of comment
  now sit beside the four flags that do not suffice, because the obvious and wrong next fix is to add a
  fifth.

## 0.84.0 — a message that vanished, a panel that said it had been sent, and the one delivery ladder that already worked

The maintainer sent a Design Mode message to an agent to see whether it arrived. It did not. It sat in
the composer, unsubmitted, and would have stayed there forever — and the panel reported it as sent. He
was not looking for a defect; he was testing the feature the previous release had just measured.

Everything below came out of that one send.

### Fixed

- **A Design Mode message that does not arrive is no longer reported as sent** (`t-a48926`). The engine
  path behind Design Mode, handoff distill and `agent.input` called the blind primitive: paste the text,
  send a bare Enter, capture nothing, return nothing. If that Enter was swallowed — which is what
  happens when the target is mid-turn — the text stayed staged in the composer and no one knew.

  Two ordering facts made it worse. The chat event was written *after* the send, so a lost Enter still
  produced a "sent" row. And a staged draft is the exact condition that makes Tachyon refuse every
  *later* delivery to that agent, so one failed send could quietly deafen the recipient.

  The path now carries a receipt: the measured composer profile on submit, an explicit
  `typed-unsubmitted` status for deliberate staging, the chat row written *first* as pending, and — when
  the receipt is not `submitted` — no typing indicator, no reply wait, and a panel line that says both
  halves: *delivery was not confirmed*, and *the message is still saved*.

- **The reply wait no longer watches a turn that started before the message existed** (`t-b09d9c`).
  Measured from the chat log: the send at 12:48:33, the verdict "finished the turn without a chat reply"
  at 12:48:43. Ten seconds — during which the agent was finishing a turn that had begun twenty seconds
  *before* the message was sent. The host bound its wait to "the next turn ending" and watched the wrong
  one end.

  It now reads attention at the instant of delivery; if a turn was already running, that turn must end
  before any later busy→idle edge can close the wait. The mirror of `t-4c82fa`: require the evidence,
  not the label. The timeout was deliberately left alone — ten seconds was never the problem.

- **Three more content submits stopped sending blind Enters** (`t-ff34db`). The continuity nudge, a
  schedule's `instructions` when the agent is already up, and the resume primer. Their payloads were
  already durable elsewhere, so what was at risk was the *waking*, not the information — but a blind
  Enter also leaves text in the composer, which is what deafens an agent.

  The real fix was not swapping the call. In both continuity paths the code now returns **before**
  marking the agent nudged or restored when the receipt is unconfirmed. Recording "already delivered" for
  something that never left would have traded a silent loss for a loss filed as a success.

- **Two call sites joined the standard instead of inventing a third** (`t-b805b5`, `t-2c2384`). The
  validation-close wake injected with a bare submit while its twin — approval resolution — had been
  queue-aware for weeks; it now reuses that twin's port literally. And the Agent Pane's freeform submit
  omitted the composer profile, falling back to a heuristic that cannot see a wrapped draft, so a long
  human message was reported as delivered while still staged.

- **Four runtimes measured for how their composer wraps** (`t-ba5357`). Without a measured rule the
  region reader reads a long draft in half and classifies it as delivered — and that wrong
  classification is what previously *disabled the retry loop* built for exactly this failure. The
  threshold is `pane_width − 4`; Tachyon panes are 220 columns and 92% of measured notices exceed it.

  Claude and Hermes now have declared continuation rules, from real 220-column pane captures. Grok and
  OpenCode were measured and deliberately **not** declared: Grok's continuation rows keep the left
  border, which the current reader preserves, so a regex alone cannot recover the text; and OpenCode's
  pane shows only `[Pasted ~1 lines]` — the bytes never appear at all. That second one is not "not yet
  measured", it is not observable through the pane, so *unconfirmed* is the permanent ceiling there.

### Internal

- **The delivery inventory that made all of the above one decision instead of eight** (`t-a5b186`).
  Twenty-one paths write into an agent pane; each was read at the call site and recorded with its
  primitive, whether the payload is durable, whether a retry exists, what receipt the caller sees, and
  who pays when it fails. Three primitives were doing the same job at three qualities, and the best one
  had existed since an unrelated fix without ever being generalized.

  The chosen standard invents nothing: it is the ladder `notify_agent` already runs — persist, knock,
  honest receipt, and the payload survives a failed knock. It deliberately keeps human messages *out* of
  the agent notice log (different origins; mixing them would pollute what agents pull), and it answers
  the unmeasured-runtime case explicitly: the ladder still applies, `submit-unconfirmed` is the honest
  ceiling, and nothing shows a green check it has not earned.

- **The activation refusal is fail-closed for fleet interpretation, not for the workspace** (`t-613361`).
  A question from July, never measured: when activation is refused, the Bridge keeps answering and keeps
  accepting writes. It is deliberate, and the proof is structural rather than empirical — the Bridge
  listener starts in `_create`, before `start()` runs, and the refusal is an early return with a notify
  that touches no teardown path. Now written where the next person will ask.

### Documentation

- **Design Mode panel-land is proven for two runtimes end to end** (`t-ba5027`). The August 6th matrix
  measured with the browser bridge offline, so it only ever proved MCP→handler. Codex and Pi each listed
  and called the reply tool with a turn id, used no markers, and produced exactly one chat-log event and
  one live panel bubble for a unique nonce. Pi moves from unmeasured to partial.

  The last link — a reply resolving an *outstanding* turn — was closed by the maintainer's own test send,
  the same one that exposed everything above.

- **Visual evidence pack for the Design Mode spec** (`t-7f994f`), captured in a real Extension
  Development Host. Verdict recorded as *concern*, not pass: with the selection card and the chat both
  open, the card covers the transcript, so a reply that has landed is invisible until the card is closed.
  Filed separately (`t-330a51`) — a delivery that arrives and cannot be seen is, to the human,
  indistinguishable from one that never came.

## 0.83.0 — a freeze you could feel, a refusal that hid its own answer, and 295 lines nothing could reach

Four of the nine items this round shipped no code at all. Three questions were closed by measuring them
and finding nothing to fix, and one deletion stopped at the door because the evidence that would justify
it does not exist yet. That is the shape of the round, and it is deliberate.

### Fixed

- **Saving a pin no longer freezes the window** (`t-17df02`). The pin store took its cross-process lock
  with a *synchronous* wait — `Atomics.wait`, which stops the extension host thread outright. With a
  second window or a Dev Host beside the first, saving a pin froze the UI until the other process let
  go. The seven mutations now await the asynchronous lock that already existed in the codebase; reads
  never took the lock and stay synchronous.

  **The test is the delivery.** It spawns a real second process that holds the pin lock for 800ms,
  starts a 20ms interval in the waiting process, and then saves a pin — asserting both halves: that it
  genuinely waited, and that the timer kept firing. Under the old code the tick count is zero. The
  comment calling the synchronous wait "a known cost" was corrected in the same commit; leaving it would
  have been the next written promise the code does not keep.

- **A refusal leads with the action instead of burying it** (`t-94273f`). Launch failures were ordered
  product prefix, subsystem prefix, long absolute path, action last — so a fixed-width notification band
  spent its budget on the path and clipped the fix. Lived, not theorised: the maintainer read
  `no credentials at /home/gc`, concluded Grok was unsupported, and asked when it would be enabled. The
  answer, `run grok login first`, was past the clip.

  Seven notification-bound refusal sites were measured; three messages serving four of them were
  reordered, and the tests assert that the action's index precedes the path's — an assertion on
  *containment* would pass with the order reversed.

  **The three credential sites were deliberately left alone.** Their defect was never word order: a
  notice with no actions falls into VS Code's status-bar branch, one cell wide and erased after eight
  seconds. Giving it a button was the fix, and that already shipped. Reordering them now would edit
  something that no longer hurts.

### Internal

- **295 lines that nothing could reach are gone** (`t-83723d`, `t-aec8a0`). `dogfoodBootstrap.ts` (195
  lines) sat in the production shell path with zero importers, its own header noting it was never
  registered — dev scaffolding in `src/webview/` that invites the next reader to wire it up. And a
  dev-host repro scenario drove `Control → Fleet`, a route that has not existed since the section list
  went empty, clicking a test id that no longer appears anywhere in the tree.

  The deletion broke a paragraph in `docs/runbooks/dev-host.md` that taught readers to copy that
  scenario as a template. That was fixed in the same commit rather than deferred: a reference broken
  *by* a deletion is part of the deletion.

- **The IDE browser bridge manager is three pieces with a boundary** (`t-47503a`). 1180 lines carrying
  eight measured responsibilities became a loopback HTTP host, a browser/CDP session controller, and a
  Design Mode adapter, with the engine↔host protocol given real types — a route table, request and
  response shapes, and one shared decoder. The public surface is unchanged and the historical error
  strings are identical.

  Reading it surfaced two facts for the multi-root work (`t-849f52`), recorded rather than fixed:
  `launchBrowser` accepts the first browser child with a matching parent session and carries no
  correlation id, and `resetBrowserSession` stops any debug session whose name contains "Tachyon" —
  including one another manager owns.

### Documentation

- **Which browser product, when** (`t-26232e`). Tachyon has three and they are not interchangeable: the
  Integrated Browser with Design Mode for a page the human and agent share inside VS Code, the Companion
  for the human's own signed-in tabs, and the agent-browser plugin for headless work the agent owns
  alone. One page: when to use each, when not to, what must be running, the tool namespace per product,
  what fails closed, and cleanup.

- **A race on Design Mode send is recorded as an accepted boundary** (`t-a7d951`). Between the probe that
  reads the composer and the tmux write there is a window with no compare-and-send, so a draft typed
  inside it can be submitted together with the prompt. This was chosen — the alternative was the
  multi-second stale read it replaced — and closing it needs a different transport, not a claim that the
  probe is atomic. Written down so it is not "fixed" later by someone who does not know it was a
  decision.

### Measured and closed without code

- **No test in the tree is a time bomb** (`t-ab17f8`). Thirty test files carry literal dates (the task
  said 21; the count was wrong). Twenty-nine are safe by construction — the frozen date is *injected*
  into the code under test as its clock, so the result never changes. The one genuine bomb, a fixture
  aging against the real clock, had already been fixed. Nothing to change.

- **Crash-loop on resume cannot happen as configured** (`t-7525c6`). Auto-restart is gated on a per-agent
  `restart: on-crash` policy that defaults to `never`, and no agent sets it — so the path that would
  resume a session into the crash that killed it is unreachable here. Not "has not happened yet":
  cannot, today. The existing backoff and give-up guard bounds it for anyone who arms the policy.

- **Deprecating the Design Mode pane markers stopped at its own precondition** (`t-45b266`). The spec
  requires the runtime matrix to be green first. It is half green: three runtimes are proven to *call*
  the reply tool, and none is proven to have the reply *arrive* — the panel-land column is unmeasured
  because the bridge was offline when it was taken, and two runtimes were never measured at all.
  Deleting the fallback on that evidence could leave a runtime with no working voice, and the headless
  test would not catch it, because it measures the call and not the arrival. No lines were changed.

## 0.82.0 — the last two places where VS Code's chrome stood in for ours

The maintainer's rule is that Tachyon builds its own pickers. Two sites resisted for measured reasons,
and both are gone here — one because the styles finally separate from a font the terminal cannot load,
the other because what was missing was a component, not a second picker.

### Added

- **A PR form that belongs to the product** (`t-f3ded3`). "Open a pull request" in the land block asked
  for the title through VS Code's input box and confirmed through a native modal with the body crammed
  into a detail line. It is now a `ConfirmForm` in the design system: editable title, scrollable body
  preview, the base branch and dirty-tree lines as real meta, and Confirm/Cancel.

  The authority split did not move: the host still owns readiness probing and PR creation, and the
  surface only collects. The probe still happens **at the click** — the draft is composed then, and
  confirming does not probe again — which is the property that makes the button safe on a polled
  dashboard. Closing the panel mid-flow cancels and creates nothing. At 360px the layout stacks; a
  field beside a multi-line preview is exactly the shape that collapses there.

- **The product's picker now draws inside the Agent Pane** (`t-de3dfc`). That surface deliberately
  refuses the design system, because the Tachyon Mono `@font-face` breaks xterm's cell metrics — and
  the picker's rules lived only in that sheet. They now live in a font-free layer linked beside it, so
  nothing is duplicated and the font exclusion holds.

  **The risk was measured before anything moved**: the picker listens for keys in the capture phase on
  `document`, and the Agent Pane is a live terminal that forwards keys to tmux. A focused probe
  confirms filter text, arrows, Enter and Escape never reach the pane's input.

### Fixed

- **Removing an agent retires its file-shaped bridge config** (`t-652153`). End-of-life retired only
  the directory-shaped runtime homes, so a `bridge-mcp/<name>.json` survived every removal. Measured
  along the way, and reported rather than swept: seven such files were orphaned, four harness homes for
  absent agents hold 330,215,424 allocated bytes — retained by design — and the size receipt the tool
  promises is a host notification that counts neither.

- **A refusal stops sending a terminal to doors that do not serve it** (`t-849277`). `dismiss_agent`
  called a declared terminal a "Saved Agent" and offered removal-proposal and Agent Studio, neither of
  which applies to it. The cause was vocabulary: `saved` is a *lifetime*, shared by profile-backed
  agents and declared terminals, and the refusal keyed on it. Terminals now get their real door — the
  sidebar's Remove, or the `config.agent.delete` operation that action invokes.

### Internal

- **A memory crash is diagnosable after the fact** (`t-bd9c61`). The vitest budget ledger lives in
  `/tmp` and holds only live claims, so a reboot erased any answer to "how many suites were running,
  whose, and how large". Moving it alone would not have helped — the next admission reaps dead PIDs and
  rewrites the file empty — and refusals never wrote it at all. One append-only line per admission and
  refusal now survives, with the siblings alive at that instant. Volume was measured before choosing a
  bound: at a peak of 63 gate runs a day, this is roughly 23 MB a year, so there is no rotation. It
  does not prevent the crash or reduce memory use; it only makes the question answerable.

## 0.81.0 — three doors write into a pane, and all three now read it at the moment they write

Tachyon delivers text into a running agent's terminal through three doors: the Interface (you typing a
prompt), an Agent (`write_input` / `notify_agent` over the Bridge), and Tachyon itself (queued
notices). Each decided differently whether the pane was free, and each could be wrong in its own way.
This release makes the three read the same region, with the same runtime-measured rule, at the instant
they write.

### Fixed

- **The Interface door stopped deciding from a stale poll** (`t-344fa6`). `prompt.inject` read composer
  occupancy from the attention poll rather than from the pane, so a human draft created after that poll
  could be overwritten — and it submitted without the runtime's composer profile, falling back to the
  legacy last-line heuristic that this release's predecessor replaced. It now probes immediately before
  writing, keeping the cached value only as the fallback for runtimes with no measured signal, and
  passes the profile so the same region reader governs it. Twelve lines of product code: the machinery
  was already there, built by the other two doors.

- **A queue overflow leaves a durable record** (`t-2153ae`). Dropping the oldest notice past the
  per-recipient cap only ever produced a transient toast, so the loss could not be counted after the
  fact. It is now an `overflow-drop` event in the doorbell trail, with its own shape so that
  `read_notices` and completion checks never mistake it for a doorbell.

  **The proposed fix was refused on its own measurement.** Making the queue visible — a new projection
  and UI — was the recommendation; the numbers behind it were a live queue of zero, zero recipients with
  a pending queue, zero observed overflows, and 91% of new notices already lifted out of the broken
  class by the previous release. Building a surface for a condition that does not occur is the wrong
  trade. What was worth fixing is that the event left no trace at all, which is why "it never happened"
  could not be demonstrated. The record does not limit the wait, expire an authored report, or prevent
  a stale delivery — it only makes a previously silent loss measurable.

- **A studio that fails to load names the surface, not an invented entity** (`t-831332`). The error
  screen said "New Agent" for a document that never loaded, because the error envelope carries no
  identity, and it offered a Save with nothing to save. The title now states what the screen actually
  knows — which studio it is, and that it failed — and the dead action is gone. One shared surface, not
  eight shells.

- **A dead pane stopped reading as alive under a non-UTF-8 locale** (`t-86f3e6`), where tmux substitutes
  its field separator and the helper meant to prevent exactly that had two holes of its own.

## 0.80.0 — the product stops claiming what it has not verified

Six defects here share one shape, and it is the shape this codebase produces most: a surface
asserting a state nobody checked. A Stop reported success 600 ms after sending keys. A dead row
offered the toolbar of a live agent. A fresh agent was called busy and refused *the human's* own
prompt. A discarded config line lived only in a toast that vanished. And every delegated subagent
carried eleven skills its delegator was never granted.

### Added

- **Landing a worktree is a product operation** (`t-7cb971`, SDD 498). The crossing from a worktree to
  the trunk now happens inside Tachyon, in the shape the Forget flow already uses — and the agent
  still cannot perform it.

### Fixed

- **A delegated subagent receives exactly its delegator's grant** (`t-53e485`). Measured across eleven
  agent homes: the parent profile granted three skills, the parent's home held three, and **every
  delegated child held eleven** — the workspace's installed plugin set. The delegable toolkit started
  from the parent's snapshot and then unioned every `skill-dir` in the plugin lockfile, treating an
  install as a second grant door.

  It is not one, and the measurement says so rather than the principle: `.claude/skills` and
  `.agents/skills` are gitignored, so no worktree holds them, and every parent's private home carried
  exactly its own grant — nobody held the eleven. The door even invented a grant, handing one child
  eleven skills delegated from a parent whose profile grants zero. Two of the eight extras are not
  decorative: one is paid image generation, the other drives a real browser. Codex leaked identically,
  with only the delivery target differing, which is why its home looked empty.

- **Stop reports what happened** (`t-22944a`). It sent `C-c`, waited 300 ms, repeated, and resolved
  **successfully** without checking whether the process died; the truth appeared only when a later
  refresh reclassified the row fifteen seconds on. Measured on Grok 1.0.0 mid-turn, successful exits
  land at 992–1032 ms, so confirmation waits two seconds — not the fifteen that would block a click.
  Stop now answers `stopped`, `alive` or `unknown` where it answered one success for three outcomes.
  Forced Kill stays an explicit human gesture; nothing escalates on its own.

- **A fresh agent is no longer called busy without evidence** (`t-4c82fa`). The initial `working` label
  is synthetic — measured, the window is 9 to 12 seconds — and three action gates trusted it, including
  the one that refuses **your** prompt. The seed stays honestly unknown; the gates now require positive
  evidence that a turn started.

- **A discarded config line leaves a durable record** (`t-7d6013`). Every unreadable key warns instead
  of refusing the file — the maintainer's decision — and that put the whole weight on a toast that
  vanished. A dismissible banner now names what the last successful load threw away. It never touches
  config validity, so a typo cannot mark the fleet invalid, and dismissal is keyed to the signature of
  the discarded set: reading once silences that file, and any change brings the record back.

- **A stopped agent no longer offers the repertoire of a running one** (`t-c515c0`). The row for an
  agent the human stopped read `stopped (exit 130)` and carried, beside it, the same bar as a live
  agent: Open terminal, Open agent pane, and a **Kill forced** for a process that had already exited.

  What the doors promised is not in the pane. Measured over the full scrollback on claude, codex, grok
  and pi, a postmortem pane retains exactly ONE line — tmux's own `Pane is dead (status …)` — because
  the runtime's TUI restores the primary screen as it exits. The two comments in the code that
  justified keeping those doors ("the pane still holds the `^C` and the exit code") were wrong, and are
  corrected rather than left behind. A **crash** is the other case and keeps its doors: it never
  restores the screen, so the same measurement read 20 lines back off a killed pane. A requested stop
  and a crash no longer offer the same set — telling them apart was the whole complaint.

  `Kill forced` was not noise, which is why it stayed: on a dead row that command reduces to the tmux
  `kill-session` that reaps the postmortem, and it is the row's only door to it. It is now named for
  what it does — **Collect dead pane** — with its own icon, and it is offered only where there is no
  process left. A clean exit whose pane Tachyon already collected offers neither door; that shape used
  to invent a pane through a fallback that only held while the field was absent.

  The exit code itself is unchanged and still shown. `130` is not a grok convention: measured, bare
  grok exits 0 (9 of 9), while a stop through Tachyon — which starts every agent with its brief as a
  prompt, so the process is mid-turn — exits 130 in 3 of 5 runs and does not die at all in the other 2.
  The number describes what the process was doing, not whether the stop was asked for, so nothing keys
  on it; the intent is still read from the recorded request.

- **The vitest budget stopped failing open** (`t-ad8fd2`) — an unreadable ledger became an unaccounted
  invocation, and two of those could not see each other. A revoked skill stopped surviving in a reused
  private home for the fourth runtime (`t-fc1df8`). A canonical codex agent with no worktree stopped
  deleting the workspace's eleven plugin installs (`t-94d49a`). A pin id is no longer drawn outside its
  lock, so a collision draws again (`t-8cdd0d`).

### Internal

- **Agent isolation, measured per runtime** (`t-5313dc`) — including that Pi cannot be isolated at all.
  Three permanent documents asserted an isolation the parity matrix had no dimension to describe.

- **The suite stopped depending on the machine it runs on.** Zero opencode binary executions in
  `test/unit`, counted rather than presumed (`t-35c998`, `t-64ea85`, `t-ed0f43`); 27 tests no longer
  need host state to exist (`t-b10d93`); one test stopped inheriting `XDG_DATA_HOME` from the host and
  its assertion got *stronger* (`t-86467a`); and `engineSupervisor` fell from 41.4 s to 10.4 s
  (`t-d1f356`) — the single file that set the floor for the entire gate.

- **Two ghosts that were not there.** The gate failed 6% of runs over a leak that never existed
  (`t-ffc5bf`), and the tmux scope oracle kept catching what there is to catch (`t-c1b382`). The
  vsix-smoke was deleting its tree with the tmux server still alive, where the guard could not see it
  (`t-10fda8`).

- **37 specs left limbo** (`t-5507f1`): the right status was already there, buried in prose on the
  status line. Eleven test files stopped pointing at a directory deleted two days earlier (`t-1fa246`),
  and the shipped schema now publishes exactly the keys the parser accepts, in both directions
  (`t-d47b0a`).

## 0.79.0 — an engine upgrade asks before killing a turn in flight

### Fixed

- **Upgrading the engine no longer discards work in progress without asking** (`t-173b8b`). A plain
  reload was already safe; the engine *upgrade* was not, and it is the path a human takes right after
  installing a new build. The window between installing and reloading is exactly when an agent is most
  likely to be mid-turn.

### Removed

- **Self-evolution is gone from the product** (`t-8ea8e0`) — 9,318 lines and 22 files. Not moved,
  deleted. The capability was never turned on for any agent here and nothing of it existed on disk; a
  replacement will be designed from scratch as an installable plugin, following the model a runtime
  already ships natively (a `pending/` directory plus approval as a gesture).

  The removal is broad and deliberate: the whole `src/evolution/` tree, the evolution leg of the
  formation authority vector, the `submit_evolution_review` Bridge tool (inventory 79 → 78), what the
  engine protocol carried, the toggle and section across **five** studio shells with their 38
  localized strings and 37 CSS rules, the `selfEvolution` config key in parser, writer and schema, and
  ~230 lines of authority-head in the workspace along with its secret.

  **The proof closes by identity, not by absence of a word.** Each case asserts the exact set a surface
  accepts — config keys, reference kinds, the Bridge tool inventory, prompt layers, formation lanes,
  forget-plan steps — so reintroducing the machine means adding a member to a declared set, and a set
  comparison fails under any name. Demonstrated by injecting a reference kind called `growth`, which a
  search for "evolution" would never catch.

  Three things surfaced during the removal and were reported rather than worked around: the parity
  matrix contained no mention of evolution at all, so there was nothing to correct there; 59 completed
  tasks carry an inert `evolutionCompletion` marker on disk, dropped on read and gone on the next
  write, needing no migration; and `gcLedger`'s "the ledger line survives for a retry" guarantee is no
  longer reachable, because it only held while an evolution step could fail before the line was spent
  — the test now asserts what remains true.

  Visual QA after the fact (`t-475b9b`): the seam where the section used to be measures 12px, the same
  as the column's median gap, with zero empty boxes and zero overflow across four routes at two widths.

### Internal

- **The skill grant is checked for every runtime, and a revoked skill leaves disk** — see 0.78.0; this
  release carries the live proof: starting `grok` with an empty selection removed three skill trees
  that had survived every regeneration since 07/08.

## 0.78.0 — granting a skill worked; taking it back did not

Removing a capability from an agent's profile left the files on its disk. Measured on the
maintainer's own workspace: the `grok` profile lost its `capabilities:` block on 09/08 at 21:54, the
private home was regenerated at 01:08 the next day, a session ran at 01:57 — and three skill trees
from 07/08 were still sitting there, one of them `agent-browser`, which drives a real browser.

### Fixed

- **A revoked skill is now removed from disk** (`t-987347`). The cause is a routing one: a profile
  that loses its selection produces no projection, so `profileCapabilities` is `undefined` and the
  revocation enters through a *different door* than the grant. Every `if (capabilities)` guard was
  therefore describing exactly the case a revocation never reaches. **Empty is a selection, not the
  absence of one.**

  The purge is now unconditional and runs *before* deciding to re-materialize — but it was not copied
  from Claude's sweep. It removes what each runtime's grant path writes into the private home and
  nothing else, per runtime: `grok` its `skills/` and manifest; `codex` only the manifest, because its
  skill tree lands in `<cwd>/.agents/skills`, a directory the **plugin installer** also owns, and
  sweeping there would delete plugin installs for every agent in the workspace (`t-f842f0`); `pi` only
  the manifest, because its generations are content-addressed and a revoked profile no longer gets the
  `--skill` arguments that are the only way to reach them. Claude was already correct and became the
  test's control.

  All four runtimes were measured rather than assumed: **codex had the defect too**, and pi's residue
  was inert but its manifest lied.

- **The skill grant is now checked for every runtime, not just Claude** (`t-a7063c`). The exact
  host-custodied grant was required only when the adapter was `claude`; the neighbouring mcp, hook and
  generic lines never had that condition. The guard was born in a Claude-specific task and was never
  generalized when delivery to codex, grok and pi arrived. Meanwhile the inspector text the human
  **attests** already promised the check for both grok and codex. Making the code honour the
  attestation is strictly stricter, so no promise changed.

- **A Studio save no longer deletes what the form cannot show** (`t-26ba8f`). Measured round trip:
  `attention: {enabled: true, silenceSec: 30, patterns: [...]}` came back as `attention: true` after a
  save that edited nothing. `env` was found by the same measurement and fixed with it.

- **The Grok preflight stops approving a CLI with no credential** (`t-5dcf47`). Grok 1.0.0 prints its
  model catalog in both auth states — measured with a live credential and an empty home, the only
  difference is the first line — so the catalog never was an auth signal. Authentication is now read
  from the banner, and an unrecognized banner fails to `unverifiable`, never to `supported`.

- **A studio that fails to load says so** (`t-f4e186`). `!ready || !entity` conflated "the host has not
  answered" with "the host answered and sent no document", so an error left the spinner as the
  *terminal* state. Seven of the eight studio shells had it; `pipeline-studio` was already correct and
  became the control.

- **The land card uses the width of the card** (`t-ea5425`), and picking a file to review happens in
  Tachyon's own list instead of VS Code's. Measured at 880px: the block went from 480 of 824 usable
  pixels to 798, and the one actionable line stopped breaking into three.

- **The journal reads back in the order it was written** (`t-c89c52`). Entries sharing a millisecond
  were ordered by a random id — 100 of 200 reads preserved append order, an exact coin flip. The
  tiebreak is now the file's own line order; no persisted format changed.

- **The onboarding template opens clean in the editor** (`t-fe772a`). The product accepted every key
  in `tachyon.yml.example`, and the editor marked two of them red, because the bundled JSON schema had
  fallen behind the parser. A newcomer believes the editor, not the product, and deletes working
  configuration.

### Internal

- **The gate's worker pool is sized by the measured CPU knee, not by free RAM** (`t-fb7025`,
  `t-392418`). Two runs on the same tree: 15 workers → 91s wall and a load-1 peak of 16.67; 8 workers →
  88s and 8.63. The suite is 392s of CPU whose longest single file is 55s, so the makespan is pinned
  regardless. The cap is now **6**, the conservative side of that knee, chosen to be calibrated by use.
  A duplicated `typecheck` was removed from inside the suite — the gate already runs it 35 seconds
  earlier — freeing 46.5s of CPU per run.

- **The test suite stops leaking tmux servers** (`t-8f48da`). 1946 were alive on this host, 1719 with a
  working directory that had already been deleted. Deleting the directory is not cleanup: a server
  whose socket is gone keeps running. Reaping now happens where the private socket is created.

- **The gate stops answering "is this machine logged in?" on the agent's behalf** (`t-a12966`). 8273
  tests swept; skips now declare a reason and `verify-full` names any file whose skips declared none.

- **Notice delivery stops claiming a submit it cannot see** (`t-7a297f`). A wrapped composer line was
  read one row deep, so a 433-character notice was compared against the 120 characters recovered — and
  the mismatch was reported as *delivered*, which also disabled the retry. 92% of notices are long
  enough to wrap.

## 0.77.0 — Tachyon runs without the SDD plugin installed

The maintainer's rule, and the acceptance criterion it produced: *"sdd é plugin e não deve estar no
core do tachyon … o core não deve ser acoplado a nenhum plugin … tachyon funciona sem sdd instalado."*

The core had grown to know one plugin from the inside: it read the plugin's files, parsed its format,
carried its status vocabulary into three separate schemas, and **refused to close a task** because a
markdown file said something other than `shipped`. A project that never heard of SDD carried all of it.

### Changed

- **The core no longer executes the plugin's policy** (`t-73b2e1`, step 1). `assertSddStatusUpdateAllowed`
  refused `status: done` unless a spec file said `shipped`; derived attentions and `RETRIAGE_SDD` /
  `ACTIONABLE_SDD` removed tasks from the work queue by the same reading. All gone.

  That guard also **failed open**, found by accident: a status outside the enum parsed as `undefined`
  and the gate opened — so the check meant to prevent premature closure was disarmed by exactly the
  error it should have caught. It was removed rather than fixed; improving a guard before deleting it
  is work on dead code.

- **The core no longer speaks the plugin's vocabulary** (step 3). `SddStatus`, `SddDerivedStage`,
  `TaskDerived.sdd`, the `missing_sdd_spec` / `sdd_needs_retriage` attention codes, the card fields,
  and the dedicated sections in Board and Task Detail. The seven-status enum had been **written three
  times** — `types.ts`, `boardProjection`, `taskDetailProjection` — a plugin's vocabulary copied into
  three product files.

- **The core no longer reads the plugin's files** (step 2). `resolveSddSpec`, `readSddStatus`, the
  derivation cache, and `managedSddWorkspaceRoots` — which walked the managed-worktree registry to find
  a spec in *another checkout*. Also `scanSpecs`, which scanned `docs/specs/*/tasks.md` for checkbox
  lines and turned them into validation candidates.

  **That last one removed a feature that was used**: 2 of the 8 validations ever created in this
  workspace came from it. It is a convenience, not a mechanism — `create_validation` was always the
  door, and `scanSpecs` only saved typing — but it is a real loss and is recorded as one. The other two
  discovery sources (`.tachyon/tasks` and pins) are unchanged, held by a test.

### What did not change

**The link a task keeps to its spec.** 271 tasks carry `artifact_refs: [{type: "sdd", …}]` and are
byte-identical on disk; `type` was always an opaque, extensible string. The reference still renders —
through the **generic** artifact surface that already shows `path`, `issue` and `task`, rather than a
section only one plugin had. What died is the core *interpreting* the value.

The rule is now two tests rather than a sentence:

```
closes and selects a task with an SDD ref when the plugin and docs/specs are absent
discovers the same task and pin candidates whether docs/specs exists or not
```

**No guard was added against future coupling**, by explicit decision: *"isso é disciplina de projeto,
se não vamos ter mais guard que funcionalidades no sistema."* The guards this codebase does carry were
each earned by a measured recurrence; this coupling happened once.

Of 15 installed plugins, SDD was the only one the core knew behaviourally. `agent-browser` appears in
an external-tool provenance union and **stays** — it reads no file, knows no format, executes no policy.

## 0.76.0 — saving a form stops deleting what the form cannot show

Three defects in this release share one shape: the product answered a question it had never
measured. A Studio save answered "what is this agent's attention config?" with a boolean it had
inferred from a checkbox. The Grok launch preflight answered "is this CLI authenticated?" by reading
a model catalog that is printed either way. The gate answered "is this agent's work green?" by
testing whether the host it ran on happened to be logged in.

### Fixed

- **Saving in a Studio no longer deletes `attention.silenceSec`, `attention.patterns` or `env`**
  (`t-26ba8f`). Every Studio models attention as one boolean, and the writer replaced the whole YAML
  node. Measured round trip, from a save that edited nothing:

      in:   attention: {enabled: true, silenceSec: 30, patterns: ["waiting for approval"]}
      out:  attention: true

  Both fields were live — `silenceSec` is the AttentionMonitor's idle threshold and `patterns`
  becomes its `extra_prompt_patterns` rule — so this was destruction of working configuration, not
  removal of a dead field. `env` was found by the same measurement and fixed with it: same
  `doc.setIn` replacement, same silent loss.

  The carried-forward list is **closed**, deliberately. "Preserve everything the form did not send"
  would be wrong twice: the form deletes *by omission* for the fields it owns (unchecking autostart
  removes the key), and carrying a key the loader refuses for that section would produce a file the
  next save cannot persist.

  The guard does not look for a literal. It asserts that a save which edited nothing is the
  **identity** on the loaded definition, over every entry key the shipped schema declares, with the
  real parser deciding which of them a terminal may carry — and a second assertion requires every
  declared key to have a probe value, so coverage cannot shrink by omission when a key is added.

- **The Grok preflight stops approving a CLI with no credential** (`t-5dcf47`). It resolved
  `supported` whenever the model catalog parsed, on the premise that a logged-out CLI prints a
  sign-in notice instead of a listing. True on 0.2.112; false on 1.0.0. Measured on one host with a
  live credential and an empty home, same session:

      $ diff <(grok models) <(GROK_HOME=<empty> grok models)
      1c1
      < You are logged in with grok.com.
      ---
      > You are not authenticated.

  One line. The catalog block is byte-identical and both exit 0 — so the catalog did not *stop*
  being an auth signal, it never was one. Authentication is now read from the banner line, and the
  catalog is consulted only after the known logged-in banner appears. A logged-out banner, an
  **unrecognized** banner and an unreadable catalog all resolve to `unverifiable`. A future wording
  change can cost a verdict; it cannot turn a credential-free CLI into `supported`.

- **The land card uses the width of the card, and the review picker is the product's own**
  (`t-ea5425`). The land block rendered in the list row's text column, sharing the line with the
  action buttons: measured at 880, it received 480 of the card's 824 internal pixels, and the one
  actionable line on screen — `Fix: run the declared verify gate IN this worktree…` — broke into
  three pieces inside that river. It now spans 798 of 824, with the fix on two lines and its label
  emphasized.

  **Review these changes** selects the file in Tachyon's own filterable picker instead of VS Code's
  QuickPick. The diff itself still opens in VS Code's diff editor — that is the right product for
  the job, and the single-implementation guard still holds: one function builds the pair and calls
  the editor, and it now takes an argument naming *which chrome picks the file*. The sidebar agent
  row and the pipeline's "View changes" stay on the native QuickPick, because they are tree items
  with no surface of their own to draw on.

  The PR form is **not** converted. `gh pr create` needs an editable title, a body preview and a
  confirmation, and the picker is a filterable list; the cost is measured and the slice is open
  (`t-f3ded3`).

### Internal

- **The gate stops answering "is this machine logged in?" on the agent's behalf** (`t-a12966`). An
  agent that delivered 321 lines of markdown got four red tests about agent crash memory, because a
  fixture needed a real credential to materialize a harness. 8273 tests were swept in two labs — one
  strict, one faithful to an agent worktree — and reported separately rather than summed. Result on
  the faithful lab: 4 failures and 98 skips became 0 and 41, with **no skip left silent**.
  `verify-full` now prints the declared reason for any skip and names the files whose skips declared
  nothing. That line found phantom coverage the same day it appeared: three SDD 485 budget guards
  gated on `dist/webview/cockpit.js`, a file deleted hours earlier, skipping on every gate in a fully
  built tree.

- **A non-UTF-8 locale breaks pane reading, and the test that proves it was left red** (`t-86f3e6`).
  Under `LANG` empty, `C` or `POSIX`, tmux substitutes `_` for TAB in `-F` output and `TmuxService`
  splits on tab in two places — every pane reads back `dead:false, pid:0`, so a dead pane is never
  detected and `restart: on-crash` never fires. A declared skip would have hidden a product defect
  behind the fix for a test problem.

- **The Agent Studio `new` preview route shows the screen production actually renders** (`t-547771`).
  Its fixture was built on the legacy form, so the Evolution toggle rendered clickable where
  production keeps it read-only, and the command placeholder offered `agy`, an unattested runtime the
  canonical path refuses. Two earlier tasks had worked around it rather than fix it; both detours are
  now removed.

- **The core stops enforcing the SDD plugin's policy** (`t-73b2e1`, step 1 of 3). Closing a Task no
  longer depends on what a markdown file under `docs/specs/` says, and the SDD-derived branches are
  out of the work queue. Reading and vocabulary remain, deliberately — they are steps 2 and 3, and
  removing policy and format in one commit would mix two different risks. `artifact_refs` is
  untouched: the 271 Tasks that name a spec are byte-identical on disk.

- **Process selectors** — `docs/project-guidance.md` now says to stop only the PID your own spawn
  returned, never a command-line pattern. This was proposed as a source guard and measured out of it:
  `scripts/` and `src/` contain zero `pkill`/`killall`, so the guard would have watched an empty set
  (`t-895ca6`).

- **Documentation weight** — 204 shipped specs distilled, 42,889 lines out of the working tree
  (`t-a46d8a`), and the dogfood harness shortcuts left the repository manifest (`t-f0ea03`).

## 0.75.0 — you can finally look at the code before you land it

The land block has always shown five green checks and a command to copy. It never showed a way to see
what the command would land. Measured on the coordinating agent's own behaviour on 2026-08-09: every
merge that day was reviewed by running `git diff` in a terminal — seven merges, seven trips outside
the product, with the land block open on screen the whole time.

### Added

- **Review and Propose, at the land door** (`t-3eaf77`, SDD 501). Every land block now ends with two
  actions: **Review these changes** opens the changed files in VS Code's own diff editor, and **Open a
  pull request** runs the existing `gh pr create` flow.

  **Neither is new code.** Both features had been built — diff review in spec 213/230, PR creation in
  spec 223 — and both were reachable only from the sidebar agent row, one room away from where the
  decision is made. This spec moved the reach, not the machinery. A guard test holds that there is
  exactly one `vscode.diff` caller, one consumer of the changed-file primitives, and one caller of the
  parser; it carries a self-check that runs its own detectors against synthetic sources with planted
  violations, because a static guard blind to what it forbids passes forever.

  **Tachyon renders no diff.** VS Code already ships the best diff viewer we could put there.

  Review compares **committed history** — `trunkRef..head`, exactly the commits the land command would
  introduce, not the working tree. That was measured rather than assumed, and the measurement inverted
  the plan's guess: the committed comparison is *cheaper* (10.9 ms vs 16.4 ms over a 130-file range),
  because it never stats the working tree and drops the `git ls-files` subprocess. The sidebar and
  pipeline callers keep the working-tree comparison, because there the question is different — what
  has this agent touched so far, including work not yet committed.

  On a **blocked** delivery both actions still appear, deliberately: a red check is when you most want
  to read the code. The line naming the comparison changes with the state — it stops claiming "the
  commits this command would land" where no command is offered.

### Fixed

- **The tooling stopped teaching a command that does not exist** (`t-5a9544`).
  The former npm indirection for Dev Host passed a leading separator, so the CLI answered
  `unknown command '--'`. `t-6e2e44` had consolidated the dogfood surface on 2026-07-30, and that separator became a literal
  argument. **Broken for ten days across ~100 references** — 20 in the dev-host runbook, 15 in the
  CLI's own help, 10 in `point`'s output, and one in `docs/project-guidance.md`, which goes into every
  agent's brief. The tool printed the wrong form and everything copied it.

  Fixed with **one line** in `scripts/dogfood/run.mjs` — drop a leading `--` — so all ~100 existing
  references work again untouched. Rewriting a hundred call sites to accommodate a parser would have
  been the wrong repair. A test asserts both spellings resolve identically.

### Internal

- **The packaged manifest stopped carrying the development environment** (`t-e995dd`). Every installed
  VSIX shipped all 27 npm scripts — `dogfood`, `release`, `runtime:remeasure`, and a
  `vscode:prepublish` that means nothing in an already-published package. `vsce` now reads a
  product-only manifest while the repository's own file is restored byte-for-byte. Recovery runs on
  **entry**, not in a `finally`: a `finally` does not run on SIGKILL, and a crash mid-package would
  otherwise leave a tracked file mutated.

- **Runbooks** — `docs/runbooks/plugins.md` is new (create, update and publish a plugin; publishing is
  cutting the tag, not pushing `main`). `docs/runbooks/dev-host.md` gained the fixture rules: what a
  fixture can seed, and that **managed worktrees cannot be seeded** — a registry entry whose path does
  not exist is reconciled to `abandoned` on load, so checking one in marks its own entries abandoned.
  That gap is why a Dev Host armed for this release's own feature opened an empty screen.

## 0.74.0 — a surface nobody opened is gone, and the ones that stayed stop lying about themselves

The theme is the same as 0.73.0, one layer down: names, comments and signatures that describe
machinery which no longer exists. Five of them were found and fixed in a single day, so they are
listed as a class rather than as isolated fixes.

### Removed

- **The Execution graph, entirely** (`t-af240d`). 62 files, 5443 lines: five modules, three surfaces,
  fourteen test files, the Control tile and every registration. **Measured before removing** — the
  ledger in this workspace held 814 entries, 36 `measured` and 778 `unproven`. The 778 were honest by
  construction (a Bridge call has no child process to carry an id); the defect was proportion. The 36
  proven spawns that justified the surface were buried under telemetry it could never promote, and the
  filters offered Turn/State/Type/Agent — no filter on attribution, the one axis that separates them.
  It had no Bridge tool: Interface-only, and never opened.

  The one real risk was measured, not assumed: `TACHYON_EXECUTION_ID` and `TACHYON_EXECUTION_AGENT`
  were injected into every spawned agent's environment. Nothing read them.

- **The unreachable restart GC** (`t-3e7153`). `toolTransaction.ts` claimed in its header that
  in-process rollback was "backed by recover-on-restart". It was not — `gcAbandonedTransactions` had
  four test callers and none in production. Wiring it was the obvious fix and measurement refused it:
  the collector guarded only the directory UID, never `meta.pid` liveness, so a startup in one window
  could delete an active transaction belonging to another. The function and the claim both go; the
  in-process rollback stays.

### Fixed

- **Persistent instructions can be written, and they reach the agent** (`t-d48775`). Reported twice by
  the maintainer. The textarea was `disabled` for every agent the studio can load, under a hint
  promising a "dedicated profile binding". **Both halves were missing**: the only writer of
  `prompt.instructions` in the whole product was the portable-bundle importer, and the projection
  *refused* the key outright — so the one existing door produced a profile that fell off the roster.
  The text now lives in `prompt.instructions` pinned to `instructions.md`, written through the same
  lifecycle transaction as the rest of the form, and the round trip is held by a test: write, restart,
  read back, and reach the agent's launch.

- **The completion doorbell stops expiring** (`t-93bec9`). `notify_agent` delivers on the recipient's
  working→idle edge with an empty composer, inside a 10-minute TTL. Those conditions are
  anti-correlated for a coordinator: it goes idle exactly when the human is about to type, into its
  pane. Two of three completion reports were lost in one afternoon. `agent-authored` notices — reports
  of what already happened — no longer expire; `host-poke` notices, which assert live state, keep the
  TTL. The distinction already existed in the type; only the TTL treated them alike.

- **The browser gate sees what the suite actually reads** (`t-fbd2ce`). Root discovery followed only
  the imports written in `test/browser/` files — one level. `src/tasks/` never entered, though the
  board app imports `boardModel` from it, so a change to a card's visual affordance shipped with zero
  browser tests. Now depth 2, chosen as the first depth that covers the real case: 11 roots at depth 1,
  22 at depth 2, 26 at depth 3. Still conditional — a docs-only change still runs none.

- **Cost inputs shared, with the divergence declared** (`t-f60468`). Four sizing constants and `envInt`
  existed twice, read the same environment variables, and disagreed on the floor. The disagreement
  turned out to be **intentional** — the free-RAM sizer protects a lone worker at 128MB while the
  host-wide ledger pairs its marginal term with a separately measured fixed charge. The shared inputs
  moved to `shared/`; the ledger's floor got a name, `VITEST_LEDGER_MIN_WORKER_MB`. No effective value
  changed for any operator.

### Changed

- **Overview and Engine are one screen, System** (`t-7b92bd`, SDD 500). They were never two subjects:
  `model.ts` read Overview's counters straight off the object Engine rendered row by row, in the same
  function. The summary now derives from the rows on screen, so no state exists where the counter and
  the card disagree — the one real instance of that being `workspaceCount`, which counts the window and
  now says so.

- **A task's ownership is a ledger, not a field** (`t-a5b9b9`, SDD 499). `assignee` meant two things
  by status: who is executing, and — once landed/done — **who delivered**. The board rendered
  `delivered by`, and self-evolution hung its whole chain off it. Attempts now append to
  `.tachyon/tasks/<id>.attempts`; `currentAssignee` and `lastDeliverer` are derived at read time and
  never persisted. 1051 historical assignees were backfilled, each line declaring itself a backfill
  with a timestamp marked as inferred rather than observed.

- **`reconcile_landed`, and three tools renamed** (`t-77c95c`). The board was the only domain with no
  sweep verb: 190 finished tasks needed 190 calls to close. The new tool follows the existing
  `reconcile_*` shape, defaults to `dry_run`, and journals the individual proven SHA per task — a sweep
  with weak proof would institutionalise the one case where a task was closed with its deliverable
  never merged. `worktree_hygiene`, `worktree_process_hygiene` and `reconcile_worktree_hygiene` became
  `worktree_audit`, `worktree_processes` and `reconcile_worktrees`.

### Internal

- **`src/cockpit/` dissolved** (`t-5a0c1c`). A directory named after the Control surface, which has not
  existed since SDD 485. Thirteen files went to their measured owners, one commit each; the shared
  vocabulary went to `src/sections/` and lost the `Cockpit` prefix. Along the way it surfaced a
  structural fact worth keeping: moving domain code into `src/webview/` changes which typecheck program
  it belongs to, and that program resolves modules differently — an untouched file broke because it
  changed programs, not content.

- **Nine comments stopped describing the removed Execution graph** (`t-2ef65c`). The removal proved
  zero *symbol* residue; comments have no symbols. Sentences claiming a minted turn id, an
  `InternalOperation` sink, and an id carried into the child's environment all described machinery that
  was gone. Rewritten where the reason survived, deleted where it did not. A dead parameter and a
  return type that always returned `undefined` went with them. SDD 480 is marked `abandoned`.

## 0.73.0 — the product stops asserting facts it never observed

Three fixes, one shape: code that wrote down a second fact after observing a first one. A dead process
became "the work was not done". An unreadable directory became "dependencies are fine". A hand-copied
algorithm became "these two files still agree".

### Fixed

- **Process death no longer claims the work was not done** (`t-49d7ec`). `returnUnavailableAgentClaims`
  observed one fact — this agent is no longer executing — and wrote two: that, plus "the task went back
  to triage". **Measured cost: 25 of 68 triaged tasks had already been delivered and merged**, sitting
  in `triaged` because the agent was dismissed after the merge.

  Five different events came through one door — explicit kill, absence at startup, clean `exited (0)`,
  requested stop, and disappearance — and the evidence string already told them apart, unread.

  What forced it: the store refused `active` without an assignee, so clearing the owner — the only
  proven fact — dragged the lane with it. Now `active` without an assignee is legal and means *claimed
  work, nobody executing*. The assignee is cleared because it names the executor that vanished;
  `awaitingHuman` and `evolutionCompletion` are **kept**, because waiting on a human and owing a review
  are not facts about the dead process. `nextTask` and the board's dimming both treat it as claimable,
  and a real crash still frees the claim — each held by a test.

- **"I could not measure" stops being recorded as "everything is fine"** (`t-7681c1`). The refusal that
  guards verification proof wrapped everything in `catch { return null }`, and `null` means *write the
  record*. Worse, that catch was load-bearing for the normal path: a missing `node_modules` throws
  ENOENT. Each throwing call was measured, then the answer became an explicit refusal naming the error.
  Only ENOENT of `node_modules` or of a lockfile still means "does not apply".

- **The last hand-maintained copy is gone** (`t-da6b78`). `scripts/host-resources.mjs` was an ESM twin
  of `src/host/hostResources.ts`, kept in sync by human memory — and it had already cost one defect
  (`t-0b7aa7`, a refusal reporting `0` workers as if it were a measurement). The algorithm now lives
  once in `shared/host-resource-sizing.cjs`; the `.mjs` was deleted. The regression is held by a test
  comparing **function identity**, not names: a faithful re-declaration that delegates to the shared
  module passes `tsc` and every other test, and fails only that one.

### Internal

- **Audit: machinery with no inlet** (`t-e50995`). 145 exported symbols with test callers and no
  production caller were judged; **5 are real missing inlets**, 140 dismissed with a reason. Method was
  TypeScript AST plus both bundles as an independent second signal, never grep alone. The worst is
  `gcAbandonedTransactions`: `ToolTransaction.begin` runs in production and the file header states that
  in-process rollback is backed by recover-on-restart. It is not — an interrupted provisioning
  transaction is orphaned forever. Follow-ups filed, nothing removed.

## 0.72.0 — the project declares what it shares, and the proof refuses to be written when it would lie

Tachyon stops having an opinion about your ecosystem. It also stops telling agents about their
dependencies, which is fine, because a sentence in a brief was never the mechanism — and the actual
mechanism ships here.

### Changed

- **Worktree sharing is declared, not inferred** (`t-5ac1df`, `t-9989cb`). Two lists, following Orca's
  shape after reading their source: `settings.worktree.sharedDirectories` symlinks, `.worktreeinclude`
  copies. They stay separate because copying and sharing are different decisions, and one list with a
  per-entry mode invites getting the default wrong. **No product default** — held by a test that shares
  nothing without a declaration, then symlinks a declared directory in a project with no Node lockfile.
  A PHP project declares `vendor/`, a Rust project `target/`.

  Admission follows Orca's rule: the path must exist, be untracked, and be gitignored. Absent, tracked,
  a glob, a negation or an unsafe path **warns and is skipped** — invalid config never blocks a launch.

  Not copied from them, deliberately: Orca has no divergence detection at all, which is why an
  `npm install` in one of their worktrees silently affects the others. Our SHA-256 over the lockfile
  bytes stays, as a `node_modules` special case, with the limit written into the code — other
  ecosystems share without detection until someone says how to detect.

- **The dependency line left the primer.** It read "node_modules is a symlink to the primary checkout"
  in a PHP project, and its purpose had already died: it existed to warn an agent not to reinstall
  before running the checks the primer used to name, and those checks left in 0.70.0. Orca injects
  nothing of the kind either. The state is still *computed* — link, don't link, undo. What stopped is
  *telling the agent about it*.

- **A run with unclaimable inputs produces no record** (`t-274be9`). This is the mechanism the removed
  sentence was standing in for. When a worktree's `node_modules` is a symlink into the primary checkout
  **and** the two lockfile sets disagree, `verify:full` runs to the end, prints its green, and then
  declines to file the proof — naming which lockfile diverged. Green on screen is not evidence; the
  record is, and the product's only real power is to refuse to write one.

  It refuses narrowly, and each exemption has a test: an owned `node_modules` records, a link pointing
  anywhere else records, identical lockfiles record, and **no lockfile on either side records** — which
  is what keeps non-Node projects working.

### Internal

- **The product stops depending on the tooling folder** (`t-04dfe3`). `src/` was importing from
  `scripts/`, i.e. the extension depended on the development environment. The shared contracts moved to
  a new top-level `shared/`, byte-identical via `git mv`. CommonJS is forced, not chosen: `src` compiles
  as CJS and cannot import `.mjs`, and an `.mjs` run by bare `node` cannot import `.ts`. Both dependency
  rules — the lockfile fingerprint and the divergence reason — now have exactly one definition, consumed
  by the extension and the gate alike.

## 0.71.0 — Soul and Role are gone, and proof of a green run is now a git ref

Ten thousand lines leave in this release, and what they have in common is that nobody was using
them. An agent no longer has a persona or a job title; a verification record is no longer a file only
this repository knows how to write.

### Removed

- **Soul and Role, entirely** (`t-77caa7`). Soul resolution, its lifecycle, its legacy capture, its
  whole transaction subsystem; Role templates and every Role surface in config, runtime, the Bridge,
  the sidebar, Agent Studio, the profile, the schema, the brief and localization. 163 files, ~9,900
  lines net. No migration was written and none was needed: **measured before removing** — no
  `SOUL.md` anywhere under `.tachyon/agents/`, and no agent declaring `role:`. A profile that still
  declares either loads with a warning like any other unknown key.

  What an agent's brief keeps, in this order, now held by a test rather than by hope: persistent
  instructions (with their formation receipt), Evolution, selected memory, the Bridge-guidance line,
  the spawn contract, and the work record. What it loses: the identity section and the role template.

  One thing that lived in the wrong file and survived: the line telling an agent that its CLI's own
  sub-agents run work Tachyon cannot see. That is a fact about Tachyon, not a persona, and it moved
  house rather than dying.

  A defect died with the subsystem rather than being fixed: the Soul transaction could leave a
  directory with no journal, which was then read as a synthetic degraded record matching every
  principal and skipped by reconcile forever. It has nowhere left to happen.

### Changed

- **A verification record is a git ref, not a file** (`t-23c92e`, SDD 497 slice 1). The per-tree proof
  moved from `<git-common-dir>/tachyon-verify/<tree>.json` to `refs/tachyon/verify/<tree>`, pointing
  at a blob with the same JSON. Writer and reader flipped in one commit, and the file path was
  deleted rather than kept as a fallback.

  The reason is not tidiness. The old file was already stored in the common directory so that a gate
  running inside an agent's worktree could be read from the primary checkout. A ref lives in that same
  place and adds the one thing a file cannot have: **it can be pushed and fetched.** That is what will
  let any CI publish the proof with nothing but `git` — no forge API, no token, no artifact download —
  so that a project gets a working land door without adopting a Tachyon script. The rest of that work
  is specified in `docs/specs/497-verify-evidence-by-ref/`.

  Two things were proved before the change was accepted, because either could have sunk it: a record
  published inside a linked worktree is readable from the primary, and a ref pointing at a blob
  survives both `git gc --prune=now` and a push with its object id and type intact.

  Consequence you may see once: records written by earlier builds are invisible, so the land panel's
  `verified-tree` reads red until the next gate run publishes a ref.

- **Board is the only name for the board, in the code too.** The tombstone viewType from before the
  0.65 reversal is deleted rather than renamed; nothing on disk referenced it.

## 0.70.0 — Tachyon stops running your checks

Running a command is something an agent and a CI can both already do. Holding the proof of what was
run, about which content, is something only the orchestrator is placed to do. Tachyon was doing both
and doing the first one badly, so this release removes it: **the product no longer executes a
verification command anywhere.** What stays is the part that was load-bearing — reading evidence.

Two config keys are gone, and they were failing in opposite directions. `settings.verify` was
presented as configuration and executed by nothing; its four commands only ever became sentences in
an agent's brief, and two of them (`prepare`, `affected`) did not even reach that. Meanwhile
`settings.worktree.verify` — the one the product really ran — was never shown to the agent it
applied to. The key that only talked called itself config; the key that acted was invisible.

### Removed

- **`settings.verify` and everything downstream of it.** Four subkeys, the schema, the primer lines
  they produced. A file that still declares the block loads with a warning, like any other unknown
  key — nothing breaks, because nothing executed it in the first place. Gone with it: the line
  telling every agent that "verification applies only when delivering repository changes". That was
  a **cadence** decision, and it belonged to the project, not to a block of the brief that declares
  itself un-overridable. Its stated justification was a mutex inside *this* repository's own gate
  script — our host economics, broadcast to every project as protocol.

- **The verify gate the product ran** (`t-6ca846`). `settings.worktree.verify`, per-agent `verify:`,
  the `verify_agent` tool, the verify badge and its recorded verdict, the field in Agent Studio, the
  `verification` command kind, the verify summary in the PR body, and the pipeline done-contract that
  could wait on a "verify gate". 131 files, ~1,800 lines net. **If you declared either verify key,
  Tachyon will no longer run it for you** — declare it in your CI, or run it in the agent's shell.

### Kept, deliberately

- **The evidence path is untouched.** The per-tree verification record, the land preconditions that
  read it, and the agent-completion signal that reads it all work exactly as before. This release
  removes the *producer* the product owned; it does not touch what consumes proof. The distinction
  worth keeping in mind: what left ran a command and recorded a verdict against a **commit**; what
  stayed reads a record about a **tree**.

- **"A check attests the exact TREE it ran on."** That sentence lived inside the block being deleted
  and would have died by accident. It is a fact about how proof works here, not a policy about when
  to run one, so it now renders unconditionally.

- **The dependency line in the brief.** It still tells an agent whether the checkout it was handed
  has, links, or lacks its dependencies. Only the install hint — which came from the removed config
  — is gone.

Where this is going, for anyone reading the direction rather than the diff: evidence should be
publishable by any CI with nothing but `git`, so that a project gets a working land door without
adopting a Tachyon script. That work is specified in `docs/specs/497-verify-evidence-by-ref/`.

## 0.69.0 — One name for the board, and a proof that has to still be worth something

Two changes that look unrelated and are the same idea: a thing should not be called two names, and
a green should not outlive what made it green. The screen you use has said **Board** since 0.65;
the code behind it still said Mission Control in 95 files. And the land panel was lighting up
`verified` on evidence that the verification gate itself would have thrown away.

### Changed

- **Mission Control is gone; it is the Board, everywhere** (`t-209516`). The label never changed —
  the command has read "Tachyon: Board" for releases — but the code carried a second vocabulary for
  the same screen, and two names for one thing is a tax on everyone who reads it later. 95 files, 17
  of them moved. The one thing you may notice: the command id is now `tachyon.board` instead of
  `tachyon.missionControl`, so a keybinding pointing at the old id needs updating. Nothing else about
  the screen, its state, or its behaviour changed — the release exists to make that claim testable.
  Old records keep the old name on purpose: shipped specs and past release notes describe what was
  true when they were written, and rewriting them would be falsifying a log.

### Fixed

- **The land panel stops accepting proof the gate itself refuses** (`t-40e655`). Three parts of
  Tachyon consult the same verification record and, until now, three of them meant different things
  by "verified". The strictest is the gate deciding whether it may skip work: it demands a record
  that names the environment that produced it, is not from the future, and is not older than a week.
  The loosest was the one arming the `git merge` command a human copies out of the Worktrees panel —
  it checked only that a file existed with the right name. A record the gate would have discarded
  could still turn that check green. It cannot now: stale, future-dated and unattributable records
  are refused at the reader, so every consumer inherits one definition. The environment comparison
  deliberately did **not** move: it is a question only the side that knows the producing environment
  can answer honestly, and the extension host is not that side. The same hardening reaches agent
  completion, which no longer treats an old or unattributable green as evidence that an agent
  delivered.

## 0.68.0 — The fleet leaves the config file, and the form stops lying

`tachyon.yml` is closer to being only configuration: your agents are the directories under
`.tachyon/agents/`, not a list in a file. And four controls in Agent Studio that looked usable and
were not — a field that discarded what you typed, two that were permanently greyed out, one whose
runtime the save would refuse — now either work or are gone. Every one of these was found by asking
the same question of a screen: is there anything here that promises something the code behind it
does not do?

### Changed

- **Your fleet is the directory, not the file** (`t-ae221c`). A folder under `.tachyon/agents/` with
  a readable `agent.yml` **is** an agent. The `agents:` block in `tachyon.yml` is no longer the
  source; a file that still has one loads normally, with a warning saying the block is ignored and
  can be deleted. Nothing rewrites your file for you. The pointer it replaced carried no information
  — it was required to be exactly the path derived from the name — so reading the directory gives the
  same answer with 174 fewer lines of code. Creating, renaming and forgetting an agent stopped being
  two-file transactions, and the whole class of failure "the profile was written but the pointer was
  not" no longer exists. One cost, stated rather than buried: deleting `.tachyon/agents/<name>/` by
  hand used to remove an orphan pointer that had a Forget door; now it deletes **the agent**, and
  what remains is a stranded authority with no door. That is inherent to "the directory is the
  agent".

### Fixed

- **Verify and Setup can finally be set on an agent** (`t-afc86e`). Both fields were rendered
  permanently read-only under a hint promising a binding that no work item carried. They now hold a
  per-agent verify command and per-agent setup commands. This nearly went the other way: the
  recommendation was to delete the controls, which was reasoning from this repository — one test
  suite, and dependency-linking that makes setup unnecessary. In a monorepo a per-agent verify is
  close to mandatory, and outside Node — venv, compilation, module download, codegen, migrations —
  setup is the mechanism, not a luxury. Fixing it exposed something older: the channel that writes
  profile files was **write-once**. Every artifact had been new by construction, so the second save
  of the same field threw. It is now a CAS-guarded replace whose rollback restores the previous
  bytes instead of deleting them.
- **The self-evolution toggle works, and can be switched back off** (`t-f96b2f`). It was greyed out
  while the machinery behind it was complete and had no callers at all. Wiring it up revealed that
  the **off** path did not exist anywhere — and it is not optional: leaving the reference behind
  makes the profile refuse to load, so an agent that enabled evolution and changed its mind would
  stop loading. Turning it on without being able to turn it off would have shipped exactly the defect
  this release exists to remove. A proposal, separately, can never grant evolution: creation refuses
  it explicitly instead of granting it silently.
- **Creating an agent on a runtime Tachyon cannot attest is refused, not offered** (`t-d68b8b`).
  Quick Add showed the chip and the save then refused it, sending you back to the form you were
  already in. Creation is limited to the attested runtimes — claude, codex, grok, pi — and the
  refusal says the limit belongs to the creation path, not to the runtime. The list is read, never
  copied, so attesting a runtime opens the form with no further edit. There were **two** doors, not
  one: an agent proposing a saved agent could name any runtime as free text.
- **Watch patterns is gone from agents** (`t-bd14d8`). It restarts the process when files change,
  which is what a terminal wants and the opposite of what an agent wants: a file save killed the
  session outright and started a new one, with no resume. Removing the field was not enough — a value
  already stored survived every subsequent edit untouched, so the first save now clears it.
- **A terminal is no longer matched against Claude Code's prompts** (`t-c59600`). Terminals declare
  no runtime, and the default filled in `claude`, so `npm install` asking `Ok to proceed? (y)` was
  compared against the patterns of an LLM interface. Neutral is now a scope of its own rather than a
  runtime with fewer patterns. Measured loss: none. Measured gain: eight real shell prompts.

### Internal

- **SDD 496 — the agent/terminal split, planned** (`t-91564a`). The measurement overturned the
  premise: the two types were separated a while ago, and what was never separated is the
  *collection*, which hands out both and makes every consumer ask again. 76 live branches, sorted
  into 28 that become dispatch, 20 that are dead code, and 28 that are legitimate. Five slices, each
  shippable alone.

## 0.67.0 — Stopping, starting, and being told what to do about it

Four things you press and one thing you read. Stop now stops, and stops looking like a crash. A
crash-restart comes back remembering. A launch refused for a missing login hands you the login
instead of a line in the status bar. Three of the four defects here were diagnosed wrong before they
were fixed — the corrections are recorded beside them, because a wrong cause that produces a working
fix is a trap for whoever reads this next.

### Fixed

- **The Stop button now stops Claude** (`t-ab2682`). Three graceful stops in four left the process
  alive, and thirty seconds later Tachyon forced a kill — which takes the session down instead of
  letting the runtime close itself. It exits cleanly in 11 of 11 runs now. The recorded cause was
  wrong and the measurement overturned it: the slash-command menu never swallowed the Enter. `/exit`
  was typed into a composer that still held the agent's spawn brief, and the pair went to the model
  as a prompt. The composer looking empty afterwards — the thing that made this read as a lost Enter
  — was the brief losing the race. The obvious fix was tried and **rejected on evidence**: a fixed
  600 ms delay failed at exactly the old rate, 3 in 4, while a 6–13 ms gap into a free composer
  succeeded 13 of 13. Time was never the variable. The rule is now composer occupancy: type only
  into a composer proven free, press Enter only while it proves it holds exactly that text. The
  defect was in the delivery mechanism, not in Claude's stop profile, which was right all along.
- **Stopping an agent no longer looks like it crashed** (`t-9d76b1`). You stopped `grok` and the row
  went red: `exited (130)`, the same badge an agent that died on its own gets — with `resumable`
  right beside it, one badge saying it broke and the other saying everything is fine. 130 is
  128+SIGINT: the *correct* exit of a process that honoured the Ctrl+C Tachyon itself sent. The
  product was asking one question — "was the exit code zero?" — and using the answer for a different
  one: "did this die, or did I stop it?". The intent was never in the number, and no adjustment to
  the number could put it there. Tachyon now *remembers* asking. A stop you ordered reads `stopped`,
  keeps the real exit code beside it instead of a fabricated `exited (0)`, and keeps its pane open
  for inspection; the memory survives a window reload, and the next start forgets it, so one
  instance's ending never describes the next. A genuine crash still reads as a crash — including one
  that happens to exit 130, which is exactly what a special case for that number would have erased.
  The Activity record stops calling an ordered stop a *failure*, and — the part that was worse than
  cosmetic — an agent with `restart: on-crash` is no longer resurrected seconds after you stopped it.
  Measured on all six runtimes rather than assumed symmetric (`node scripts/dogfood/run.mjs stop-exit-codes`):
  grok and hermes answer a requested stop with 130, codex, opencode and pi with 0. One more finding
  came out of running it more than once: claude's stop only *sometimes* stops claude — three failures
  in four runs — which is why a single earlier measurement called it fine. Filed as `t-ab2682`, marked
  honestly in `docs/runtimes/parity.md` row 7, and not papered over here.
- **An agent that crashes and restarts comes back remembering** (`t-f6aa7c`). With `restart: on-crash`
  it used to come back on a brand-new session: hours of context gone, and you found out when it asked
  something already answered. It now resumes. When there is nothing to resume — a first crash, an
  aged-out transcript, a runtime with no resume — it opens a fresh session **and says which of those
  it was**, instead of leaving you to infer it from behaviour. A terminal still comes back blank,
  which is correct: `bun run dev` has no memory to keep. The prior choice turned out not to be a
  choice: spec 389 recorded the crash case as "unchanged" and listed auto-resume on crash as a
  non-goal, so nobody decided this — it was deferred and became behaviour by omission.
- **A launch refused for a missing login hands you the login** (`t-2656d7`, SDD 495). You started a
  Grok agent and the status bar said `no credentials at /home/gc` before erasing itself. The rest of
  that sentence — `run grok login first` — was past the clip, so you concluded Grok was unsupported.
  Tachyon knew the answer and printed it where sentences cannot be read. The refusal is now a
  persistent notice naming the runtime and the agent, carrying a **Log in** button that runs that
  runtime's own login in an editor-tab terminal you can type into, and a **Retry** you press when you
  are ready — Tachyon does not start the agent for you. The whole defect was an empty actions array:
  with one, the same channel produces a notice that waits; with none, it produces eight seconds of
  status bar. That invariant is now a pure function asserted for every runtime, so an edit that drops
  the actions fails a test instead of quietly returning to the status bar.

### Internal

- **Tests that pin an address instead of a rule** (`t-60fcfc`, `t-c189ba`). A test pinned
  `Workspace.ts:3527`. That file has ~6900 lines, so any edit above that point — on any subject —
  turned it red, and in one day it produced two false failures and a merge conflict between two
  agents working in unrelated regions. A test states a rule; a line number is the rule's address
  today. 776 tests were swept; one more was genuinely broken and is fixed: it counted three
  occurrences of a crash-reporter switch, which went red on a correct fourth configuration and stayed
  green on one that dropped the switch — wrong in both directions at once.

## 0.66.0 — Nothing is left behind, and nothing you cannot undo

An operation that fails in the middle used to leave state nobody cleans and nobody can name. Six
of them are closed here, found by one measurement that went looking for the shape rather than for
a bug. The rule that closes most of them is the same: let the thing that owns the state say no —
`rmdir` refuses a directory that is not empty, and `git worktree remove` refuses a checkout with
work inside. A refusal from the kernel or from Git cannot be raced; a check written in front of a
delete can.

### Fixed

- **A launch that fails no longer strands the agent, and you can unstick it yourself** (`t-d29398`).
  Starting an agent creates its checkout and locks it while it prepares. When preparation failed —
  a missing runtime credential, say — the lock stayed. Fixing the real cause was not enough: every
  later attempt was refused because of the first attempt's own residue, with an instruction to
  "unlock explicitly" that the product offered no way to carry out. Now the failing launch discards
  the checkout it just created and never delivered, and Control → Worktrees has **Release lock**,
  which shows what is inside — commits, uncommitted changes — before anything is released. The five
  refusals that used to give an impossible order now point there, and they distinguish Tachyon's own
  interrupted-launch quarantine from a lock a human placed.
- **Removing an agent stops leaving the shell of its folder behind** (`t-4a1f85`, `t-8b58b3`). Two
  removal paths deleted the contents of a profile home and left the directory: one unlinked
  `agent.yml`, the other removed only the `evolution/` subfolder. And the one sweep that reads that
  directory *enumerated* it and then *measured a file inside it*, so residue it had just listed came
  back as "absent: there is nothing to remove" — a false negative delivered as proof. The sweep now
  names it, and the refusal hands over the one command that tells empty residue from real work by
  refusing.
- **Deleting a declared terminal cleans its footprint** (`t-af4a5f`). The roster row was deleted
  first and the footprint second, with no journal between them, and no startup reconcile that could
  ever revisit it. The order is inverted: the footprint goes first and the address goes last, so an
  interruption leaves an entry that is still listed and still removable instead of debris nobody can
  name.
- **One attempt to give a Soul to a terminal no longer freezes Soul for the whole workspace**
  (`t-359469`). The gate asked "is this name declared?" instead of "is this an agent?", so a
  `terminals:` entry passed. It then died in a place that left a transaction folder with no record
  inside, which the product reads as a broken transaction belonging to *everyone* — and nothing ever
  clears it. Every Soul change in the workspace was refused from then on. The gate now sits at the
  single funnel every mutation passes through, runs before anything touches disk, and its refusal
  says what is actually wrong instead of "not declared in tachyon.yml", which was false.

### Removed

- **The Fleet app is gone; the sidebar's Agents tab is the fleet** (`t-5f2b5b`). The Control tile,
  the editor tab and the "open agents as editor tab" button all go with it. The previous release had
  already made both surfaces render the same roster with the same nine statuses, so the second one
  stopped earning its keep. The guard that matters survived the deletion and got stronger: it still
  forbids the fleet from painting a boolean running/stopped list — the defect where a wedged agent
  read as "Stopped" and one waiting on input read as "Running" — and now also requires the status
  union to stay nine wide, so the defect cannot return by collapsing the type instead of the markup.

### Changed

- **An invalid `tachyon.yml` warns instead of taking the fleet down** (`t-48dd8d`). One mistyped key
  anywhere in the file used to make the whole workspace refuse to load. Now the bad key is discarded,
  a warning names it, and everything else loads. Two failures remain fatal, and only because they
  leave nothing to salvage: bytes that are not YAML, and a root that is not a mapping. Reading
  forgives; writing does not — the product still refuses to save bytes it has just called unreadable.
  There is no exception to the rule: a discarded key falls to its normal default, including where
  that default is the permissive one. That was an explicit decision, and it is pinned by a test so it
  cannot be quietly reversed.

### Internal

- **SDD 495 — runtime login and auth recovery** (`t-9b5457`). A measured proposal, not an
  implementation. It traces why a launch refusal that contained the exact fix never reached the
  human: that branch sends the message to the status bar, which truncates it and then erases it. The
  same condition mid-run passes a button and survives as a dialog. It also corrects a standing
  assumption — the per-runtime "preflight" files check the model catalog, not authentication — and
  measures what each of the three main runtimes really needs to log in.
- **The orphan hunt** (`t-bbe760`). The measurement that found the four residue sources above, with
  every origin traced to a line, a verdict in three lists including "could not decide", and two
  reproductions that run.

## 0.65.0 — The screens say what they know, and stop hiding what they don't

Every change here shortens the distance between something being true and you being able to see it.
A refusal that names the field. A merge command that shows what proved it. A history that admits
when nobody can prove a human decided.

### Added
- **The tmux app opens on the project you selected in the sidebar** (`t-6b5dea`), and says what it
  hid. Its universe is larger than the other apps': it lists sessions from closed folders and other
  windows, which no attached-project selector can name — and those are exactly the ones you open
  tmux to find when something went wrong. So a default nobody chose declares that it narrowed the
  screen, names the project, counts what is held back, and carries the way out with it. The
  disclosure disappears the moment you pick a project by hand.
- **The Human Inbox shows what you already decided** (`t-cede16`), filtered by state, type, result,
  period and search. Each line names who resolved it — including when the honest answer is
  `unattributed:vscode-command`, which means nobody could prove a human did. The screen does not
  invent a name.
- **The worktrees panel hands you the land command, already checked** (`t-7cb971`). Five
  preconditions, each showing what proved it. When one is unproved the command is withheld, because
  one that would fail wastes your time and one that would succeed would land something nobody
  verified. Each refusal carries a Fix line, and distinguishes *not measured* from *not true* — a
  refusal that names the wrong reason sends you to fix the wrong thing. The product still never
  moves the trunk, and a source guard refuses any `git` call under `src/` that passes `merge` or
  `--ff-only`.
- **`npm run runtime:remeasure`** (`t-0ac2e9`) re-measures four runtime facts compiled into the
  product. Three hold; native-memory suppression reports **NOT MEASURED**, with the reason — proving
  it needs two authenticated, quota-consuming sessions, and feature status is not evidence of
  consequence.
- **Design Mode edits are persisted** (`t-9d3919`). When the agent proposes a change it can send the
  patch — summary, files, diff — and the host validates and records it, so what changed outlives the
  page.

### Fixed
- **The sidebar names the field that overflowed** (`t-74274c`). It used to show eighty characters of
  clipped JSON; now the status bar reads `fleet.agents[3].focus.full is too_big` and the full issue
  goes to an Output channel. The measurement behind this was taken on the coordinator: a whole
  session spent grepping for a field the error already knew.
- **Whoever you declared owner of a Saved Agent can stop it again** (`t-b5f896`). Lifecycle scope
  read runtime lineage only, and activating a Saved Agent does not create a parent edge. Roster
  ownership is now a separate question, never converted into lineage, so the governance that refuses
  siblings and unrelated members is unchanged.
- **With two windows or two folders, the Integrated Browser stops picking the wrong one**
  (`t-464e2d`). Five measured breaks, including one that mattered: the window singleton was pinned
  to the first workspace folder while config followed the active one, so you could enable and open
  in B while it published and used A.
- **Dismissing an agent stops leaving its runtime home on disk** (`t-7bc276`). Grok and hermes
  materialize that home as a directory while claude and opencode write a file, and both sweeps only
  knew about files — so 35 dismissed agents had reached 2.2 GB. One constant now feeds both the path
  where a home is created and the scan that finds it, and dismissal reports the size it removed.
- **The documented onboarding path loads again** (`t-fe772a`). `tachyon.yml.example` declared an
  agent in a retired inline form, so copying it produced a config the loader refuses. The durable
  fix is the test: the example is now loaded through the production loader on every run.
- **The Saved Agent proposal screen is a decision document** (`t-d343ab`). The digest is shown in
  full instead of truncated — a clipped digest verifies nothing — the facts align in a column, and
  "created enabled; **not** started" has its own callout instead of being lost in prose.
- **The product stops promising a backup it never wrote** (`t-173b96`). Nothing in the codebase ever
  created or read `~/.local/share/tachyon-backups/`; two comments advertised it as if it were a
  feature. The comments now declare the absence, because `tachyon.yml` is not versioned, the product
  writes to it, and losing it costs the whole roster.

### Internal
- **A source guard stops a script from killing the fleet's tmux server** (`t-6ef951`, `t-9713ff`).
  tmux resolves the server from `$TMUX` before it looks at `$TMUX_TMPDIR`, so a script running
  inside a fleet pane that sets only the tmpdir and believes it isolated takes every live agent down
  — which happened three times in three hours. The rule the guard enforces: an invocation is safe if
  it passes `-L <its own socket>` **or** clears `TMUX`; neither reaches the fleet. It parses the
  syntax tree rather than matching text, because the mold it followed matches identifiers inside
  comments and broke `main` twice the same day.
- **The `resolvedBy` guard stops counting reads as writes** (`t-45db7d`). It scanned for the field
  name and flagged a view model that only displays the value; it now finds the write doors through
  the `resolveApproval` import, which also tells a port from a door.
- **`docs/specs/488-ide-browser-design-mode/hybrid-d-path.md`** (`t-d49ef0`) plans the route to the
  ratified destination, and settles the argument with a measurement: nine of the ten pieces of
  visible Design Mode state are destroyed by any in-page link click, and the host sends none of them
  back. Seven decisions are named for the maintainer rather than taken.

## 0.64.0 — What the product creates, it can now read, show and undo

The theme of this release is one class of defect, found four times in one day: Tachyon could
create state it then refused to load, display or remove.

### Fixed
- **A valid `spawn_agent` brief no longer takes the whole workspace down** (`t-a11ac5`). The tool
  capped `instructions` at 2000 on the way IN, then stored the *composed* brief — primer plus
  instructions — with no cap, and the loader refused it on the way OUT. The workspace did not
  degrade: it reported "No Tachyon workspace" and took `verify`, `projectGuidance`, `maxAgents`
  and auth down with the fleet. Size policy now lives in one module that both the projection and
  the tool schemas import, oversized display prose degrades per field, and identities that must
  match exactly are never truncated.
- **A correctly refused Saved Agent can be removed again** (`t-02e72c`, SDD 494). A refusal
  dropped the agent from `config.agents`, and all three removal doors asked `config.agents`
  whether it existed — so Forget hung on "Computing what this will do…" forever. Membership and
  runnability no longer share one map.
- **Creating an agent no longer fails on a leftover directory** (`t-760d53`). A path that exists
  but is not a Git checkout was reported as a preserved quarantine lock. It now says what it is
  and that removing it is safe.
- `${PLUGIN_ROOT}` is substituted when a plugin's MCP server is rendered (`t-b6180e`). Latent —
  0 of 15 installed plugins use it — and the un-merge stays exactly reversible.
- The continuity brief stops re-ingesting Tachyon's own framing (`t-fe9fca`). A stored `STALE:`
  prefix used to make a freshly written brief claim forever that it was behind.

### Added
- **`reconcile_roster`** names which records disagree about a Saved Agent, and **which door would
  remove it** (`t-6c029b`, SDD 494 Part 4). Five states derived from four presence facts; nothing
  stored.
- **`worktree_processes`** reports processes that outlived their worktree (`t-1926ce`). It
  reports only — killing another process stays the human's. Post-dismiss retention is now
  disclosed before you dismiss, including that it differs per runtime (`t-23ee99`).
- The packaged VSIX smoke now opens a door **with the engine running**, on an Electron extension
  host (`t-a8e1f7`). This is the half that was uncovered when 0.57.0 shipped broken past two
  reviews and a green gate.
- Runtime Ops shows the CLI version a behavior was measured on against the one on `PATH` —
  match, drift, or unknown (`t-1322b5`).
- `claim_task` accepts several task ids, all-or-nothing, and rolls back every claim if a later
  one or the launch fails (`t-66c4d7`).

### Changed
- `exit-empty` is reserved and forced off (`t-9713ff`). A single tmux server hosts the whole
  fleet, and it must not be able to end itself when it briefly holds no sessions.
- `role: custom` in a canonical profile is refused instead of accepted and delivered empty
  (`t-7d8744`).

## 0.63.0 — The engine starts on a local extension host

### Fixed
- **A packaged stable build now starts its engine on a local (non-remote) extension
  host** (`t-d11d57`). `process.execPath` there is the VS Code binary, which is Electron,
  and Electron does not start once copied out of its installation — activation died with
  `EngineSupervisorError` after 12.8s, taking Board, Fleet and Activity with it. Tachyon
  now detects Electron and resolves a real Node from `PATH`, validating each candidate by
  running it: the probe requires `versions.node`, a null `versions.electron`, and the
  candidate's own `process.execPath` to match, so a shim that execs something else is
  rejected by behaviour rather than by name. Remote hosts already had a real Node and are
  unchanged. When no Node is on `PATH` the failure is now a named
  `NODE_RUNTIME_NOT_FOUND` with instructions instead of a timeout.
- **The session panel no longer reports "nothing withheld" to a session that predates a
  gate** (`t-d848e4`). It recomputed from today's lockfile, which answers what the next
  spawn will do — not what this live session received. Sessions born before an install
  now say so, with `restart it to receive the gate`.
- A test asserted 32 unique draws from a 16-bit entropy budget, a ~0.76% false red per
  run (`t-ad8d95`).

### Added
- **`settings.ideBrowser.enabled`** gates the Integrated Browser's human surface and
  call-time execution, with first-use tips (`t-48ff4a`). Off by default. Tool
  registration is deliberately NOT gated: MCP freezes the catalog at connect, so agents
  born before the feature was enabled would otherwise never see the tools.
- **`read_notices`** — a durable read door for `notify_agent` doorbells, so a busy
  recipient can read what it missed instead of depending on having been idle when the
  pane flushed (`t-167b5c`, spec 493).
- `get_continuity` now derives your open tasks and pins at read time instead of asking
  you to hand-copy them, and a stale brief leads with its lag (`t-c35335`).

### Changed
- `role: custom` in a canonical profile is refused instead of accepted and delivered
  empty (`t-7d8744`). It promised instructions that canonical profiles cannot declare.

## 0.56.36 — Memory-aware heavy gates (t-019dac)

### Added
- Auto-size vitest `maxWorkers` from host free RAM (scales up if you add memory).
- Fail-closed refuse for `verify:full` / `verify_task(full)` under memory pressure.
- Runtime Ops summary: `hostMemAvailableMb`, `hostMemTotalMb`, `recommendedVitestWorkers`.

## 0.56.35 — Validations Control view v1 (t-da934e)

### Added
- **Control → Validations**: Approvals-parity card list with expand detail,
  close (outcome+note), claim/assign, filters, store-backed VM (not Mission strip).
- Engine `validation.assign` workspace command for human claim path.

### Fixed
- Preserve `verify:full` → `scripts/verify-full.mjs` (t-6a9bc4 lock + maxWorkers).

## 0.56.34 — Hotfix Mission Loading on Control (t-b87bfe)

### Fixed
- Control → Mission stuck on **Loading Mission Control…**: `buildBoardModel`
  was called with a bare snapshot instead of `{ snapshot }`, throwing once the
  board VM arrived and breaking the whole Cockpit App.

## 0.56.33 — Ship t-b87bfe Validations Control tab

### Fixed
- **0.56.32 package note** landed before the feature merge; **0.56.33** is the
  first build that includes Mission strip removal + Control → Validations tab.

## 0.56.32 — Validations leave Mission for Control tab (t-b87bfe)

### Changed
- **Mission Control** no longer embeds the Validations strip (task board only).
- **Control** gains a **Validations** tab with full queue + close UI.

## 0.56.31 — Design-system --ds-accent + kit tokens (t-df7df5)

### Fixed
- **`--ds-accent`** is now defined (was used across panels but never set).

### Added
- Disabled opacity, shadow, motion, z-index, and scrim tokens in the shared
  design system; reduced-motion zeroes duration tokens.

## 0.56.30 — Control health probe without nonce (t-faa36e upgrade)

### Fixed
- **Engine upgrade bootstrap**: when the control `.nonce` sidecar is missing
  (pre-auth engines), only the read-only `health` op is allowed so the
  supervisor can identity-check and replace; other ops stay fail-closed.

## 0.56.29 — Durable pane transcripts (t-6a6a00)

### Added
- **Per-agent `pipe-pane` transcripts** under `.tachyon/pane-transcripts/`
  (0700/0600). Survives kill-session/reload; read path always strips ANSI and
  runs `redactSecrets`.

## 0.56.28 — Persistent control peer auth (t-faa36e)

### Security
- **Engine control socket** requires a per-daemon 0600 nonce sidecar with
  timing-safe verification before request dispatch (dir perms no longer sole
  auth boundary).

## 0.56.27 — Drop stale queued notify after sender death (t-99ccc9)

### Fixed
- **`notify_agent` queue no longer injects obsolete completion lines** after the
  sender is killed. Sender incarnation metadata is bound into the existing
  NoticeQueue stale-source guard (minimal fix, not a full notification redesign).

## 0.56.26 — Hermetic verify path budget (t-b3ca7e)

### Fixed
- **`verify_task` full suite under deep temp clones.** Shorten clone parent to
  `tv-<12hex>`, set `TMUX_TMPDIR`, and keep restart dogfood sockets short so
  AF_UNIX paths stay under ~108 bytes. DaemonStateStore permission test now
  chmod-forces group bits under restrictive umask.

## 0.56.25 — Requester cancel for pending human approvals

### Added
- **`cancel_human_approval` Bridge tool** (`t-ae89d1`).
  Authenticated requesters can withdraw their own still-pending approval as
  `status=cancelled` with an audit reason — no false Deny, no stale Accept,
  no approve-text injection. Host resolve refuses cancelled records.

## 0.56.24 — Reentrant worktree path lock (prune deadlock)

### Fixed
- **Worktree path mutex is reentrant for nested same-path ops** (`t-3fb6eb`).
  `DeliveryProjectionService.prune` holds the path lock then calls `remove`, which
  re-enters the same mutex; the previous non-reentrant chain deadlocked, hung
  Bridge prune/reconcile for 300s, and leaked projection claims.

## 0.56.23 — Governed projection reconcile Bridge tool

### Added
- **`git_delivery_reconcile` Bridge tool** (`t-608f2e`). Linked GitDeliveries with
  `projectionSync=pending` can now drain pending canonical projection intents through a
  caller-authorized path (requires integrate + prune principal rights) before integrate/prune.

## 0.56.22 — Projection intent atomicity + corrupt-quarantine abandon

### Fixed
- **GitDelivery projection ops no longer orphan `projection.intent` events on guard failure** (`t-b3242a`).
  Prune eligibility is assessed before appending a canonical intent; unapplied prune intents that still fail
  guards can be voided by reconcile; `projectionSync` reports `pending` when the canonical intent log is ahead
  of `lastAppliedProjectionSequence`.
- **Approval-only `abandon_without_worktree` works for quarantines with a corrupt holder boundary** (`t-832946`).
  Missing `executionNonce` / mismatched holder no longer leaves a permanent no-exit quarantine; held leases
  still fail closed without process death proof.

### Changed
- **Solo hermes development fleet** may list `hermes` under `gitDelivery.integratePrincipals` /
  `prunePrincipals` so the local coordinator can close linked GitDelivery records without other agents.

## 0.45.1 — Catch a mistyped plugin-root placeholder

### Fixed
- **The install consent now warns when a plugin's hook references a mistyped plugin-root placeholder.** A hook
  command that uses `${PLUGIN_ROOT}` (or any `${…PLUGIN…ROOT…}` token that isn't the real `${TACHYON_PLUGIN_ROOT}`)
  is never substituted — it expands to *empty* at runtime, silently running `/<script>` ("not found") so the hook
  never fires. The Plugins drawer now surfaces a non-blocking warning ("did you mean `${TACHYON_PLUGIN_ROOT}`?")
  before you install, so the footgun is caught at consent time instead of failing quietly in a live agent.

## 0.45.0 — Plugins can enforce a tool's safety flags

### Added
- **A plugin can force a provisioned tool to always launch with mandated safety flags.** A tool declaration may
  carry a `launchPolicy { env, args, denyArgs }` that the Tachyon launcher **always** applies — it force-sets
  env vars (overriding a hostile parent env), prepends forced args, and **refuses** an agent argument that would
  override a policy-controlled flag (fail closed). The forced policy is shown in the install consent and bound
  into its fingerprint, so you approve exactly what the tool will always run with; a corrupt policy refuses the
  lockfile rather than launching the tool unpoliced. Loader/exec-hijacking env (`LD_*`/`DYLD_*`/`PATH`/
  `NODE_OPTIONS`/…) is rejected. The guarantee is **"enforced via the launcher"** — a same-user agent that
  re-executes the raw binary outside the launcher is out of scope (that needs agent sandboxing, not file perms).
- **First consumer — the `agent-browser` plugin's form-driving write gate (2.0.0).** Browsing the web with an
  agent now holds every *common* state-mutating action (click/fill/type/submit/upload/eval/download) for an
  explicit confirmation instead of running it silently; reads stay frictionless, and the gate-disable surfaces
  (`--confirm-actions`/`--action-policy`/`--config`/`mcp`/`batch`) are refused. A best-effort mechanical hold
  plus a human-approval protocol — not a sandbox (see the plugin's README for the honest scope).

## 0.44.0 — Plugins discover newer published versions

### Added
- **"Check updates" now finds a newer release of a tag-pinned plugin.** A plugin pinned to a semver tag
  (`github:org/repo@v0.5.0`) used to re-resolve its *exact* immutable pin, so it was forever "up to date" even
  after the source repo published a higher tag. Tachyon now also resolves the repo's **highest semver tag** and,
  when it is newer, evaluates the update against it — surfacing the available version and, on your confirm,
  re-pinning the lockfile to that **higher immutable tag** (reproducibility preserved: it never floats to a
  moving "latest"). The plugin's own manifest version still decides whether an update actually exists, so a
  monorepo tag bump that didn't touch *this* plugin correctly stays "up to date". Branch / `HEAD` / SHA /
  non-semver pins are unchanged, and a failed tag lookup falls back to the exact-pin check (never regresses a
  healthy "up to date"). A pin to a semver-*shaped branch* is never mistaken for a tag.

## 0.43.1 — No false "nothing to wire" warning for skills-only plugins

### Fixed
- **A skills-only (or MCP-only) plugin no longer shows a misleading "declares X but carries no hooks — nothing
  to wire" warning per runtime.** The install preview checked only for a hooks block, so a portable-skill plugin
  like `sdd` warned for every declared runtime even though each one *does* receive the skill. The warning now
  fires only when a runtime materializes **nothing** for the plugin (no hooks, no skill, no MCP) — a genuinely
  pointless declaration. The install behavior was always correct; only the alarming-but-wrong message is gone.

## 0.43.0 — Plugins provision their own pinned tools

### Added
- **A plugin can declare per-platform pinned CLI tools that Tachyon fetches, verifies, and runs.** This is what
  makes a git-hook gate (0.42.0) fail *closed* meaningfully — e.g. a secrets scanner's binary is now reliably
  present. The author pins `{url, sha256}` per platform (libc-qualified: glibc/musl); Tachyon downloads over
  HTTPS-only with bounded redirects, checksum-verifies the bytes, and atomically installs the executable into an
  immutable, content-addressed `.tachyon/bin/<name>/<binSha256>/<tool>` (`O_EXCL`, `0500`, `0700` parents). A
  mismatch fails closed — the bytes are discarded, never executed. tar.gz/tgz archives are unwrapped with a
  metadata-first, single-file extractor that rejects traversal/symlink/zip-bomb tricks.
- **A dedicated, stronger-than-MCP consent.** The Plugins drawer shows each tool's resolved platform, declared +
  final URL, checksum, and publisher, behind its own acknowledgement — with language making clear the sha256
  proves **integrity against the manifest, not that the publisher is trustworthy**.
- **A re-validating launcher.** A git-hook leaf references a tool via `${tool:<name>}`, which resolves to a
  plugin-scoped `_tachyon-tool` invocation; the launcher re-validates the binary's hash (and ownership/mode)
  against the lockfile before *every* exec — so a swapped binary never runs. Uninstall deletes a tool's bytes
  only when no other plugin references them; a fresh clone (where `.tachyon/bin` is gitignored) rehydrates the
  tools explicitly from the lockfile — never a silent fetch.

## 0.42.1 — Git-hook plugins need no runtime

### Fixed
- **A pure git-hook plugin no longer has to declare a runtime.** A git hook runs on every commit regardless of
  which agent runtime you use — it is runtime-agnostic — so requiring a `claude`/`codex` declaration was a
  vestige that produced a confusing "declares X but carries no hooks" notice. A git-hook-only plugin now
  declares no runtime and installs cleanly with no phantom runtime row or warning. (A skill/MCP capability still
  needs a runtime to install into.)

## 0.42.0 — Plugins can install git hooks

### Added
- **A plugin can now install a git `pre-commit` hook** — a gate that runs on **every commit, for every actor**
  (you, the agent, your IDE), not just when an agent acts. This is what makes a real secrets-scan (or any
  commit-time gate) possible. Because `core.hooksPath` is single-owner, Tachyon installs a **chaining
  dispatcher**: your existing hook runs first, then each plugin's hook, and the commit is blocked if any fails —
  multiple plugins and your own hook coexist. The consent drawer shows the exact command with a dedicated
  "runs on every commit" acknowledgement (it can read staged content and block commits; `git commit --no-verify`
  bypasses it). Removing the plugin restores your prior hook setup exactly and never touches your own hook.
- **Repair hooks** (header button) re-activates git-hooks after a clone whose `.git/config` didn't carry over.

### Internal
- Worktree-correct hook/config resolution (`git rev-parse --git-path`/`--git-common-dir`); a content-addressed
  leaf store + integrity-checked execution manifest + repo-level ownership refcount under a repo lock;
  transactional install (`core.hooksPath` set last) with a fingerprint binding the hook state; the engine
  install/remove/update path is now async. Linux/WSL/macOS only. Spec 264; suite + tsc ×2 + webview build green.

## 0.41.2 — Remove drawer counts skills & MCP

### Fixed
- **The Remove confirmation now shows everything it will delete, not just hooks.** Uninstalling a skills-only
  plugin previously showed "0 hook groups removed" — as if nothing would happen — even though it removes the
  skills, the committed payload, and any empty folders the install created. The drawer now lists **skills
  removed** / **MCP servers removed** / **hook groups removed** (each when applicable) plus orphans kept, with a
  note that the payload and installer-created empty directories are removed too.

## 0.41.1 — Plugin card pill fix

### Fixed
- **An installed plugin's runtime pill now reflects what's actually on disk.** A skills-only plugin installs its
  codex skills into `.agents/skills/` and never creates a `.codex/` folder, so the card wrongly showed `codex —`
  ("not present") even though codex *was* installed. The pill now checks the plugin's recorded materialization
  (its lockfile targets) — so it reads `codex ✓` when the skill is on disk, and only shows `—` as a genuine
  drift signal when a runtime's installed files were deleted out from under the plugin.

## 0.41.0 — Plugins install into a fresh workspace

### Changed
- **Installing a plugin no longer requires the runtime's folder to already exist.** Before, a plugin that
  declared `runtimes: [claude, codex]` would silently materialize **nothing** in a clean repo that had no
  `.claude/`/`.codex/` directory — the consent drawer showed each runtime as "skipped (not present)" and the
  install was a green no-op. Now the **plugin author** decides which runtimes a plugin targets and the
  **installer** agrees in the consent drawer: each declared runtime is a selector row labelled **present** or
  **will be created**, and Install creates whatever structure the selected runtimes need. Deselecting every
  runtime disables Install (never a payload-only no-op).
- **Uninstall cleans up exactly what it created.** The lockfile now records the runtime directories an install
  created (and only those), so removing a plugin removes the dirs it made — never a folder that pre-existed or
  that still holds your own files.
- **Updates keep your original runtime selection.** An update materializes into the same runtimes you consented
  to at install (not whatever happens to be on disk now); if a new version drops a runtime you installed into,
  the update refuses with a clear error instead of silently dropping it.

### Internal
- `previewInstall`/`applyInstall` take the consented **target** runtime set (not `detectRuntimes`-as-gate); the
  selection is bound explicitly into the consent fingerprint; `createdAncestors` is recorded before activation
  (so a partial install still has a complete removal record) and `atomicWrite` cleans its temp on failure.
  Spec 263; full suite + tsc ×2 + webview build green.

## 0.38.0 — Leaner coordination surface

### Changed
- **Retired the free-form shared notes whiteboard.** Tachyon had three overlapping ways to coordinate —
  **pins** (a structured checklist), **notes** (a free-form `.tachyon/notes.md` blob), and the **project
  handoff** (curated state). Notes is gone: discrete findings go to **pins**, narrative coordination state goes
  to the **project handoff** (which is append-safe and distilled — the wholesale `set_notes` overwrite was a
  multi-agent footgun), and a long result belongs in a file or is read with `read_output`. Existing
  `.tachyon/notes.md` files are left on disk untouched; the `get_notes`/`set_notes` Bridge tools and the
  "Open Notes" command are removed.
- **Simpler sidebar sort.** The Agents / Terminals sort is now just **A–Z ⇄ Z–A** — one click on the header
  control flips the direction (the old three-way menu and the live "status" reorder are gone), with a clearer
  sort icon.

### Internal
- Pins and the project handoff are untouched; the Bridge tool count drops from 28 to 26. No behavior change to
  anything that survived; tsc ×2 + engine-boundary + the full suite stay green.

## 0.37.0 — One consistent webview look

### Changed
- **Every Tachyon panel now shares one design system.** The six webviews — the sidebar, Activity, Project
  Handoff, Plugins, Agent Studio, and the tmux Server Inspector — had each grown their own styling, so the same
  element (a panel title, a badge, a button) drifted from panel to panel; titles alone ranged from 16px to 30px.
  They now draw from a single shared stylesheet: one type scale (a **16px panel title everywhere**), one spacing
  rhythm, and **identical badges / buttons / cards / inputs** across every panel.
- **The look follows your VS Code theme.** Every color is driven by your theme's own variables, so the panels
  adapt to whatever you run — **light, dark, or high-contrast** — instead of a hardcoded palette that could fight
  a light theme. Vertical spacing was tightened onto a consistent grid for a calmer, more even layout.

### Internal
- A single theme-driven `design-system.css` (`.ds-*` tokens + components) is copied to `dist/webview/` and
  linked by every webview; each panel keeps only its genuinely panel-specific styling (no re-defined tokens).
  Added a headless render harness that screenshots each panel under both a dark and a light theme. No behavior
  change; tsc ×2 + engine-boundary + the full suite stay green.

## 0.36.0 — Plugin skills

### Added
- **Plugins can now ship skills, not just hooks.** A plugin includes a `skills/<name>/SKILL.md` payload (written
  once), and Tachyon installs it into every present runtime that loads skills — **Claude** (`.claude/skills/`)
  and **Codex** (`.agents/skills/`), the same `SKILL.md` format for both. Skills install, update, and remove
  through the same Plugins View as hooks.
- **Your own skills are never silently overwritten.** When a plugin's skill would land where you already have a
  skill of that name, the consent drawer surfaces the collision with a **Keep mine / Replace** choice — Keep is
  the default, and **Replace requires a second explicit confirmation** (it permanently overwrites; there's no
  undo). Remove deletes exactly the skill-dirs Tachyon wrote, never your own.

### Internal
- Plugin engine extended to a second capability with a fail-closed security posture: the skill loader rejects
  symlink-escapes / oversized payloads / YAML-bomb frontmatter; install/remove are consent-fingerprint-bound
  (TOCTOU); and every lockfile skill-dir path is validated against the runtime's skills dir before it is ever
  trusted or deleted, so a corrupted lockfile can't turn a remove into an arbitrary delete.

## 0.35.0 — Plugins

### Added
- **The Plugins View — manage plugins from a new editor panel.** Open it from the **Plugins** button in the
  sidebar title bar (next to Inspect tmux). Per workspace, you can browse what's installed, install a plugin
  by its git source (`github:owner/repo@ref`), update, reinstall, and remove. Each plugin's native config
  block is merged into every runtime present in the workspace (claude + codex in v1; gemini is deferred).
- **A blocking security consent drawer before anything is written.** Installing, updating, or removing first
  shows the source provenance (resolved commit + integrity hash), the **full list of shell commands** the
  plugin will run on agent events, every file Tachyon will write, and a consent fingerprint. The apply is
  **bound to exactly what you consented to** — it refuses if the workspace or source moved since the preview,
  so a remote plugin's hooks are never wired silently or swapped out from under you.

### Internal
- Plugin engine completed end to end: a git source resolver + fetcher with a content-addressed cache,
  provenance + integrity pinned in the lockfile for byte-reproducible re-hydration, and a pure view-model
  layer (list + consent) so the UI's logic is unit-tested rather than buried in the VS Code layer.

## 0.34.3 — clearer Activity reminders

### Fixed
- **Tachyon's injected reminders no longer masquerade as human messages.** A `[tachyon] …` nudge (the
  handoff/continuity reminders Tachyon types into a pane) was rendering as a human chat bubble in the
  Activity feed, indistinguishable from what you typed. It now renders as a subtle, centered system chip
  (the agent still receives the reminder unchanged — this is purely how the feed reads).

### Internal
- Plugin system (engine, not yet surfaced in the UI): added a 3-way plugin updater that updates an
  installed plugin without clobbering your edits — it refuses (without force) when you've edited or would
  duplicate a plugin's hooks, and force-gates a downgrade.

## 0.34.2 — one cleanup path for agent teardown

### Fixed
- **Deleting a configured agent no longer orphans its activity log.** The 0.34.0/0.34.1 fixes cleaned the
  durable `.tachyon/activity/<agent>.jsonl` for ad-hoc kill, dismissal, and pipeline-node teardown, but the
  "Delete" action on a declared agent removed its config entry + session row while leaving the log behind —
  the same orphan class, just on the declared-delete path. Deleting an agent now drops its log with its row.

### Changed
- **Internal:** the "remove an ephemeral agent's session row + activity log" pair, previously open-coded at
  every teardown site (and the source of the drift that left orphans), is centralized into one shared,
  idempotent cleanup helper, so a future teardown path can't silently re-introduce an orphan. No behavior
  change for the existing kill/dismiss/pipeline paths.

## 0.34.1 — activity log also cleaned on kill

### Fixed
- **Killing an ad-hoc agent no longer leaves an orphaned activity log.** 0.34.0's cleanup (an agent's durable
  `.tachyon/activity/<agent>.jsonl` dies with its ledger row) covered dismissal and pipeline-node teardown but
  missed `kill` — which removes the row and, unlike a clean-exit dead pane, leaves no pane to view the log from,
  so the log was left unreachable on disk. Killing a non-persistent ad-hoc agent now deletes its log with the
  row. Found in live dogfood of 0.34.0.

## 0.34.0 — Delegation contract on agent-spawned AI sub-agents

### Added
- **When an agent delegates to a fresh AI sub-agent through the Bridge, it must now hand it a structured brief.**
  `spawn_agent` for an ad-hoc AI child requires a contract — **task + context + constraints + (deliverable OR
  done_when)** — or the call is rejected with a message naming what's missing, so the agent fixes it and retries.
  The accepted contract is composed into the child's opening instructions (it IS the child's brief, not just a
  checkpoint) and persisted with the agent. A genuinely trivial spawn can opt out with `skip_contract_reason`
  (≥10 chars), which is recorded and surfaced to you rather than silently allowed. Terminal (non-AI) children and
  agents declared in `tachyon.yml` are not gated. Enforced at the Bridge, so it works the same for any runtime
  (claude / codex / gemini / opencode); restarting, resuming, or forking an existing agent is never re-gated.

### Fixed / changed
- **A finished one-shot or pipeline `cmd:` node no longer leaves an orphaned, unreachable activity log.** The
  durable `.tachyon/activity/<agent>.jsonl` now shares the agent's lifecycle — it's removed when the agent is
  dismissed (a clean-exit ad-hoc) or its inline pipeline node is torn down, instead of accumulating on disk with
  no row to view it from. A declared agent keeps its log; the postmortem "Activity" view of a dead pane is
  unaffected (the log is dropped only at dismissal).
- **Launcher-wrapped AI commands (`npx claude`, `env -u VAR claude`, …) are now classified and prompted
  consistently** — a single resolver sees through `npx`/`bunx`/`env` for both kind-detection and prompt
  delivery, so a wrapped AI agent both gets gated and actually receives its brief.

## 0.33.0 — Project Handoff: agent-driven distill

### Added
- **An agent can now DISTILL the pending notes into the handoff — you just curate.** Reading the handoff
  (`get_project_handoff`) now returns the pending notes themselves (not just a count) plus a watermark, so an
  agent can fold them into a rewritten handoff, show you the draft, and on your OK write it
  (`set_project_handoff`). You stay the curator (approve / ask for changes); the agent does the typing.

### Fixed / changed
- **A note appended while a distill is in flight is never silently lost.** Pending is now tracked by an explicit
  distill watermark (which notes have actually been folded in), not by wall-clock — so a note that lands between
  an agent reading the handoff and writing the distilled version simply stays pending for the next pass. A plain
  rewrite (without declaring a distill) no longer clears pending — clearing is now an explicit, deliberate step.

## 0.32.1 — Project Handoff: quieter, smarter append-nudge

### Fixed
- **The "append a handoff note" reminder no longer nags an agent that has nothing new to log.** It now fires only
  when an agent has done real new work since it was last reminded or last appended (a per-agent activity-lag gate),
  on top of the existing per-workspace interval (`settings.handoff.nudgeEvery`). An agent that just logged — or
  that judged its recent work not worth a project note — won't be re-reminded for the same work.

## 0.32.0 — Project Handoff (shared state of the work)

### Added
- **A Project Handoff: one shared, curated "state of the work" per workspace — distinct from per-agent
  continuity.** Where per-agent continuity recovers an individual agent's thread, the handoff is the project-level
  picture (current state / active work / next actions / decisions & gotchas) that any human or freshly-resumed
  agent can read. Two lanes keep it correct in a multi-agent workspace without write conflicts:
  - **Canonical** `.tachyon/HANDOFF.md` — human/owner-curated, git-tracked, edited as a whole (concurrency-safe
    via compare-and-swap so a stale rewrite can't clobber a newer one).
  - **Pending notes** `.tachyon/handoff-notes.jsonl` — any agent appends a structured note (completed / blocked /
    decision / gotcha / next); the owner distills them into the canonical. Agents never rewrite the shared file.
  - **New Bridge tools:** `get_project_handoff`, `append_project_handoff_note`, `set_project_handoff`.
  - **A read-only editor panel** opens from a per-folder button in the sidebar (with a staleness badge: Fresh /
    Needs distill · N / Possibly stale / Old), rendering the handoff + the pending notes.
  - **A light, opt-out nudge** reminds an idle agent to append a note when project state changed — throttled
    per-workspace via `settings.handoff.nudgeEvery` (default `30m`, set `off` to disable). The handoff path is
    overridable via `settings.handoff.path`.

## 0.31.2 — Resume reopens the current session after `/clear` (shared cwd)

### Fixed
- **Stop→resume now reopens the session you were actually in, even after a `/clear` on a shared folder.** 0.31.1
  made the Activity feed *follow* a `/clear`; this completes the loop for *resuming*. Before, resuming a Claude
  agent that shared a folder with others could reopen the **pre-`/clear`** conversation, because the stored
  session id was never advanced past the rotation. Tachyon now uses the same per-agent ownership ledger (0.31.1)
  to pick the resume target — at stop, at resume, and for the sidebar's resumable badge — so it reopens the
  current session and never another agent's. Agents that manage their own session (`claude --resume …`) and
  non-Claude runtimes are unchanged; agents started before 0.31.1 keep the prior behavior until their next start.

## 0.31.1 — Activity keeps logging after `/clear` (shared cwd)

### Fixed
- **The Activity feed no longer freezes after `/clear` (or an in-TUI `/resume`) when several Claude agents share
  one folder.** Previously, once an agent's session id was captured, a `/clear` rotated Claude to a brand-new
  session that — on a shared working directory — Tachyon couldn't attribute from disk (Claude discards the
  Tachyon-set title and writes no parent link), so the durable Activity log stayed pinned to the old, frozen
  transcript and silently stopped recording. Tachyon now spawns each Claude agent with a per-spawn `--settings`
  `SessionStart` hook that records which session belongs to which agent in a small ledger
  (`.tachyon/activity/session-owners.jsonl`); the Activity view follows that **positive** signal, so it tracks a
  rotation exactly — and can never attribute another agent's session to the wrong log. No `~/.claude` or repo
  `.claude/` settings are touched (the `--settings` layer is additive, so your own hooks still run). Agents that
  manage their own session (`claude --resume …`) or already pass `--settings` are left untouched.

## 0.31.0 — Sortable sidebar (no more status churn)

### Changed
- **The Agents and Terminals lists are now a single flat list you sort yourself** — instead of bucketing into
  Running / Idle / Stopped groups that reflowed every time an agent changed state. The default is **Name (A–Z)**,
  a stable order where a status change just **recolors the dot in place** (no more rows jumping around). A sort
  control in the section header offers **Name (A–Z) · Name (Z–A) · Status (live)**; your choice is remembered.
  Status stays at-a-glance via the colored dot (hover for the label) and compact **per-status count chips** in the
  header. Other sections (Pipelines, Runbooks, Commands, Schedules, Pins) are unchanged.
  - **Note:** existing users will see Agents/Terminals switch from status-groups to a flat A–Z list by default —
    pick **Status (live)** from the new sort control to get the old status-first ordering back.

## 0.30.2 — Continuity nudges name the agent

### Fixed
- **The continuity nudge now spells out the agent's exact name in the `set_continuity` call.** An agent doesn't
  know its own Tachyon name, so when nudged it could guess wrong (e.g. write its brief under `main`) — the brief
  landed in the wrong file and its badge/recovery never saw it. Tachyon types the nudge and knows the name, so it
  now writes `set_continuity(agent: "<name>", …)` literally; the tool also warns against guessing.

## 0.30.1 — Continuity polish

### Fixed
- The continuity re-injection no longer points at `cat .tachyon/roles/<agent>.md` when that role doc doesn't
  exist (it only appears for agents you've actually re-anchored) — no more `cat` of a missing file.

## 0.30.0 — Per-agent continuity + richer diffs

### Added
- **Per-agent continuity — each agent keeps its working memory across session boundaries.** An agent now
  maintains a short continuity brief (`.tachyon/continuity/<agent>.md`: current goal, working state, decisions,
  next steps, open threads). When the agent crosses a **discontinuity** — a context compaction, a `/clear`, a
  restart, or a new session — Tachyon automatically types a "rebuild your context" pointer into the pane so the
  agent picks up where it left off, instead of starting blank. It is **hands-off for you**: the agent writes the
  brief (nudged by Tachyon when it's missing or falling behind), and Tachyon re-injects it on its own. Crucially,
  a **clean same-session resume is NOT re-injected** (no double-context). A sidebar badge shows
  fresh / **◐ stale** / **○ missing**, and `Tachyon: Re-inject Continuity` forces it on demand. claude-only in v1;
  no LLM cost (the agent authors the brief). `.tachyon/continuity/` is gitignored.
- **Richer Edit/Write diffs in the Activity view** — tool diffs now render TUI-style: a per-line gutter with old/
  new line numbers, the +/− sign, syntax-highlighted code (by file type), and green/red row backgrounds, instead
  of flat monospace text.

## 0.29.2 — Toggle isolation on an existing agent

### Fixed
- **Turning on `isolate: transcript` (or `harness:`) for an agent that already has history now takes effect on
  Restart.** Previously the agent's recorded config home was pinned to where its earlier sessions lived, so a
  restart kept looking there and the newly-isolated session showed an empty Activity view. A restart mints a
  fresh session, so it now re-homes to the current config home (old history stays where it was — a transcript
  can't be moved; resuming an existing session still uses its original home). A `claude --continue`/`--resume`
  agent, which owns its own session, still needs a delete + recreate to re-home.

## 0.29.1 — Task-list rendering + Studio isolate toggle

### Fixed
- **Markdown task lists (`- [ ]` / `- [x]`) rendered as stray empty boxes in the Activity feed.** The upstream
  task-list plugin emits malformed, space-less checkbox markup; Tachyon now renders each item as a proper
  styled checkbox glyph (read-only, matching the rest of the cockpit).

### Added
- **`Isolate transcript` checkbox in the Agent Studio.** The spec-240 per-agent transcript isolation is now a
  one-click toggle when creating/editing a claude agent (still off by default; claude-only; hidden when the
  heavier `Isolated harness` is on, which already isolates the transcript).

### Changed
- **`Open transcript` moved from the Activity header to a command.** The raw runtime `.jsonl` is a power-user /
  debug escape hatch, so it's now the `Tachyon: Open Raw Transcript` palette command (targets the active
  Activity panel) instead of a header button — the rendered, durable Activity log is the primary surface.

## 0.29.0 — Backward paging + per-agent transcript isolation

### Added
- **Load earlier activity (in-panel backward paging).** The Activity view can now reach OLDER history without
  leaving the panel — a "Load earlier activity" button grows the rendered window backward over the durable log,
  keeping your scroll position anchored on the item you were reading (no jump). Bounded (it defers to "open
  transcript" past a hard cap, so the payload stays sane).
- **`isolate: transcript` — per-agent transcript namespace (spec 240).** Declare it on a claude agent to give
  it its OWN claude config home (a separate transcript namespace) WITHOUT the heavier `harness:` MCP isolation:

  ```yaml
  agents:
    reviewer:
      cmd: claude
      isolate: transcript
  ```

  Now multiple agents that share ONE folder each get an attributable session, an in-TUI `/resume`/`/clear` that
  the Activity view follows, and their own durable activity log — while still loading the workspace project
  config (`CLAUDE.md`, `.claude/`, `.mcp.json`, which are cwd-relative) and inheriting your existing claude
  login (no re-auth). The fix for "several agents in the same folder, one shows no activity."

### Fixed
- Session attribution is now drift-safe: the config home a session was written under is persisted, so a later
  `isolate`/`harness` toggle or rename can't make Tachyon look in the wrong place; startup GC no longer reaps a
  still-referenced transcript home.

## 0.28.1 — Activity in shared folders

### Fixed
- **The Activity view was empty for agents that share a workspace folder.** When ≥2 agents run in the same
  directory (the common case), the durable-log writer was over-suppressed and captured nothing, so the cockpit
  showed "Waiting for activity…" for a working agent. It now attributes each agent's session safely by its
  captured uuid or unique title even in a shared folder (only the genuinely ambiguous, id-less case is gapped,
  with an honest notice) — so each agent's history shows correctly. No misattribution: the only ambiguous
  fallback (a bare "newest in this folder" scan) is skipped on a shared cwd.

## 0.28.0 — Durable activity history

### Added
- **The Activity view now keeps each agent's full, normalized history — durably.** A per-agent activity log
  (`.tachyon/activity/<agent>.jsonl`) is written continuously by an always-on writer, so the cockpit shows a
  complete, stitched timeline across `/clear`, `/resume`, context compaction, fresh starts and restarts —
  history that would otherwise be lost when the runtime rotates session files. The log is a normalized
  projection (not a raw clone): provenance pointers back to the source records, content-addressed copies of
  the images it renders, and it survives runtime-side pruning.
- **Session & compaction boundaries are rendered as separators.** Compaction shows "context compacted" with
  the token delta and an expandable summary; session changes show "new session" / "resumed session" /
  "restarted session" / "forked session" — labeled from Tachyon's own Start/Restart/Resume/Fork actions when
  it performs them, inferred from the transcript otherwise.
- **Rich rendering in the Activity feed** (since 0.27): markdown via markdown-it (tables, task lists, quotes),
  syntax-highlighted code blocks with copy, Mermaid diagrams, LaTeX (KaTeX), thinking blocks, tool diffs,
  inline images with click-to-zoom, a live "working…" indicator, in-feed search, and a visible "recent N of
  M" cap notice instead of silently dropping older activity.

### Changed
- The Activity panel is now a read-only subscriber to the durable log (it no longer tails the runtime
  transcript directly). Opening a long session is bounded (fast) instead of re-reading the whole file.
- Post-compaction artifacts (the continuation summary, `/`-command wrappers, local-command output) are no
  longer mis-rendered as human chat messages.

### Notes
- Per-agent history is captured from now forward; on a folder shared by ≥2 agents, session stitching is
  suppressed (an honest "history stitching limited" notice) rather than risk mis-attribution.

## 0.27.0 — New sidebar

### Changed
- **The Tachyon sidebar is now a purpose-built webview panel, replacing the native tree.** Icon tabs per
  section (Agents, Terminals, Pipelines, Schedules, Commands, Runbooks, Pins), a global `⌘K`/`Ctrl+K`
  search across the whole fleet, capability-gated per-row actions with a consistent `…` overflow menu
  (Edit in Studio / Edit YAML / Delete), multi-root folders shown together and grouped, a view toolbar
  (server inspector / refresh / settings), live state for every section, and full keyboard accessibility.
- The legacy tree is removed (the `tachyon.sidebar.legacyTree` opt-in is gone). All existing commands and
  Studios are unchanged — the panel drives the same actions.

### Added
- Per-section "new …" create buttons; Commands/Runbooks show real run state (running/passed/failed) with
  open-output and step expansion; pipelines gate Run/Cancel/Dismiss/Review by run state and auto-expand on
  start; schedules reflect paused state; an honest empty state with an "Initialize Tachyon" action.

## 0.26.0 — Zero-config Bridge

### Added
- **Every Tachyon-spawned agent reaches the MCP Bridge automatically.** Tachyon injects the
  Bridge at spawn — Claude via an additive `--mcp-config`, Codex via an additive
  `-c mcp_servers.tachyon_bridge=…`, and an isolated-harness Claude has it folded into its
  scoped (`--strict-mcp-config`) file. Injection re-runs on **spawn, restart, resume, and fork**
  (a momentarily-down Bridge self-heals on the next start), and the token never lands on the
  command line. **No `.mcp.json` / `config.toml` registration is needed** for agents Tachyon
  spawns. `Tachyon: Connect Agent Runtime` remains, now scoped to **external/manual** sessions
  you start yourself.

### Fixed
- An isolated-harness agent with `inherit: none` no longer silently loses the Bridge — it is
  always folded into the materialized strict MCP file, so the agent can still call
  `complete_node` / `write_input`.

### Changed
- Pipeline preflight now treats a Tachyon-spawned Claude node as Bridge-capable (injection
  guarantees it — no project `.mcp.json` evidence required); a node whose command disables MCP
  (`--safe-mode`) is correctly reported as unable to signal completion.

### Removed
- The discontinued **layouts** feature was retired (legacy config keys remain tolerated).

### Internal
- The engine is now decoupled from VS Code behind a host port, enforced by a CI boundary guard.
- The `Workspace` is headless-testable (`createForTest` + an in-memory host).

## 0.25.0 — Agent Pipelines, input-driven
- Input-driven pipelines: one definition becomes a reusable workflow run per issue, with agent
  personas and a handoff bus that carries context down the chain.
- Codex pipeline nodes reach the Bridge automatically via an injected `-c` override.

## 0.56.37
- t-ec5cd2: passive info toasts auto-advance (~4s); exact-duplicate collapse (~10s); burst "+N more" suffix.

## 0.56.38
- t-e1bd89: scope approval.css under .approval-root; Mission who/prio chips no longer blue under Control.
