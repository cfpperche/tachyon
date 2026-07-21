# 410 — Studios as Control routes — design v3 (C.1b + C.4 + Phase D)

_Drafted 2026-07-21 (t-610705). Hardened via two adversarial duetos (codex): round 1
probe-ad112b99 (REDESIGN, 15 findings), round 2 probe-393d5244 (REDESIGN, 8 findings — all
protocol-completeness, none architectural). This v3 folds in every finding. Full results in
`.tachyon/probes/`; synthesis in the t-610705 journal. Draft policy (3-option + cache) approved by
the maintainer 2026-07-21._

## Scope

The 7 production `StudioPanelManagerBase` panels become Control routes, one migration group per PR:
task-studio, pin-studio, agent/terminal/command/runbook/schedule-studio-shell. The 2 dev-only fakes
(pipeline-studio, agent-fixture-studio) stay standalone (standing exception). `StudioFrame`, the
adapters, and the studio protocol envelope are all PRESERVED — what is replaced is the panel-manager
host lifecycle and the open/close semantics.

Knowingly traded (mandate 2026-07-21): concurrent side-by-side editors of the same screen class.
NOT traded (dueto R1-F6 + explicit product sign-off 2026-07-21): in-session background drafts — see
§ Draft policy.

## Route shape (R1 confirmed sound)

Two kinds, parameterized by a closed union — not 14 kinds, no optional fields:

```ts
type StudioId = (typeof STUDIO_IDS)[number]; // ONE const source
const STUDIO_IDS = ["task", "pin", "agent", "terminal", "command", "runbook", "schedule"] as const;

interface CockpitStudioNewRoute  { kind: "studio-new";  studio: StudioId; wsHash: string }
interface CockpitStudioEditRoute { kind: "studio-edit"; studio: StudioId; wsHash: string; entityId: string }
```

`decodeRoute` validates `studio` against the closed set. `routeKey` embeds it. Guards against
registry drift (R2-F14): registry declared `satisfies Record<StudioId, StudioRegistryEntry>`, no
casts, one exhaustive test drives every StudioId through decode/routeKey/parent/nav/refresh/format/
chunk/CSS/close-target.

## STUDIO_REGISTRY

One registry keyed by StudioId supplies: adapter factory (CockpitDeps + wsHash), lazy client chunk
loader, CSS co-load keys, parent policy (new and edit separately), nav-tab policy, titles, CSP
needs, legacy viewType (serializer migration).

Parent/nav policy:

| studio | new → | edit → | nav tab |
|---|---|---|---|
| task | section mission | task-detail(ws, id) | mission |
| agent, terminal, command, runbook, schedule | section fleet | section fleet | fleet |
| pin | returnRoute slot | returnRoute slot | none (`navSection: null`, nav-less) |

`returnRoute` (pin only, R1-F12): captured ONCE at studio-route entry = last COMMITTED non-studio
route; validated via `decodeRoute`; studio kinds excluded by construction; persisted in
CockpitPanelState; fallback section "overview" on invalidation/revive-mismatch. Never structural
inference.

## Host: StudioRouteHost (src/cockpit/studioHost.ts)

ONE active binding `{generation, mountNonce, route, adapter, mode, entityId, entity, referenceData,
patch, dirty, editRevision, saveInFlight, loadFailed}` — same lifecycle-owned-by-route-transition
pattern as the Activity feed (C.2): `navigate()` tears down a mismatched binding synchronously,
`ensureStudioBinding()` from sendSectionModule, every async continuation checks
`isCurrent(generation)`. A DIRTY binding is never torn down silently — the navigation transaction
(below) sits in front of `navigate()`.

**Mount handshake (R2-F3)**: the host issues a fresh `mountNonce` per binding; the model push
carrying a studio route includes it; the studio App posts `studioReady{routeKey, mountNonce}` on
mount; the host sends NOTHING (no load, no restore) until an exact routeKey+nonce match arrives.
Nonce invalidated on every unmount/binding replacement/committed navigation — including re-entry to
the identical routeKey.

## Wire protocol

Studio messages keep the `studioProtocolVersion` envelope and ride the cockpit channel. Host
dispatch: FIRST branch checks `"studioProtocolVersion" in msg` → studioHost, gated on currentRoute
being studio-*; collision-immune by construction (cockpit's own wire strings never carry the
field). Client: cockpit main.tsx forwards enveloped host messages into the studio App's props;
studio Apps keep `decodeStudioMessage` unchanged.

## Navigation transaction (R1-F1, R2-F1/F2 — the core mechanism)

ONE serialized host-side transaction for ANY route change away from an active studio route,
regardless of origin (client tab click, host deep-link, command, serializer redirect). This is the
C.0 dueto's two-phase proposal protocol, realized:

- Client stamps a monotonic `editRevision` on every patch{}/dirty{}.
- Txn: host allocates txnId (ONE active max; concurrent intents rejected with a toast) → posts
  `navCheckpoint{txnId}` → client freezes the form (read-only overlay, delayed ~150ms to avoid
  flashing on the clean fast path; Save/Cancel disabled) → replies
  `navCheckpointAck{txnId, dirty, editRevision, patch}` reflecting freeze-moment state → host
  decides on that FRESH data: clean → commit; dirty → 3-option native modal (§ Draft policy) while
  the form stays frozen → commit or `navAbort{txnId}` (client acks unfreeze).
- Client-originated nav MAY fold the checkpoint into the navigate request iff the client freezes
  synchronously BEFORE posting (`navigate{target, dirty, editRevision, patch}`) — one RTT saved;
  host-originated nav always uses the explicit checkpoint.
- **Timeout NEVER authorizes navigation** (R2-F1): on checkpoint-ack timeout the route stays
  unchanged; host retries; after bounded retries it surfaces an explicit recovery notice ("editor
  not responding — reload window to recover") — it never falls back to last-known dirty state.
- **Complete FSM** (R2-F2): every path — save-ok/save-error/saveRejected/navAbort/commit/panel
  dispose/exception/message loss — has a specified terminal that releases the txn slot and
  unfreezes (or destroys) the form. Terminal messages are idempotent; either side can post
  `studioResync` to query authoritative txn/save state; checkpoint handling stays active while
  save-frozen. No toast-as-recovery.

## Save / cancel (R1-F2/F3)

- Save freezes the form for the ENTIRE save (optimistic client freeze on click + `save{editRevision}`);
  no edits can occur mid-save, so no revision drift. save-ok → clear dirty → afterSave nav through
  the txn machine (trivially clean). save-error → `saveRejected` → unfreeze, still dirty.
- Mutual exclusion: while saveInFlight, cancel and nav-txn starts are rejected; while a txn is
  pending, save is rejected. `adapter.onCancel` cleanup therefore never races a committing save.
- Save no longer disposes anything — it navigates.

## Draft policy (product sign-off 2026-07-21: 3-option + cache)

Dirty nav-away modal: **Save / Leave and keep draft / Discard**.

- "Leave and keep draft" → the checkpoint ack's patch enters a host-side bounded cache. "Discard"
  DELETES any matching cache entry (R2-F4 — Discard must actually discard; the cache is never
  populated under Discard).
- Cache bounds (R2-F5): capacity 4 entries AND total serialized bytes ≤ 2MB (per-entry ≤ 1MB), TTL
  30min, LRU evict; keyed by full identity {studio, wsHash, entityId|"new", entityType} — never a
  hash alone; cleared on workspace detach; consumed ONE-SHOT on re-entry (entry deleted at apply).
- Re-entry: load entity fresh, then apply cached patch as restore-patch + dirty. Staleness guard
  (R1-F13): `contentFingerprint` = hash of the entity snapshot the draft was made against; mismatch
  → do NOT auto-apply; surface StudioFrame's stale banner with reload-clean vs keep-draft choice.

## Persistence / revive (R1-F4/F5/F15, R2-F7)

- The client is the ONLY setState writer after boot; every payload carries a monotonic
  `stateRevision` and the write is compare-before-write (lower/equal revision → skipped). Model
  pushes carry their authoritative navEpoch; the client drops models older than the latest applied
  epoch BEFORE assigning a stateRevision (receipt order is not authority). Boot's HTML-stamped
  write is conditional on no newer state existing.
- Route commits persist synchronously; patch writes debounce 300ms + flush on visibilitychange/blur.
  Residual loss window (final <300ms of typing on a hard crash) is explicitly accepted.
- Oversize drafts (serialized patch > 512KB): persisted as `{dirty:true, patch:null,
  unprotected:"too-large"}` + persistent non-blocking StudioFrame banner ("draft too large to
  survive a reload — save soon"). No silent lie.
- Revive at a studio route: host seeds restore ONLY on exact routeKey match between persisted state
  and the committing route; `decideRestore`'s fail-closed rule unchanged (load-failed → discard).
- Side effect: fixes the pre-existing gap where Control revived at its creation-time route.

## Legacy migration (R1-F7, R2-F6 — exactly-once custody)

Per-studio legacy serializers:

- CLEAN snapshot → dispose + redirect immediately (nothing to lose).
- DIRTY snapshot → the legacy panel STAYS ALIVE and becomes READ-ONLY; snapshot gets a stable
  `migrationId` + content hash; Control durably records idempotent acceptance (duplicate
  migrationId → return existing result) BEFORE acking; only after confirmed custody does the legacy
  panel dispose (disposal retried without resuming edits). Control dying pre-acceptance → legacy
  panel remains the recoverable copy. Destination route already holding a dirty binding → migration
  parks and surfaces a conflict notice instead of overwriting.

## referenceData contract (R1-F10, R2-F8)

Pushes carry a version; pure merge keyed by stable IDs. ADD + presentation-only UPDATEs apply
always; REMOVALs and semantic UPDATEs touching referenced dirty fields are DEFERRED while dirty,
with impacted selections marked by a non-destructive stale indicator; host-side save() revalidation
stays the authoritative backstop.

## CSP (R1-F8/F9 — deferred, gated)

- D0/D1: ZERO CSP change (Command/Terminal/Runbook/Schedule/Agent need nothing beyond base).
- D2 (task) / D3 (pin): the union (imgBlob, connectSrc, workerSrc:"blob", childSrc:"blob") lands
  with: exact-origin connect-src scoped to audited need; no unsafe-inline/eval (shell law); an
  adversarial security probe on the CSP diff before landing; explicit maintainer security
  acceptance recorded in the PR. Sandboxed-iframe isolation for Excalidraw evaluated at D3.
- localResourceRoots: computed ONLY from the committed route, REPLACE semantics, applied
  synchronously in the route-commit path; async mutation of `webview.options` is banned (lint-style
  test).

## Sequencing (one PR per group, standard landing ritual)

| PR | Contents | Retires |
|---|---|---|
| D0 | route kinds + registry + StudioRouteHost + nav-txn FSM + mount handshake + persistence + draft cache + **Command Studio** (pilot: simplest adapter, no CSP) | CommandStudioPanel |
| D1 | Terminal + Runbook + Schedule + Agent Studio | 4 panel hosts |
| D2 | Task Studio (CAS, rich-doc, visuals, task-edit→task-detail chain, openTaskStudio callers) + CSP tranche 1 + security probe | TaskStudioPanel — closes C.1b |
| D3 | Pin Studio (Excalidraw, attachment roots, nav-less returnRoute) + CSP tranche 2 + security probe | PinStudioPanel — closes C.4 |

D0 implementation-risk order (round-2 probe): FSM → epoch/ordering → mount handshake → cache →
legacy migration → referenceData. D0's DoD includes a design-conformance probe on the REAL FSM code
(the residual risk is implementation-shaped; that's where the third adversarial pass goes).
