/**
 * spec 278 — the SHARED host↔webview message envelope for the sidebar view.
 *
 * Pure module (no vscode, no preact): imported by ALL THREE sides of the protocol —
 *   • the host sender   (`SidebarPrototypeProvider`, vscode-bound) — to POST the fleet,
 *   • the webview listener (`sidebar/main.tsx`)                     — to recognize it,
 *   • the dev preview harness (`scripts/webview-preview/routes.ts`) — to inject a fixture.
 *
 * The drift guard: because the `type` STRING and the message SHAPE live here once and every side
 * imports them (never spelling a raw `{type:"fleet"}` literal), an envelope rename or VM-shape change
 * breaks the BUILD (typecheck) instead of silently producing a wrong preview screenshot.
 */

import type { FleetVM } from "../../sidebar/types";

// the webview→host ready handshake is shared across all views; re-exported here for sidebar consumers.
export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

/** persisted per-section sort prefs the host folds into the first fleet push (no name-asc→saved flicker). */
export type SortPrefs = { agents?: string; terminals?: string };

/** host → webview: push the live fleet (+ sidebar prefs). */
export const FLEET = "fleet" as const;
export interface FleetMessage {
  type: typeof FLEET;
  fleets: FleetVM[];
  prefs: SortPrefs;
  collapsedKeys: string[];
  /** t-38c2a1 — running extension version (e.g. "0.56.41"). */
  appVersion?: string;
}
export function fleetMessage(
  fleets: FleetVM[],
  prefs: SortPrefs,
  collapsedKeys: string[] = [],
  appVersion?: string,
): FleetMessage {
  return { type: FLEET, fleets, prefs, collapsedKeys, ...(appVersion ? { appVersion } : {}) };
}

/** the union the sidebar webview listens for (host → webview). */
export type SidebarHostMessage = FleetMessage;
