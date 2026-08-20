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

import type { FleetVM, SidebarBootVM } from "@tachyon/shared/sidebar/types";

// the webview→host ready handshake is shared across all views; re-exported here for sidebar consumers.
export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

/** persisted per-section sort prefs the host folds into the first fleet push (no name-asc→saved flicker).
 *  t-50daeb — `launcher` is the Control grid; absent means PRODUCT order, which is why it cannot
 *  default to a SortMode the way the two list sections do. */
export type SortPrefs = { agents?: string; terminals?: string; launcher?: string };

/** host → webview: push the live fleet (+ sidebar prefs). */
export const FLEET = "fleet" as const;
export interface FleetMessage {
  type: typeof FLEET;
  fleets: FleetVM[];
  prefs: SortPrefs;
  collapsedKeys: string[];
  /** t-38c2a1 — running extension version (e.g. "0.56.41"). */
  appVersion?: string;
  /** SDD 485 C6 — window scope used by the next Control app/document open. */
  selectedWsHash?: string;
  /**
   * SDD 504 — what the host has discovered about this window's folders.
   *
   * It rides the EXISTING fleet message rather than arriving as a second one, and that is a
   * decision: two messages would let a fleet and its discovery disagree on the wire, and the
   * webview would have to hold a rule for which one is newer. Here `fleets` and `boot` are always
   * the same push, so an empty array is never self-interpreting again.
   *
   * Optional on the type only for the harnesses that build fixtures by hand; production always
   * sends it, and a webview that receives no `boot` stays in `unknown` — which is the safe end of
   * the failure, not the dangerous one.
   */
  boot?: SidebarBootVM;
}
export function fleetMessage(
  fleets: FleetVM[],
  prefs: SortPrefs,
  collapsedKeys: string[] = [],
  appVersion?: string,
  selectedWsHash?: string,
  boot?: SidebarBootVM,
): FleetMessage {
  return {
    type: FLEET,
    fleets,
    prefs,
    collapsedKeys,
    ...(appVersion ? { appVersion } : {}),
    ...(selectedWsHash ? { selectedWsHash } : {}),
    ...(boot ? { boot } : {}),
  };
}

/** the union the sidebar webview listens for (host → webview). */
export type SidebarHostMessage = FleetMessage;
