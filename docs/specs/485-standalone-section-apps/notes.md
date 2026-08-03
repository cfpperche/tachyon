# 485 — standalone-section-apps — notes

_Created 2026-08-02._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### Phase B — where the visibility gate lives (2026-08-03)

`src/webview/shared/panelWorkGate.ts`, one primitive, used by every panel host: the studio manager
base, Control, and the agent pane. It sits at the **manager** layer rather than at `extension.ts`'s
fan-out, because the fan-out has no idea which panels exist or which of them a human is looking at —
`onViewsChanged` dispatches by `ViewKind`, and only the manager holds panels. Gating at the fan-out
would have to answer "is ANY consumer visible", which is the wrong question the moment there is more
than one panel per kind, which is exactly what this spec is for.

The gate exposes its one decision as a pure function (`decideCatchUp`), the same way
`studio/restoreDecisions.ts` does, so the branch that must never be wrong can be read and tested
without a panel, a webview or a clock.

### Catch-up before suppression, and the shape of the journal

The reveal was designed first. t-b51923's real risk was never the storm — it was swallowing the last
invalidation and leaving a view stale forever, and this phase can commit that exact fault one layer
down. So:

- while hidden, each suppressed invalidation is journaled in a bounded window (64 entries,
  ≈27s at the post-t-b51923 rate);
- on reveal with the window intact → **delta**: replay each DISTINCT kind once. Legitimate because a
  `views-changed` carries no payload — it says "this view is stale", never what changed — so N
  identical ones hold exactly the information of one;
- window overflowed, or `WorkspaceClient` reported `resynced`/`engineChanged` while we were hidden →
  **full resync**. We stop claiming to know what changed and rebuild.

The upstream-resync branch is wired from `extension.ts`'s subscriber (`markControlSourceResync()`
next to the `refreshAll()` that was already there). Without it, a hidden Control would replay the
three kinds `refreshAll` happens to touch and silently assert it knows what the engine just admitted
it does not.

### `visible`, not `active`

The gate keys on `WebviewPanel.visible`. A panel side by side with the focused one is being looked
at and must keep working — two live surfaces at once is the capability this whole spec buys, and
gating on `active` would have broken it in the same change that enabled it.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

### The activity feed is paused, not journaled (B1/B2)

`plan.md` framed Phase B entirely around the `views-changed` fan-out. Control has a second
hidden-work path that never emits one: the agent-activity feed (`src/cockpit/activityFeed.ts`) runs a
1s attention poll and an `fs.watchFile` that reads, rebuilds and posts on every log append, whether
or not anyone is looking.

It is gated through `ActivityFeedIO.paused` rather than through the journal, because the feed already
owns a better journal than the gate could keep: the durable log itself. Hidden, it reads nothing and
its byte offset stays put; on reveal `catchUp()` ingests forward from that offset — a real delta —
and `pump()`'s existing `size < offset` branch is a real full re-prime when the log was truncated
under it. The same delta/resync bargain, arriving from the file rather than from a counter.

Consequence: the gate needed an `onReveal` hook that fires on EVERY reveal, including the one the
journal calls `none`. An activity log can grow while zero invalidations arrive, so hanging its
catch-up off the journal's decision would have left it stale for exactly the case it exists to cover.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

### Measured before/after (B4)

**Consumer work, `StudioPanelManagerBase.refreshAll()` with 8 panels open and 1 visible:**

| | journal events/s | refresh work/s |
|---|---|---|
| before (every panel refreshes, always) | 3.98 | **31.87** |
| after (hidden panels do nothing) | 3.98 | **3.98** |

Both rows come from one run of `test/unit/hiddenPanelWork.test.ts` ("before/after, producer unchanged
and consumer gated"), which prints them. The producer is the real `DaemonEngineHost` with its real
250ms coalescing window, fed t-b51923's measured storm shape (~15 invalidations/s per running agent ×
2 agents = 1800/min); it emitted 239 `views-changed` in the simulated minute. The consumer is the
real manager driven through the real fan-out door. "Before" is every panel visible, which is
byte-for-byte today's behaviour — nothing in the old code asked about visibility.

**The journal rate is identical in both rows, and that is the result, not a null one.** This phase
changes the CONSUMER; a number that moved there would mean it had reached into t-b51923's producer
fix, which this task explicitly forbade.

What was NOT done, and should not be read into the table: **no live two-agent measurement was
taken.** t-b51923 measured a running engine; no engine daemon is reachable from a change worktree
(no `events/*.jsonl` under any storage root here), and opening an editor window was out of bounds for
this task. The harness above is the honest substitute — real producer, real consumer, synthetic
arrival pattern — and the live number is worth re-taking on the maintainer's machine with Control and
a couple of panes open behind other tabs.

### Suppression is per-panel, not per-manager

Each panel carries its own gate and its own journal. Simpler would have been one journal per manager
plus a visible-panel set, but then a panel revealed after a different one had already drained the
journal would come back empty-handed. Per-panel costs one array per open panel and cannot fail that way.

### The window can blow, on purpose

64 entries, so a panel hidden through a genuine storm takes ONE full resync on reveal instead of a
long replay. A journal that deduped kinds at record time would never overflow and the resync branch
would be dead code — a branch that never runs is not a safety net, it is a comment.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

### Work that still happens while hidden, and was left alone deliberately

- **The agent pane's tmux data stream.** The pane keeps its `attach` client and keeps writing output
  into xterm while hidden. Suppressing it needs somewhere to hold the bytes, and xterm's scrollback
  IS that somewhere — dropping them loses output, and detaching to avoid them contradicts t-feaaea
  (reattach is a human decision, and a reveal is not one). What WAS gated is the pane's only periodic
  host work: the 2s `tmux list-clients` co-attach poll.
- **`fs.watchFile`'s stat poll (2/s per open activity route).** The feed reads and posts nothing while
  hidden, but the watcher stays armed. Closing it means unwatch/rewatch across visibility, which
  resets the `prev` stat its change detector compares against. Cheap enough to leave; named here so
  it is not mistaken for zero.
- **The sidebar (`SidebarPrototypeProvider.refresh`) is NOT gated, and must not be naively gated.**
  It is the heaviest single consumer — every `views-changed` re-gathers a fleet per workspace root —
  but its push also sets `view.badge`, the attention count on the activity-bar icon, which is visible
  precisely WHILE the view is hidden. Gating it wholesale would freeze that badge: a correctness
  regression wearing a performance win's clothes. Splitting the badge computation from the fleet push
  would make it gateable, and is worth its own task.
- **`PluginSurfaceHost` editor panels** (`plugins/ui/host.ts`) also refresh unconditionally in
  `refreshAll()`. The same primitive applies; out of Phase B's declared scope (`AgentPanePanel` +
  Control), so untouched here.
