import type { ComponentChildren } from "preact";
import { StudioFrame } from "./StudioFrame";
import type { StudioError } from "./errorTaxonomy";

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
 * only action a document with no subject has. `pipeline-studio` — the one shell whose guard reads
 * `if (!ready)` alone — has rendered exactly this since spec 350 T4, title included, and it is the
 * measured control in `test/browser/studioLoadErrorShells.test.ts`. What lands here is that
 * behaviour reaching the other seven, not a new opinion about how a failure should look.
 *
 * The title comes from the shell's own `titleFor`, with whatever it knows — which after a failed
 * load is the "new" title, because the host never told it an identity. That is the same thing
 * pipeline-studio has always shown ("New Pipeline"), and it claims nothing the client cannot know.
 */
export interface StudioLoadErrorProps {
  /** the shell's own `titleFor(mode, entityId, entity)` — see the note above about what it can know. */
  title: string;
  /** the host's error, when it sent one. Absent still renders the banner: the load failed either way. */
  error?: StudioError;
  backLink?: ComponentChildren;
  /** closes the document — `post(cancelMessage())`, the same door Cancel uses everywhere else. */
  onClose: () => void;
}

export function StudioLoadError({ title, error, backLink, onClose }: StudioLoadErrorProps) {
  return (
    <StudioFrame
      title={title}
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
