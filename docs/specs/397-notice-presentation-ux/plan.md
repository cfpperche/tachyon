# 397 — notice presentation UX (inbox + auto-dismiss + narrow dedupe)

_Created 2026-07-17. Draft plan only — not yet implemented._

**Status:** draft  
**Depends on:** 382 (daemon-owned notices + `notice.present` serial presentation)  
**Out of scope (later):** custom visual toast stack (#4)

## Intent

Human notices from the persistent engine are correct and durable, but presentation is painful:
native VS Code toasts resolve only on dismiss, and `DaemonEngineHost` intentionally shows **one
notice at a time**. Bursts (crash + needs-input + assign + `notify`) force serial X-clicking.

Improve **presentation and attention management** without reducing the set of distinct notice
*origins* or breaking action/at-most-once semantics.

## Product contract (non-negotiable)

> No notice with **new content** disappears without the human being able to see it.
> What changes is **where** it lives and **how long** it occupies the corner toast.

| Change | Suppresses distinct events? |
| --- | --- |
| 1. Inbox / strip | No — all notices remain readable |
| 2. Auto-dismiss info without actions | No — still shown, then auto-clears from toast |
| 3. Narrow dedupe | Only **duplicates** (same key + same message in a short window) |

**Never** auto-dismiss or drop a notice that carries actions (Restart, Open terminal, …).

## Current SD (baseline)

```
Workspace / monitors / Bridge notify / task assign / …
  → DaemonEngineHost.notify()
      pendingNotices (cap 256, drop oldest)
      presentNextNotice()  // one active present at a time
  → shell notice.present
      vscode.window.show*Message  // Promise holds until click/X
  → complete → present next
```

See: `src/workspace/DaemonEngineHost.ts` (`pendingNotices`, `noticePresentationActive`),
`src/extension.ts` (`notice.present`), `src/workspace/notify.ts`,
spec 382 notes (notification starvation fix: present completion off the operational tail).

## In scope (1–3)

### 1) Notice inbox / strip (sidebar)

- Durable **inbox** of engine notices for the current workspace (or engine instance), newest-first.
- Sidebar surface: compact strip or Mission/Control-adjacent list with unread count badge.
- Each row: level, message (truncated), time, agent if known, actions still invokable once.
- Toast remains the **attention** channel; inbox is the **history + catch-up** channel.
- Burst policy for toast: when N>1 are queued, show **one** toast for the highest severity /
  most recent actionable item, with copy like “+K more in Notices” (exact copy TBD).
  **All** items still appear in the inbox.

### 2) Auto-dismiss for passive info

- Only: `level === "info"` **and** `actions.length === 0`.
- Timeout: 4s default (configurable later if needed; v1 constant is fine).
- warn/error: no auto-dismiss in v1.
- Any notice with actions: never auto-dismiss.
- Closing via auto-dismiss == user dismiss (no action run); then present next as today.

Implementation note: VS Code native toasts do not reliably support timed hide. Prefer one of:
- (A) **engine-side present timeout**: complete `notice.present` after timeout with `null` if
  still open and passive — shell may need a non-blocking present path; or
- (B) **shell-owned passive present** that uses a StatusBar/transient UI for passive info only.

Pick **one** path in the first implementation spike; document the choice in notes.md.
Do not re-serialize the operational tail behind an open toast (382 starvation invariant).

### 3) Narrow dedupe

- Key = `hash(level + normalizedMessage + agentHint?)` or explicit `dedupeKey` when producers pass one.
- Window: ~8–15s (constant v1).
- Effect: while a notice with the same key is **pending or recently presented**, drop **exact
  duplicate** enqueues (increment a collapsed count on the surviving row in the inbox).
- Different message or different level = **not** a duplicate.
- Actionable notices: still dedupe only exact duplicates; surviving row keeps actions.

## Out of scope (explicit)

- Custom multi-toast stack / webview toast host (#4).
- Reducing producers (crash, needs-input, assign, Bridge `notify` volume).
- Changing Bridge `notify_agent` (A2A) semantics.
- Changing task-notification settings surface beyond reuse of existing dedupe ideas
  (`tachyon.taskNotifications.dedupeWindowMs` is inspiration only).
- macOS / non-VS Code shells beyond keeping the engine protocol honest.

## Acceptance scenarios (draft)

### A — Burst does not require N clicks for history

- **Given** 5 distinct engine notices fire within 2s (mix of info/warn, at least one with action)
- **When** the human opens the Notices strip without dismissing every toast
- **Then** all 5 are listed in the inbox
- **And** at most one (or a small fixed number) toast is required for attention

### B — Passive info auto-clears toast

- **Given** a single info notice with no actions
- **When** the human does nothing for the auto-dismiss timeout
- **Then** the toast leaves without a click
- **And** the notice remains in the inbox (marked seen/unread per design)

### C — Actionable never auto-clears

- **Given** a crash notice with Restart / Open terminal
- **When** the auto-dismiss timeout elapses
- **Then** the toast remains until human action or explicit dismiss
- **And** Restart still runs at most once

### D — Duplicate burst collapses

- **Given** the same crash toast text for agent `x` is enqueued 4 times in 5s
- **When** presentation runs
- **Then** the inbox shows one row with collapsed count ≥2
- **And** at most one toast presentation is required for that key

### E — 382 starvation invariant holds

- **Given** a notice is open (including long-lived actionable)
- **When** the shell syncs / sidebar queries
- **Then** they complete without waiting for toast dismiss

### F — Reload / reattach

- **Given** notices pending while shell detaches
- **When** a shell reattaches
- **Then** pending presentation and inbox state reconcile without double-running actions

## Suggested shape (implementation sketch — not binding)

1. **Engine notice log** next to `pendingNotices`: append-only (or ring) records with id, at,
   level, message, actions metadata, dedupeKey, collapsedCount, state
   (`queued|presenting|inbox|dismissed`).
2. **presentNextNotice** policy plug-in: pick next toast candidate (actionable > severity > newest);
   passive info may use timeout completion.
3. **Shell UI**: sidebar webview section or prototype strip bound to snapshot/events
   (`notice` event already exists; extend snapshot if needed).
4. **Protocol**: only if inbox needs durable fields beyond current `notice` event — keep additive.

## Tasks (coarse)

- [ ] Spike: auto-dismiss path (engine timeout vs shell-owned passive) + prove E
- [ ] Engine: notice log + narrow dedupe + collapsedCount
- [ ] presentNextNotice: severity/action priority + “+K more” toast copy when queue depth >1
- [ ] Shell: Notices strip + unread badge + open actions from row
- [ ] Tests: unit for dedupe/queue policy; shell/client regression for starvation (reuse 382)
- [ ] Dogfood: burst of crash/needs-input/assign/`notify` on real fleet
- [ ] Docs: short note in system-design or runbook; link from 382 notes

## Risks

| Risk | Mitigation |
| --- | --- |
| Inbox invisible → feels like dropped notices | Badge + “+K more” always points to strip; dogfood |
| Auto-dismiss hits actionable by bug | Fail-closed: any actions ⇒ no timer |
| Dedupe key too wide | Exact message + level (+ agent when known); tests |
| Snapshot bloat | Ring buffer (e.g. last 100) + drop policy documented |

## Decision log (fill during impl)

- Auto-dismiss mechanism: _TBD after spike_
- Inbox home (sidebar Agents vs Mission vs Control): _TBD_
- Default dedupe window ms: _TBD (propose 10_000)_

## Open questions for human

1. Inbox lives where by default — Agents sidebar strip, Mission Control, or both?
2. After auto-dismiss, should passive info count as **read** or stay **unread** in the strip?
3. Is “+K more in Notices” toast enough, or also a Status Bar permanent counter?
