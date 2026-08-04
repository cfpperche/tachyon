/**
 * D12's explicit unsaved-edit policy. A draft belongs to the task document, not to its visible mode:
 * switching to read keeps it, closing keeps it in the manager for this extension-host lifetime, and a
 * newer host snapshot becomes the read model while the draft remains based on its original revision.
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

  constructor(mode: TaskDocumentMode = "read", draft: TaskDocumentDraft<TPatch> = { dirty: false }) {
    this.mode = mode;
    this.draft = draft;
  }

  switchMode(mode: TaskDocumentMode): void { this.mode = mode; }
  receivePatch(patch: TPatch): void { this.draft = { ...this.draft, patch }; }
  receiveDirty(dirty: boolean): void { this.draft = { ...this.draft, dirty }; }
  /** The host snapshot updates read mode; it never rewrites a draft whose CAS base is inside the patch. */
  receiveHostSnapshot(): void { /* policy is intentionally non-mutating */ }
  clearDraft(): void { this.draft = { dirty: false }; }

  /** Closing detaches the draft from the panel; the manager retains this value under the document key. */
  close(): TaskDocumentDraft<TPatch> | undefined {
    return this.draft.dirty ? this.draft : undefined;
  }
}
