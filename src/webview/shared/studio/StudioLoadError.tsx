import type { ComponentChildren } from "preact";
import { StudioFrame } from "./StudioFrame";
import type { StudioError } from "./errorTaxonomy";
import { studioLoadErrorTitle } from "./studioLoadErrorTitle";

/**
 * t-f4e186 — what a studio shows when the host ANSWERED and the answer was not a document.
 *
 * ## What this exists to stop
 *
 * Every shell returned its loading screen from `if (!ready || !entity)`. An `error` envelope that
 * arrives with no prior `load` sets `ready` and never sets `entity` — the two facts the guard
 * conflates — so the loading screen was the TERMINAL state: the host had already said the load
 * failed, the message was in the client's own `hostError`, and the human kept reading "Loading…"
 * with no second answer coming. `StudioFrame`'s `loadFailed` banner has existed since spec 350 T3
 * and was unreachable on that path in six of the seven studios.
 *
 * ## Why it is a shared surface and not an `if` per shell
 *
 * Seven shells hold byte-identical guards (agent/command/terminal/runbook/schedule single-mode,
 * plus task-studio and pin-studio on the document hosts), and every one of their hosts posts the
 * same bare `error`: `SingleModeStudioPanelManager.postError`, `StudioPanelManagerBase.postError`,
 * `TaskDetailPanel`'s `postStudioError`, `PinDetailPanel`'s `postError`. One surface is what keeps
 * the eighth shell — the one nobody has written yet — from re-deriving the same dead end.
 *
 * ## Not a redesign
 *
 * There is deliberately nothing new on this screen. It is `StudioFrame` with NO regions: the
 * load-failure banner it already draws, the error list it already draws, and Cancel, which is the
 * only action a document with no subject has. Save is out of the tree (t-831332), same reason the
 * tombstone (t-b643ac) never drew it: a disabled control is a promise that a path exists.
 *
 * ## Title: name the surface, not an entity (t-831332)
 *
 * The `error` envelope carries no identity — four hosts post it bare
 * (`SingleModeStudioPanelManager`, `StudioPanelManagerBase`, `TaskDetailPanel`, `PinDetailPanel`).
 * Calling `titleFor` with no entity falls through to "New Agent" / "New Pipeline" and asserts a
 * create-flow the human is not in. What this screen knows is which studio it is and that the load
 * failed; the banner already says the second half. The title is therefore the surface name only:
 * `studioLoadErrorTitle(entityType)` → "Agent Studio", "Command Studio", …
 */

export { studioLoadErrorTitle } from "./studioLoadErrorTitle";

export interface StudioLoadErrorProps {
  /**
   * the studio's entity kind (`agent`, `command`, `task`, …) — the one fact the client always has
   * even when the host sent no identity. See `studioLoadErrorTitle`.
   */
  entityType: string;
  /** the host's error, when it sent one. Absent still renders the banner: the load failed either way. */
  error?: StudioError;
  backLink?: ComponentChildren;
  /** closes the document — `post(cancelMessage())`, the same door Cancel uses everywhere else. */
  onClose: () => void;
}

export function StudioLoadError({ entityType, error, backLink, onClose }: StudioLoadErrorProps) {
  return (
    <StudioFrame
      title={studioLoadErrorTitle(entityType)}
      backLink={backLink}
      errors={error ? [error] : []}
      dirty={false}
      saveInFlight={false}
      loadFailed
      canSave={false}
      onSave={() => {}}
      onCancel={onClose}
      regions={{}}
    />
  );
}
