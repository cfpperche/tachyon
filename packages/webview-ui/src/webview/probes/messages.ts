/**
 * spec 279 — the SHARED host↔webview envelope for the Probes view (a `preact-live` read-only surface: the host
 * re-pushes the model on refresh, but the webview sends no inbound actions). Imported by the host
 * (`ProbeResultPanelManager`), the webview listener (`probes/main.tsx`), and the dev preview harness.
 */

import type { ProbeView } from "@tachyon/engine/probe/probeView.js";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

/** the render-ready model: a built `ProbeView`, or a load error (NOT an empty ledger — kept distinct). */
export type ProbesVM = { folder: string; view: ProbeView } | { folder: string; error: string };

/** host → webview: the current probes model (re-posted on refresh / on the webview's ready handshake). */
export const PROBES = "probes" as const;
export interface ProbesMessage {
  type: typeof PROBES;
  vm: ProbesVM;
}
export function probesMessage(vm: ProbesVM): ProbesMessage {
  return { type: PROBES, vm };
}

export type ProbesHostMessage = ProbesMessage;
