import { composerProfileFor } from "../runtime/composerRegion.js";
import type { ComposerRegionProfile } from "../runtime/runtimeProfile.js";

/**
 * t-2c2384 — Agent pane freeform delivery (path H in t-a5b186 inventory).
 *
 * Same submit primitive as `prompt.inject` (path F): `sendSubmittedLine` with the measured
 * runtime composer profile. Omitting `composer` falls back to the legacy last-line
 * heuristic (`looksLikeStrandedSubmittedLine`), which cannot see a wrapped draft and reports
 * delivery for a line that is still staged.
 */

export type AgentPaneTmux = {
  sendSubmittedLine(
    session: string,
    text: string,
    options?: { composer?: ComposerRegionProfile },
  ): Promise<unknown>;
  sendKeys(session: string, text: string, submit: boolean): Promise<unknown>;
};

/** Resolve the composer profile for a freeform pane submit — cmd preferred, runtime name as fallback. */
export function agentPaneComposerProfile(
  cmd: string | null | undefined,
  runtime?: string | null,
): ComposerRegionProfile | undefined {
  return composerProfileFor(cmd) ?? composerProfileFor(runtime ?? undefined);
}

export async function deliverAgentPaneText(
  tmux: AgentPaneTmux,
  session: string,
  text: string,
  submit: boolean,
  cmd: string | null | undefined,
  runtime?: string | null,
): Promise<void> {
  if (submit) {
    await tmux.sendSubmittedLine(session, text, {
      composer: agentPaneComposerProfile(cmd, runtime),
    });
    return;
  }
  await tmux.sendKeys(session, text, false);
}
