/**
 * t-610705 (SDD 410 Phase D, D0) — Control's studio host: the ONE binding that replaces
 * StudioPanelManagerBase's one-vscode-panel-per-entity lifecycle for studios migrated onto a route
 * (studios-routes-design.md). Generic over the adapter contract (StudioHostAdapter) exactly like the
 * base class was — only the OUTER lifecycle changes (route-driven single binding instead of a
 * Map<key,panel>), the adapter/protocol/StudioFrame surface is untouched.
 *
 * Hardened via THREE adversarial duetos (probe-ad112b99 REDESIGN round 1, probe-393d5244 REDESIGN
 * round 2, probe-c4b9e1e1 REDESIGN round 3 — an implementation-level pass that caught real bugs in
 * round 1/2's own first cut of this file; journal on t-610705). Load-bearing decisions, all
 * implemented here:
 *
 *  - ONE TRANSACTION LOCK FOR THE WHOLE OPERATION (round-3 blocker #1): `txnLock` is held from the
 *    moment `beginStudioNavTransaction` starts until it returns (committed/aborted/busy), covering
 *    checkpoint-wait AND the discard/save/leave-draft modal AND any resulting save — NOT just the
 *    ack-wait phase. Round 1/2's design correctly called for a serialized transaction; round 1/2's
 *    FIRST implementation attempt cleared its lock the moment the ack arrived (conflating "waiting
 *    for the checkpoint reply" with "the transaction is in progress"), which let a second
 *    navigation, a save, or cancel slip in while the discard-choice modal was still open. `activeTxn`
 *    (the ack-wait resolver) and `txnLock` (the whole-transaction guard) are now two different
 *    things on purpose — every busy/exclusion check below reads `txnLock`, not `activeTxn`.
 *  - TIMEOUT ALWAYS UNFREEZES (round-3 major): a checkpoint-ack timeout resolves "timeout" (never
 *    authorizes navigation, round-2 F1 — unchanged) AND posts `studioNavAbort` so a client that
 *    freezes late (its ack lost/delayed past the 3s window) still gets released instead of staying
 *    frozen forever.
 *  - SAVE ACTUALLY FREEZES THE CLIENT (round-3 blocker #2): `beginStudioSave` now posts
 *    `studioSaveBegin`/`studioSaveEnd` around the adapter call — round 1/2's first implementation
 *    only set a HOST-side `saveInFlight` flag and never told the client to stop accepting edits, so
 *    edits typed during a save were silently dropped (host state and client state diverged). The
 *    client's `useStudioFreeze` treats `studioSaveBegin` identically to a checkpoint-freeze.
 *  - DRAFT RESTORE IS PEEK-THEN-CONSUME, FINGERPRINT-CHECKED (round-3 major): the old
 *    `takeDraftFor` deleted the cache entry BEFORE `adapter.load` even ran, so a load failure or a
 *    torn-down binding silently lost the draft. `peekDraftFor` is non-destructive; `sendStudioLoad`
 *    only calls `consumeDraftFor` (delete) after a SUCCESSFUL load whose entity's fingerprint
 *    matches what the draft was made against — a stale draft (entity changed elsewhere since) is
 *    discarded rather than silently applied over content it was never actually diffed against.
 *  - MOUNT HANDSHAKE (round-2 F3): a fresh `mountNonce` per binding; the studio App's "ready" message
 *    must echo BOTH the current routeKey AND mountNonce before the host sends load/restore.
 *  - DRAFT CACHE (round-1 F6, round-2 F4/F5 — product sign-off 2026-07-21, 3-option dialog): "Leave
 *    and keep draft" caches the checkpoint ack's patch, bounded (capacity + byte cap + TTL). Because
 *    `txnLock` now serializes transactions end-to-end, the round-3-flagged "Discard from a NEWER
 *    transaction can be reinserted by an OLDER overlapping transaction's Leave-and-keep-draft" hole
 *    is closed structurally — overlapping transactions can no longer exist at all.
 *  - KNOWN, DOCUMENTED LIMITATION (round-3 major, NOT fixed here — scope note, not a silent gap):
 *    `draftIdentityKey` for a `studio-new` route is `${studio}:${wsHash}:new` — every "create a new
 *    X" visit for the same studio+workspace shares that ONE slot. Starting a second unrelated new-
 *    entity draft and choosing "Leave and keep draft" overwrites whatever new-entity draft was kept
 *    before. Fixing this properly needs a client-generated per-creation-session id threaded through
 *    the route/persistence layer — out of scope for D0's pilot; flagged for D1+ if it proves to
 *    matter in practice (single-slot "one abandoned new-entity draft at a time" is a reasonable
 *    default, just not the CORRECT one for two truly independent abandoned creations).
 */
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { routeKey, type CockpitRoute, type CockpitStudioEditRoute, type CockpitStudioNewRoute } from "./route.js";
import type { StudioHostAdapter } from "../webview/shared/studio/adapter.js";
import { decodeStudioMessage, envelope, type StudioConcurrencyState } from "../webview/shared/studio/protocol.js";
import { mapUnknownError, type StudioError } from "../webview/shared/studio/errorTaxonomy.js";

export type StudioRoute = CockpitStudioNewRoute | CockpitStudioEditRoute;

export interface StudioHostIO {
  post: (msg: unknown) => void;
  /** True while this panel is still the live one Cockpit wants on screen — same isCurrent()
   *  contract as activityFeed.ts's ActivityFeedIO, checked before every observable action. */
  isCurrent: () => boolean;
}

/** Opaque generics collapsed to `unknown` at the host boundary — the host never interprets entity/
 *  patch/referenceData content, only proxies it between the adapter and the wire (same "generic over
 *  the adapter" contract StudioPanelManagerBase already had; only the outer lifecycle changed). */
type Adapter = StudioHostAdapter<unknown, unknown, unknown, unknown>;

interface Binding {
  route: StudioRoute;
  generation: number;
  mountNonce: string;
  adapter: Adapter;
  mode: "new" | "edit";
  entityId: string | undefined;
  entity: unknown;
  referenceData: unknown;
  patch: unknown;
  editRevision: number;
  dirty: boolean;
  saveInFlight: boolean;
  loadFailed: boolean;
}

let binding: Binding | undefined;
let generationCounter = 0;

/** Teardown-only — call synchronously from Cockpit.ts's `navigate()` (the one place currentRoute
 *  changes), mirroring `reconcileActivityTeardown`'s contract exactly: a same-identity re-entry
 *  (routeKey match) is a no-op (`ensureStudioBinding` replays it), anything else tears down. */
export function reconcileStudioTeardown(nextRoute: CockpitRoute): void {
  if (!binding) return;
  if (routeKey(nextRoute) === routeKey(binding.route)) return;
  binding = undefined;
}

export function stopStudioBinding(): void {
  binding = undefined;
}

export function currentStudioBindingFor(route: CockpitRoute): { mountNonce: string } | undefined {
  if (!binding || routeKey(route) !== routeKey(binding.route)) return undefined;
  return { mountNonce: binding.mountNonce };
}

export type StudioAdapterFactory = (route: StudioRoute) => Adapter | undefined;

/** Start-if-missing, same idempotent-on-same-identity convention as ensureActivityBinding: a
 *  same-route re-entry (cockpit reload, reveal) replays the existing binding rather than restarting
 *  it. Returns false when the adapter can't be resolved (workspace gone) — caller renders empty. */
export function ensureStudioBinding(route: StudioRoute, makeAdapter: StudioAdapterFactory): boolean {
  if (binding && routeKey(binding.route) === routeKey(route)) return true;
  const adapter = makeAdapter(route);
  if (!adapter) { binding = undefined; return false; }
  generationCounter += 1;
  binding = {
    route,
    generation: generationCounter,
    mountNonce: randomUUID(),
    adapter,
    mode: route.kind === "studio-new" ? "new" : "edit",
    entityId: route.kind === "studio-edit" ? route.entityId : undefined,
    entity: undefined,
    referenceData: undefined,
    patch: undefined,
    editRevision: 0,
    dirty: false,
    saveInFlight: false,
    loadFailed: false,
  };
  return true;
}

function concurrencyStateFor(adapter: Adapter, entity: unknown): StudioConcurrencyState {
  if (adapter.concurrency.kind === "none") return { kind: "none" };
  return { kind: "cas", expected: adapter.revisionOf?.(entity) ?? "" };
}

/** Pushes the current binding's `load` envelope (or `error` on load failure) — call once a binding
 *  exists and the client's mount handshake has landed for it. On success, checks a peeked draft's
 *  fingerprint against the JUST-loaded entity and only THEN consumes (deletes) the cache entry —
 *  round-3 major: a load failure or a fingerprint mismatch must never lose or misapply a draft. */
export async function sendStudioLoad(io: StudioHostIO): Promise<void> {
  const b = binding;
  if (!b) return;
  const generation = b.generation;
  const peeked = peekDraftFor(b.route);
  try {
    const result = await b.adapter.load(b.entityId);
    if (!io.isCurrent() || binding !== b || binding.generation !== generation) return;
    if (result.status !== "ok") {
      b.loadFailed = true;
      const message = result.status === "not-found" ? "not found" : result.error;
      io.post(envelope(errorEnvelope(mapUnknownError("persistence", new Error(message), `persistence/${result.status}`))));
      return; // peeked draft left in the cache — a load failure must not lose it
    }
    b.loadFailed = false;
    b.entity = result.entity;
    b.referenceData = result.referenceData;
    io.post(envelope({
      type: "load",
      entity: result.entity,
      ...(result.referenceData !== undefined ? { referenceData: result.referenceData } : {}),
      concurrency: concurrencyStateFor(b.adapter, result.entity),
      saveInFlight: b.saveInFlight,
    }));
    if (peeked) {
      if (peeked.contentFingerprint === fingerprintOf(result.entity)) {
        consumeDraftFor(b.route);
        b.patch = peeked.patch;
        b.editRevision = peeked.editRevision;
        b.dirty = true;
        io.post(envelope({ type: "restore", snapshot: { schemaVersion: 1 as const, entityType: b.adapter.entityType, mode: b.mode, patch: peeked.patch } }));
      } else {
        // the entity changed elsewhere since the draft was made — "when in doubt, restore LESS"
        // (restoreDecisions.ts's own rule): discard the stale draft rather than silently applying
        // edits computed against content that no longer exists.
        consumeDraftFor(b.route);
      }
    }
  } catch (err) {
    if (!io.isCurrent() || binding !== b || binding.generation !== generation) return;
    b.loadFailed = true;
    io.post(envelope(errorEnvelope(mapUnknownError("transport", err))));
  }
}

function errorEnvelope(error: StudioError) {
  return { type: "error" as const, code: error.code, message: error.message, source: error.source, blocking: error.blocking };
}

/**
 * Handles an inbound message carrying `studioProtocolVersion` for the CURRENT binding. Returns
 * false (unhandled) when there is no binding or the message is a domain type with no registered
 * handler — callers treat false as "not for me", not an error.
 */
export interface StudioMessageHooks {
  onChanged: () => void;
  notify: (message: string, level?: "info" | "warn" | "error") => void;
  handleDomainMessage?: (ctx: { post: (m: unknown) => void }, message: { type: string }) => void;
}

export async function handleStudioMessage(io: StudioHostIO, raw: unknown, hooks: StudioMessageHooks): Promise<boolean> {
  const b = binding;
  if (!b) return false;
  const decoded = decodeStudioMessage<{ type: string; routeKey?: string; mountNonce?: string; patch?: unknown; editRevision?: number; dirty?: boolean }>(raw, ["browse", "cwd"]);
  if (!decoded.ok || !decoded.message) return false;
  const msg = decoded.message;
  // t-610705 (Phase D, D0, round-5 blocker) — EVERY binding-scoped message must match the CURRENT
  // binding's identity, not just "ready" (round-2 F3 only closed the mount-handshake case). A
  // message the client sent for a PRIOR mount (e.g. a "patch" already in flight when the route
  // changed) must never mutate/act on whatever binding replaced it — the client now attaches
  // routeKey+mountNonce to EVERY message it posts (command-studio-shell/App.tsx's `post` wrapper),
  // so this check covers patch/dirty/save/cancel/domain messages the exact same way "ready" already
  // was covered. Returns true ("handled" — silently ignored, not a protocol error): a stale message
  // from a torn-down mount is expected traffic, not a client bug to surface.
  if (msg.routeKey !== routeKey(b.route) || msg.mountNonce !== b.mountNonce) return true;
  switch (msg.type) {
    case "ready": {
      await sendStudioLoad(io);
      return true;
    }
    case "patch":
      // frozen (save in flight or a transaction in progress) — the client-side freeze already
      // prevents this from being sent in the first place; this is defense-in-depth, not the
      // primary mechanism (round-3 major — see useStudioFreeze.ts for the actual edit-blocking).
      if (b.saveInFlight || txnLock) return true;
      b.patch = msg.patch;
      b.editRevision = msg.editRevision ?? b.editRevision + 1;
      return true;
    case "dirty":
      if (b.saveInFlight || txnLock) return true;
      b.dirty = msg.dirty ?? false;
      return true;
    case "save":
      await beginStudioSave(io, hooks);
      return true;
    case "cancel":
      // t-610705 (Phase D, D0) — Cancel stays an UNCONFIRMED direct discard, matching every existing
      // studio App's current behavior (none of the 7 wire `requiresDiscardConfirmation` today — Cancel
      // is a deliberate explicit action, unlike an accidental nav-away, which the transaction guards).
      // Excluded for the WHOLE transaction window (txnLock), not just while a save is in flight
      // (round-3 major) — a queued Cancel must never land while a discard-choice modal is still open.
      if (b.saveInFlight || txnLock) return true;
      discardDraft(b.route);
      hooks.onChanged();
      return true;
    default:
      hooks.handleDomainMessage?.({ post: io.post }, msg as { type: string });
      return true;
  }
}

/**
 * t-610705 (Phase D, D0, round-4 blocker) — EVERY exit path posts `studioSaveEnd`. The client
 * optimistically freezes (via `freezeForSave()`) the instant Save is clicked, BEFORE this function
 * even runs — round-3's first fix only posted `studioSaveEnd` from the success-path `finally`, so an
 * early return here (no binding, already saving, nothing to save, or a nav transaction holds the
 * lock) left the client frozen with no terminal signal, ever. `io.post` is safe to call even when
 * `!b` — the studio component that froze itself is either still mounted (gets the unfreeze) or
 * already unmounted (the post is a harmless no-op, studioFreezeBus.dispatchStudioFreezeMessage
 * returns false with no listener registered).
 */
async function beginStudioSave(io: StudioHostIO, hooks: StudioMessageHooks): Promise<void> {
  const b = binding;
  if (!b || b.saveInFlight || b.patch === undefined) { io.post({ type: "studioSaveEnd" }); return; }
  // t-610705 (round-4 NEW blocker) — a regular save and a navigation transaction are ALSO mutually
  // exclusive from THIS direction (txnLock already rejected save-during-nav; this rejects
  // nav-during-save in beginStudioNavTransaction below). Without this, an in-flight save's own
  // `studioSaveEnd` could unfreeze the client while a LATER-started nav transaction's modal was
  // still open host-side, letting the user type new edits that the transaction's stale ack/patch
  // would then silently lose.
  if (txnLock) { io.post(envelope(errorEnvelope({ code: "studio/busy", message: "A navigation is in progress.", source: "transport", blocking: false }))); io.post({ type: "studioSaveEnd" }); return; }
  b.saveInFlight = true;
  // t-610705 (Phase D, D0, round-3 blocker #2) — freeze the CLIENT, not just host-side state: the
  // client optimistically freezes itself the instant Save is clicked (see useStudioFreeze.ts's
  // freezeForSave()), and this confirms/re-asserts it — closing the case where Save was triggered by
  // something other than the normal button click path.
  io.post({ type: "studioSaveBegin" });
  try {
    const result = await b.adapter.save(b.entityId, b.patch);
    if (!io.isCurrent() || binding !== b) return;
    if (result.status === "ok") {
      b.dirty = false;
      b.patch = undefined;
      discardDraft(b.route); // saved, not abandoned — nothing left to keep as a draft
      hooks.onChanged();
      io.post(envelope({ type: "save", status: "ok" as const }));
    } else {
      const error: StudioError = result.status === "conflict"
        ? { code: result.error.code, message: result.error.message, source: "transport", blocking: true }
        : { code: result.error.code, message: result.error.message, source: result.error.source, blocking: true };
      io.post(envelope(errorEnvelope(error)));
    }
  } catch (err) {
    if (io.isCurrent() && binding === b) io.post(envelope(errorEnvelope(mapUnknownError("transport", err))));
  } finally {
    if (binding === b) b.saveInFlight = false;
    if (io.isCurrent()) io.post({ type: "studioSaveEnd" });
  }
}

// ---------------------------------------------------------------------------------------------
// Draft cache (round-1 F6, round-2 F4/F5, round-3 major fixes) — module scope so it survives the
// binding that populated it (the whole point: the entity is gone, the DRAFT must outlive it).
// ---------------------------------------------------------------------------------------------

interface DraftEntry { patch: unknown; editRevision: number; contentFingerprint: string; cachedAt: number; bytes: number }

const DRAFT_CACHE_CAPACITY = 4;
const DRAFT_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const DRAFT_ENTRY_MAX_BYTES = 1 * 1024 * 1024;
const DRAFT_TTL_MS = 30 * 60 * 1000;
/** Map iteration order = insertion order in V8 — re-`set`ting an existing key (after `delete`) moves
 *  it to the end, which is what makes this a correct LRU with plain Map operations. */
const draftCache = new Map<string, DraftEntry>();

function draftIdentityKey(route: StudioRoute): string {
  // KNOWN LIMITATION for studio-new — see the module doc's last bullet.
  return `${route.studio}:${route.wsHash}:${route.kind === "studio-edit" ? route.entityId : "new"}`;
}

function fingerprintOf(entity: unknown): string {
  const s = JSON.stringify(entity) ?? "";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

function pruneDraftCache(): void {
  const now = Date.now();
  for (const [k, v] of draftCache) if (now - v.cachedAt > DRAFT_TTL_MS) draftCache.delete(k);
  let total = 0;
  for (const v of draftCache.values()) total += v.bytes;
  while ((draftCache.size > DRAFT_CACHE_CAPACITY || total > DRAFT_CACHE_MAX_BYTES) && draftCache.size > 0) {
    const oldestKey = draftCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    total -= draftCache.get(oldestKey)?.bytes ?? 0;
    draftCache.delete(oldestKey);
  }
}

/** Populated ONLY by the "Leave and keep draft" outcome — never by Discard, never by Save. Because
 *  `txnLock` now serializes the whole transaction end-to-end, two transactions for the SAME identity
 *  can never be in flight at once — an older transaction's Leave-and-keep-draft can no longer land
 *  after a newer transaction's Discard (round-3 major, fixed structurally, not with a tombstone). */
function cacheDraft(route: StudioRoute, patch: unknown, editRevision: number, entity: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(patch) ?? "");
  if (bytes > DRAFT_ENTRY_MAX_BYTES) return; // too large for D0's session-only cache — dropped, not stored partially
  const key = draftIdentityKey(route);
  draftCache.delete(key);
  draftCache.set(key, { patch, editRevision, contentFingerprint: fingerprintOf(entity), cachedAt: Date.now(), bytes });
  pruneDraftCache();
}

function discardDraft(route: StudioRoute): void {
  draftCache.delete(draftIdentityKey(route));
}

/** Non-destructive read — round-3 major fix: the caller (sendStudioLoad) decides whether to consume
 *  based on whether the subsequent load actually succeeds AND the fingerprint still matches. */
function peekDraftFor(route: StudioRoute): DraftEntry | undefined {
  return draftCache.get(draftIdentityKey(route));
}

function consumeDraftFor(route: StudioRoute): void {
  draftCache.delete(draftIdentityKey(route));
}

// ---------------------------------------------------------------------------------------------
// Navigation transaction (round-1 F1, round-2 F1/F2, round-3 blocker #1) — the core mechanism.
// ---------------------------------------------------------------------------------------------

interface PendingAck {
  txnId: string;
  resolve: (ack: { dirty: boolean; editRevision: number; patch: unknown } | "timeout") => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The ack-wait resolver ONLY — cleared the moment an ack (or timeout) arrives. Deliberately NOT the
 *  same thing as `txnLock` below (round-3 blocker #1's fix: conflating the two let a second
 *  transaction start the instant the FIRST one's ack landed, while its discard-choice modal was
 *  still open). */
let activeAck: PendingAck | undefined;

/** Held for the ENTIRE `beginStudioNavTransaction` call — checkpoint wait, the discard-choice modal,
 *  and any resulting save. Every busy/exclusion check in this module reads THIS, not `activeAck`. */
let txnLock: string | undefined;

/** Resolves a pending checkpoint from the client's ack — a stale/mismatched txnId (a late ack from
 *  a transaction the host already gave up on) is silently ignored. */
export function handleStudioNavCheckpointAck(msg: { txnId?: unknown; dirty?: unknown; editRevision?: unknown; patch?: unknown }): void {
  if (!activeAck || msg.txnId !== activeAck.txnId) return;
  clearTimeout(activeAck.timer);
  const resolve = activeAck.resolve;
  activeAck = undefined;
  resolve({ dirty: !!msg.dirty, editRevision: typeof msg.editRevision === "number" ? msg.editRevision : 0, patch: msg.patch });
}

const CHECKPOINT_TIMEOUT_MS = 3000;

function requestCheckpoint(io: StudioHostIO, txnId: string): Promise<{ dirty: boolean; editRevision: number; patch: unknown } | "timeout"> {
  return new Promise((resolve) => {
    activeAck = {
      txnId,
      resolve,
      timer: setTimeout(() => {
        if (activeAck?.txnId === txnId) activeAck = undefined;
        // round-3 major — a late/lost ack must not leave the client frozen forever: release it
        // even though this txnId is being abandoned (the client only unfreezes on a MATCHING
        // txnId's abort, so a stale abort from an earlier, already-superseded txn is harmless).
        io.post({ type: "studioNavAbort", txnId });
        resolve("timeout");
      }, CHECKPOINT_TIMEOUT_MS),
    };
    io.post({ type: "studioNavCheckpoint", txnId });
  });
}

export type StudioNavOutcome = "committed" | "aborted" | "busy";

/**
 * The ONE gate for navigating away from an active studio route. `commit` is the caller's original
 * navigate-and-repush closure (e.g. `() => { navigate(route); void sendModel(); void
 * sendSectionModule(); }`) — invoked exactly once, only on a clean checkpoint or a resolved (Save/
 * Leave-and-keep/Discard) dirty checkpoint. Never invoked on timeout, Stay, or a rejected save —
 * `currentRoute` (and the client's frozen-but-intact form) is untouched in every "aborted" case.
 * `txnLock` is held for the FULL duration (round-3 blocker #1) — a second call while one is already
 * in flight returns "busy" immediately, and stays that way through the discard-choice modal, not
 * just through the initial checkpoint round-trip.
 */
export async function beginStudioNavTransaction(io: StudioHostIO, commit: () => void): Promise<StudioNavOutcome> {
  const b = binding;
  if (!b) { commit(); return "committed"; } // no binding to protect — nothing to lose
  // t-610705 (round-4 NEW blocker) — reject while a REGULAR save is in flight too, not just while
  // another transaction holds txnLock: a save's own studioSaveEnd unconditionally unfreezes the
  // client (a plain boolean, not reference-counted), so letting a checkpoint's freeze START during
  // an in-flight save would have that freeze silently released the moment the UNRELATED save
  // finishes — the client could then edit again while this transaction's modal was still deciding.
  if (txnLock || b.saveInFlight) return "busy";
  const txnId = randomUUID();
  txnLock = txnId;
  try {
    const ack = await requestCheckpoint(io, txnId);
    if (!io.isCurrent() || binding !== b) return "aborted"; // torn down while the checkpoint was in flight
    if (ack === "timeout") {
      // round-2 F1 — NEVER authorize navigation from a timed-out/stale state. The route stays put;
      // the caller surfaces this as a notification, not a silent no-op (Cockpit.ts's requestNavigate).
      return "aborted";
    }
    if (!ack.dirty) {
      commit();
      return "committed";
    }
    const choice = await vscode.window.showWarningMessage(
      "This form has unsaved changes.",
      { modal: true },
      "Save",
      "Leave and keep draft",
      "Discard",
    );
    if (!io.isCurrent() || binding !== b) return "aborted";
    if (choice === undefined) {
      io.post({ type: "studioNavAbort", txnId });
      return "aborted";
    }
    if (choice === "Save") {
      b.patch = ack.patch;
      b.editRevision = ack.editRevision;
      b.saveInFlight = true;
      io.post({ type: "studioSaveBegin" }); // client is already frozen from the checkpoint; re-assert defensively
      try {
        const result = await b.adapter.save(b.entityId, ack.patch);
        if (!io.isCurrent() || binding !== b) return "aborted";
        if (result.status !== "ok") {
          const error: StudioError = result.status === "conflict"
            ? { code: result.error.code, message: result.error.message, source: "transport", blocking: true }
            : { code: result.error.code, message: result.error.message, source: result.error.source, blocking: true };
          io.post(envelope(errorEnvelope(error)));
          io.post({ type: "studioNavAbort", txnId });
          return "aborted";
        }
        discardDraft(b.route);
        commit();
        return "committed";
      } finally {
        if (binding === b) b.saveInFlight = false;
        if (io.isCurrent()) io.post({ type: "studioSaveEnd" });
      }
    }
    if (choice === "Leave and keep draft") {
      cacheDraft(b.route, ack.patch, ack.editRevision, b.entity);
    } else {
      discardDraft(b.route); // "Discard" — defensive: normally nothing cached yet this session
    }
    commit();
    return "committed";
  } finally {
    if (txnLock === txnId) txnLock = undefined;
  }
}

/**
 * TEST-ONLY. This module's binding/draft-cache/transaction state is process-lifetime module scope
 * (same convention as activityFeed.ts's binding) — real production code never needs to reset it, but
 * a test suite reusing the same module instance across many `it()` blocks does: a test that leaves a
 * checkpoint unanswered (e.g. asserting "busy" without ever resolving the pending transaction) would
 * otherwise leak a live `txnLock` and a real 3s timer into every LATER test in the same file,
 * silently starving their own checkpoints of a "busy"-free path (found via exactly that leak during
 * D0's own test-writing — see cockpitStudio.test.ts).
 */
export function __resetStudioHostForTests(): void {
  binding = undefined;
  generationCounter = 0;
  if (activeAck) { clearTimeout(activeAck.timer); activeAck = undefined; }
  txnLock = undefined;
  draftCache.clear();
}
