import type { ComponentChildren } from "preact";
import { Button } from "../ui";
import type { StudioTombstoneInfo } from "./tombstone";

/**
 * t-b643ac — the ONE screen a single-mode studio shows when the entity it edits no longer exists.
 *
 * Rendered INSTEAD of `StudioFrame`, never above it. That is the point: StudioFrame is an editor, and
 * an editor with no subject is the defect. Because this component replaces the frame, Save and Cancel
 * and every adapter action are not disabled — they are ABSENT from the DOM, for all five studios at
 * once, by construction rather than by five copies of a `disabled=` expression staying in agreement.
 *
 * What it shows is decision 2, answered narrowly on purpose. The task-detail tombstone (spec 335)
 * renders its last known projection because a task detail is a READING surface — showing it read-only
 * is showing it as designed. A studio's projection is a FORM; a read-only rendition of a form for a
 * thing that does not exist is closer to the bug than to the fix, and it would cost a bespoke read
 * mode in each of the five apps rather than one shared screen. So the last-good projection appears at
 * the granularity the shared layer actually owns — the title `adapter.titleFor` computed from the last
 * successful load — plus identity, the plain fact, and what happened to unsaved work.
 */
export interface StudioTombstoneProps {
  info: StudioTombstoneInfo;
  /** the route's "← Parent" link, when the host is a route rather than a standalone tab. */
  backLink?: ComponentChildren;
  onClose: () => void;
}

export const STUDIO_TOMBSTONE_LABELS = {
  close: "Close",
  /** Present tense and specific: the human wants to know what happened, not that something failed. */
  headline: "No longer exists",
  draftDiscarded: "Your unsaved changes were discarded — there is nothing left to save them to.",
} as const;

export function StudioTombstone({ info, backLink, onClose }: StudioTombstoneProps) {
  const name = info.entityId ?? "";
  return (
    <div class="sf-shell sf-tombstone">
      <header class="sf-header">
        <div class="sf-title-group">
          <div class="sf-title-row">
            <div class="sf-title">{info.title ?? name}</div>
          </div>
          {backLink ? <div class="sf-backlink">{backLink}</div> : null}
        </div>
        <div class="sf-actions">
          <Button onClick={onClose}>{STUDIO_TOMBSTONE_LABELS.close}</Button>
        </div>
      </header>

      <main class="sf-tombstone-body" role="status">
        <div class="sf-tombstone-mark" aria-hidden="true">
          <span class="codicon codicon-circle-slash" />
        </div>
        <div class="sf-tombstone-headline">{STUDIO_TOMBSTONE_LABELS.headline}</div>
        <div class="sf-tombstone-detail">
          {name ? (
            <>
              The {info.entityType} <span class="ref">{name}</span> was removed. This tab is showing what it
              was last known as; there is no longer anything here to edit.
            </>
          ) : (
            <>This {info.entityType} was removed. There is no longer anything here to edit.</>
          )}
        </div>
        {info.discardedDraft && (
          <div class="sf-tombstone-draft">{STUDIO_TOMBSTONE_LABELS.draftDiscarded}</div>
        )}
      </main>
    </div>
  );
}
