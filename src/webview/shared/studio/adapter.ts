/**
 * spec 350 T1/T7 — the adapter surface: pure type contracts a studio adapter implements. Every hook here
 * maps to exactly one category from the adapter surface budget (README.md) — identity/lifecycle, layout
 * regions (StudioFrame.tsx), domain fields, validation, persistence, concurrency, domain actions. A hook
 * that needs to reach past header/dispatch/dirty-gating/error-mapping/save-cancel flow has no home here by
 * design; that is a spec amendment, not a quietly-added field.
 *
 * Vscode-free on purpose: StudioPanelManagerBase (host) and StudioFrame (webview) both consume these shapes,
 * and the pure decision modules (dirtyGating/restoreDecisions/errorTaxonomy) are unit-tested against them
 * with zero DOM or extension-host dependency.
 */

import type { StudioErrorSource, StudioValidationResult } from "./errorTaxonomy";

/** `none`: no CAS, last-write-wins. `cas`: the host tracks a per-load revision (`revisionOf`) and echoes it
 *  back as the save precondition; a `save()` returning `status: "conflict"` means the revision moved
 *  server-side since load — the shell surfaces the stale banner + retry/reload action, never a silent
 *  overwrite. Phase 1's fakes exercise `none`; Task Studio's real CAS anchoring (spec 339) is what a future
 *  Phase 2 migrates onto this contract. */
export type ConcurrencyContract = { kind: "none" } | { kind: "cas" };

/** Dirty tracking is ALWAYS adapter-declared (dueto F5/F6) — the shell never infers it from field diffing. */
export interface StudioDirtyHooks<TEntity, TFields, TPatch> {
  computeDirty(entity: TEntity | undefined, fields: TFields): boolean;
  /** builds the save patch from the current fields; `undefined` when nothing is actually dirty (a no-op save). */
  serializePatch(fields: TFields, dirty: boolean): TPatch | undefined;
  /** whether `fields` may be discarded without confirmation (e.g. matches the last loaded/saved snapshot). */
  canDiscard(fields: TFields): boolean;
}

export interface StudioLoadContext {
  asWebviewUri(fsPath: string): string;
}

export type StudioLoadResult<TEntity, TReferenceData = unknown> =
  /** t-610705 (Phase D, D2) — `persisted` defaults to `true` when omitted (every existing adapter's
   *  "ok" result stays correct with zero changes). Set it to `false` ONLY when `entityId` was
   *  provided but the entity does NOT actually exist in durable storage yet — a pre-minted-but-
   *  never-saved id (Task Studio's staged-create pattern: the id is reserved for the attachment
   *  namespace before the entity is created, see mintTaskId()'s doc comment). Drives
   *  `Binding.persisted` (studioHost.ts), which gates whether `adapter.onCancel` fires on abandonment
   *  — see `abandonProvisionalIfNeeded`'s doc comment for why this can't be inferred from `mode`. */
  | { status: "ok"; entity: TEntity; referenceData?: TReferenceData; persisted?: boolean }
  | { status: "not-found" }
  | { status: "error"; error: string };

export type StudioSaveResult =
  /** t-610705 (Phase D, D1d) — `entityId` is set ONLY when this save just PERSISTED A NEW entity
   *  (the adapter was called with `entityId: undefined`) — it's the id the host should now bind to,
   *  so a `studio-new` route stops being permanently stuck in "new" mode after its first successful
   *  save (see studioHost.ts's beginStudioSave doc comment for the full gap this closes). Absent for
   *  an edit-mode save (nothing about the bound entity's id changed). */
  | { status: "ok"; entityId?: string }
  | { status: "error"; error: { code: string; message: string; source: StudioErrorSource } }
  | { status: "conflict"; error: { code: string; message: string } };

export interface StudioHostAdapter<TEntity, TFields, TPatch, TReferenceData = unknown> {
  entityType: string;
  /** the domain message names this adapter registers on the protocol — see protocol.ts's collision guard. */
  domainMessageNames: readonly string[];
  concurrency: ConcurrencyContract;
  /** required when `concurrency.kind === "cas"` — the revision/hash string echoed back as the save precondition. */
  revisionOf?(entity: TEntity): string;
  /** whether an unsaved patch snapshot may be restored on simulated/real reload (restoreDecisions.ts). */
  allowPatchRestore: boolean;
  dirty: StudioDirtyHooks<TEntity, TFields, TPatch>;
  titleFor(mode: "new" | "edit", entityId: string | undefined, entity: TEntity | undefined): string;
  load(entityId: string | undefined, context?: StudioLoadContext): StudioLoadResult<TEntity, TReferenceData> | Promise<StudioLoadResult<TEntity, TReferenceData>>;
  /** client-side (webview) instant save-gating feedback — store-authoritative: the adapter decides which of
   *  ITS OWN codes are blocking vs non-blocking. Never called by the host; persistence-time re-validation is
   *  `save()`'s own job (its error result carries the taxonomy source). */
  validate(fields: TFields): StudioValidationResult;
  save(entityId: string | undefined, patch: TPatch): StudioSaveResult | Promise<StudioSaveResult>;
  delete?(entityId: string): void | Promise<void>;
  /** spec 350 Amendment 3 — an existing lifecycle stage (cancel), not a bypass: best-effort cleanup for a
   *  session that never saved (e.g. a staged-create's provisional attachment namespace). Awaited before the
   *  panel disposes. Optional/additive — Phase 1's two fakes don't implement it, unaffected. */
  onCancel?(entityId: string | undefined): void | Promise<void>;
}
