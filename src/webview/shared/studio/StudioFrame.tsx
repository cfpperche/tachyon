import type { ComponentChildren } from "preact";
import { Button } from "../ui";
import type { StudioError } from "./errorTaxonomy";

/**
 * spec 350 T3 — StudioFrame: the shared webview chrome every studio dialect hand-rolled its own copy of
 * (header, Cancel/Save, error surfacing, dirty indicator). SINGLE-DOCUMENT only (2026-07-04 dismemberment
 * amendment) — no tab strip, no navigation contract.
 *
 * Save-button gating is SHELL-OWNED, not adapter-owned: the caller passes the already-computed `canSave`
 * boolean (from dirtyGating.canSave, fed by the error taxonomy) — StudioFrame never re-derives it from raw
 * booleans, so an adapter cannot show a blocking error while leaving Save clickable (dueto F9/F10).
 *
 * Content regions (`fields`/`richDoc`/`previewVisual`/`sideActions`) are the ONLY place domain markup lives;
 * everything else here is shell chrome. A region a studio doesn't use is simply omitted (undefined), not an
 * empty node — Pin Studio's future migration notes name what can't map into these four.
 */

export interface StudioFrameLabels {
  cancel: string;
  save: string;
  saving: string;
  staleBanner: string;
  staleReload: string;
  loadErrorBanner: string;
}

export const DEFAULT_STUDIO_LABELS: StudioFrameLabels = {
  cancel: "Cancel",
  save: "Save",
  saving: "Saving…",
  staleBanner: "This was changed elsewhere — reload to see the latest before saving.",
  staleReload: "Reload",
  loadErrorBanner: "Couldn't load this entity.",
};

export interface StudioFrameRegions {
  fields?: ComponentChildren;
  richDoc?: ComponentChildren;
  previewVisual?: ComponentChildren;
  sideActions?: ComponentChildren;
}

export interface StudioFrameProps {
  title: string;
  labels?: StudioFrameLabels;
  /** the adapter's current validation + persistence/transport errors, taxonomy-tagged (errorTaxonomy.ts). */
  errors: StudioError[];
  dirty: boolean;
  saveInFlight: boolean;
  concurrencyStale?: boolean;
  loadFailed?: boolean;
  /** precomputed by the caller via dirtyGating.canSave — see the module doc above. */
  canSave: boolean;
  onSave: () => void;
  onCancel: () => void;
  onReload?: () => void;
  /** adapter-declared header action slots (e.g. Pin Studio's Import/Sketch), left of Cancel/Save. */
  headerActions?: ComponentChildren;
  regions: StudioFrameRegions;
}

export function StudioFrame(props: StudioFrameProps) {
  const labels = props.labels ?? DEFAULT_STUDIO_LABELS;
  return (
    <div class="sf-shell">
      <header class="sf-header">
        <div class="sf-title-group">
          <div class="sf-title">{props.title}</div>
          {props.dirty && <span class="sf-dirty-dot" aria-label="unsaved changes" title="unsaved changes" />}
        </div>
        <div class="sf-actions">
          {props.headerActions}
          <Button onClick={props.onCancel}>{labels.cancel}</Button>
          <Button variant="primary" disabled={!props.canSave} onClick={props.onSave}>
            {props.saveInFlight ? labels.saving : labels.save}
          </Button>
        </div>
      </header>

      {props.loadFailed && (
        <div class="sf-banner sf-banner-error" role="alert">
          {labels.loadErrorBanner}
        </div>
      )}
      {props.concurrencyStale && (
        <div class="sf-banner sf-banner-stale" role="alert">
          <span>{labels.staleBanner}</span>
          {props.onReload && (
            <Button onClick={props.onReload}>{labels.staleReload}</Button>
          )}
        </div>
      )}
      {props.errors.length > 0 && (
        <div class="sf-errors" role="alert">
          {props.errors.map((e) => (
            <div key={e.code} class={e.blocking ? "sf-error-blocking" : "sf-error-nonblocking"}>
              {e.message}
            </div>
          ))}
        </div>
      )}

      <main class="sf-body">
        {props.regions.fields !== undefined && <section class="sf-region-fields">{props.regions.fields}</section>}
        {props.regions.richDoc !== undefined && <section class="sf-region-richdoc">{props.regions.richDoc}</section>}
        {props.regions.previewVisual !== undefined && <aside class="sf-region-preview">{props.regions.previewVisual}</aside>}
      </main>
      {props.regions.sideActions !== undefined && <div class="sf-side-actions">{props.regions.sideActions}</div>}
    </div>
  );
}
