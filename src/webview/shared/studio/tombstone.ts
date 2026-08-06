/**
 * t-b643ac — the studio shell's TOMBSTONE decision, pure and DOM-free (same shape as dirtyGating.ts /
 * restoreDecisions.ts / errorTaxonomy.ts: a decision every host and every shell reads, implemented once).
 *
 * ## What this exists to stop
 *
 * `adapter.load()` answering `not-found` used to be posted as an `error`. The client cannot distinguish
 * "your load failed" from "the thing you are editing is gone", so it drew both the same way: a red line
 * above a form still mounted from the PREVIOUS load, with every lifecycle action live and Save one
 * keystroke away from clickable (a field edit clears `hostError`, and `canSave` is then just `dirty`).
 *
 * ## Why it is a decision module and not an `if` in the host
 *
 * The five single-mode studios (command/terminal/runbook/schedule/agent) share ONE host and five
 * byte-identical clients. Both sides need the same two answers — "is this load result a tombstone?"
 * and "what does the tombstone say?" — so both read them from here rather than from a convention.
 *
 * ## The rule about drafts
 *
 * `decideVanishedDraft` is the whole of decision 3, and it is not new policy: `restoreDecisions.ts`
 * already says "when in doubt, restore LESS", and the retired Control host (studioHost.ts, deleted
 * in t-337cdf) discarded a draft whose fingerprint no longer matched the loaded entity ("edits
 * computed against content that no longer exists"). An entity that has been REMOVED is the strongest
 * form of that mismatch, so the draft is dropped — and, critically, dropped from the manager's
 * retained-draft cache too, because that cache is keyed by identity: keeping it would restore a dead
 * agent's unsaved edits onto a LATER agent created under the same name. The human is told, rather
 * than the loss being silent.
 */

/** Which `adapter.load()` outcomes mean the document's subject no longer exists. */
export interface TombstoneInput {
  status: "ok" | "not-found" | "error";
  /**
   * `undefined` for a new-entity panel. A `not-found` there is a broken adapter, not a removed
   * entity — nothing was ever supposed to be on disk — so it stays an error and is not tombstoned.
   */
  entityId: string | undefined;
}

export function isTombstone(input: TombstoneInput): boolean {
  return input.status === "not-found" && input.entityId !== undefined;
}

export interface VanishedDraftInput {
  dirty: boolean;
  hasPatch: boolean;
}

/** True when the human had unsaved work that this tombstone is about to discard (so it can say so). */
export function decideVanishedDraft(input: VanishedDraftInput): boolean {
  return input.dirty && input.hasPatch;
}

/** The webview-side view of a `tombstone` message — what the shared tombstone screen renders from. */
export interface StudioTombstoneInfo {
  entityType: string;
  entityId?: string;
  /** the last good title, absent when the panel never completed a load. */
  title?: string;
  discardedDraft: boolean;
}

/**
 * The one mapper every shell uses to turn the wire message into what it renders. Trivial by design —
 * its job is that five shells cannot drift on WHICH fields survive the boundary (a shell quietly
 * dropping `discardedDraft` would silently stop telling a human their work was thrown away).
 */
export function readTombstoneMessage(message: {
  entityType: string;
  entityId?: string;
  title?: string;
  discardedDraft: boolean;
}): StudioTombstoneInfo {
  return {
    entityType: message.entityType,
    ...(message.entityId !== undefined ? { entityId: message.entityId } : {}),
    ...(message.title !== undefined ? { title: message.title } : {}),
    discardedDraft: message.discardedDraft,
  };
}

/**
 * The messages a vanished panel may still act on. Everything else — `patch`, `dirty`, `save`, and
 * every adapter domain action (Forget/Rename/Export/Clone on an agent that is already gone) — is
 * dropped by the host. This is the enforcement half of decision 4: the button not existing is the
 * client being honest, THIS is the part a stale in-flight message cannot get around.
 *
 * `ready` stays open so a remounted webview is re-told it is a tombstone rather than hanging on
 * "Loading…"; `cancel` stays open because closing the tab is the only action left.
 */
const VANISHED_ALLOWED: ReadonlySet<string> = new Set(["ready", "cancel"]);

export function acceptsWhileVanished(messageType: string): boolean {
  return VANISHED_ALLOWED.has(messageType);
}
