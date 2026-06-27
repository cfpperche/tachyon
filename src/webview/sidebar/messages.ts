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

/** persisted per-section sort prefs the host folds into the first fleet push (no name-asc→saved flicker). */
export type SortPrefs = { agents?: string; terminals?: string };

/** host → webview: push the live fleet (+ sort prefs). */
export const FLEET = "fleet" as const;
export interface FleetMessage {
  type: typeof FLEET;
  fleets: FleetVM[];
  prefs: SortPrefs;
}
export function fleetMessage(fleets: FleetVM[], prefs: SortPrefs): FleetMessage {
  return { type: FLEET, fleets, prefs };
}

/** webview → host: the iframe mounted and is ready to receive the fleet (also the dev-harness handshake). */
export const READY = "ready" as const;
export interface ReadyMessage {
  type: typeof READY;
}
export function readyMessage(): ReadyMessage {
  return { type: READY };
}

/** the union the sidebar webview listens for (host → webview). */
export type SidebarHostMessage = FleetMessage;
