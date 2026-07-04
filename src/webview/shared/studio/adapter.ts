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

import type { StudioValidationResult } from "./errorTaxonomy";

/** `none`: no CAS, last-write-wins. `cas`: `expected` is the revision/hash the host loaded; a save whose
 *  server-side revision has since moved must fail closed (stale banner, retry/reload action) rather than
 *  silently overwrite. */
export type ConcurrencyContract = { kind: "none" } | { kind: "cas"; expected: string };

/** Dirty tracking is ALWAYS adapter-declared (dueto F5/F6) — the shell never infers it from field diffing. */
export interface StudioDirtyHooks<TEntity, TFields, TPatch> {
  computeDirty(entity: TEntity | undefined, fields: TFields): boolean;
  /** builds the save patch from the current fields; `undefined` when nothing is actually dirty (a no-op save). */
  serializePatch(fields: TFields, dirty: boolean): TPatch | undefined;
  /** whether `fields` may be discarded without confirmation (e.g. matches the last loaded/saved snapshot). */
  canDiscard(fields: TFields): boolean;
}

export type StudioLoadResult<TEntity> = { status: "ok"; entity: TEntity } | { status: "not-found" } | { status: "error"; error: string };

export type StudioSaveResult = { status: "ok" } | { status: "error"; error: { code: string; message: string } };

export interface StudioHostAdapter<TEntity, TFields, TPatch> {
  entityType: string;
  /** the domain message names this adapter registers on the protocol — see protocol.ts's collision guard. */
  domainMessageNames: readonly string[];
  concurrency: ConcurrencyContract;
  /** whether an unsaved patch snapshot may be restored on simulated/real reload (restoreDecisions.ts). */
  allowPatchRestore: boolean;
  dirty: StudioDirtyHooks<TEntity, TFields, TPatch>;
  titleFor(mode: "new" | "edit", entityId: string | undefined, entity: TEntity | undefined): string;
  load(entityId: string | undefined): StudioLoadResult<TEntity> | Promise<StudioLoadResult<TEntity>>;
  validate(fields: TFields): StudioValidationResult;
  save(entityId: string | undefined, patch: TPatch): StudioSaveResult | Promise<StudioSaveResult>;
  delete?(entityId: string): void | Promise<void>;
}
