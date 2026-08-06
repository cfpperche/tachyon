/**
 * D12's explicit unsaved-edit policy. A draft belongs to the task document. The document hosts no longer
 * expose a mode switch that silently preserves a draft: Cancel now asks the human to save, discard, or
 * continue editing. Closing the tab is intentionally different: `close()` still returns a dirty draft for
 * the manager to retain during this extension-host lifetime. A newer host snapshot becomes the read model
 * while the retained draft remains based on its original revision.
 * Save therefore still uses CAS and must surface a conflict instead of overwriting the newer snapshot.
 *
 * This is deliberately smaller than StudioPanelManagerBase: mode, dirty and patch are carried in; generic
 * new-entity lifecycle, navigation transactions, save/cancel routing and a second panel key are left out.
 */
export type TaskDocumentMode = "read" | "edit";

export interface TaskDocumentDraft<TPatch> {
  patch?: TPatch;
  dirty: boolean;
}

export class TaskDocumentEditPolicy<TPatch> {
  mode: TaskDocumentMode;
  draft: TaskDocumentDraft<TPatch>;
  /**
   * t-b643ac — the entity this draft belongs to has been PROVEN GONE (`adapter.load` → `not-found`).
   *
   * The policy had no opinion about this, and the silence was a bug rather than an omission. Retention
   * is keyed by document identity, so a draft left behind for a removed agent named `grok` is restored
   * into the studio of the NEXT agent created under that name — unsaved edits for one entity landing
   * on a different one. Latched, not a plain `clearDraft()`, because retention is decided at `close()`
   * and a `patch`/`dirty` message already in flight would otherwise re-dirty the draft after it was
   * cleared and put it straight back into the cache.
   *
   * Discarding rather than preserving is the rule this repo already applies one notch weaker:
   * `restoreDecisions.ts` ("when in doubt, restore LESS") and the retired Control host's fingerprint
   * check ("edits computed against content that no longer exists"; studioHost.ts, deleted in
   * t-337cdf). Removal is that mismatch at its limit.
   */
  private vanished = false;

  constructor(mode: TaskDocumentMode = "read", draft: TaskDocumentDraft<TPatch> = { dirty: false }) {
    this.mode = mode;
    this.draft = draft;
  }

  switchMode(mode: TaskDocumentMode): void { this.mode = mode; }
  receivePatch(patch: TPatch): void { if (this.vanished) return; this.draft = { ...this.draft, patch }; }
  receiveDirty(dirty: boolean): void { if (this.vanished) return; this.draft = { ...this.draft, dirty }; }
  /** The host snapshot updates read mode; it never rewrites a draft whose CAS base is inside the patch. */
  receiveHostSnapshot(): void { /* policy is intentionally non-mutating */ }
  clearDraft(): void { this.draft = { dirty: false }; }

  /** Whether there was unsaved work at the moment the entity vanished — the tombstone says so if there was. */
  entityVanished(): boolean {
    const hadDraft = this.draft.dirty && this.draft.patch !== undefined;
    this.vanished = true;
    this.draft = { dirty: false };
    return hadDraft;
  }

  get isVanished(): boolean { return this.vanished; }

  /** Closing detaches the draft from the panel; the manager retains this value under the document key. */
  close(): TaskDocumentDraft<TPatch> | undefined {
    if (this.vanished) return undefined;
    return this.draft.dirty ? this.draft : undefined;
  }
}
