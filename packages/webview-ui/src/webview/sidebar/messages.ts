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

import type { InstalledAppTile } from "./sectionNav.js";
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
  /**
   * 514 — the installed apps, travelling WITH the fleet for the same reason the boot row does: the
   * launcher grid and the fleet are painted from one message, so they cannot disagree on the wire.
   * Absent means "none installed", which is also what a workspace with no `.tachyon/apps` reports.
   */
  apps?: InstalledAppTile[];
}
export function fleetMessage(
  fleets: FleetVM[],
  prefs: SortPrefs,
  collapsedKeys: string[] = [],
  appVersion?: string,
  selectedWsHash?: string,
  boot?: SidebarBootVM,
  apps?: InstalledAppTile[],
): FleetMessage {
  return {
    type: FLEET,
    fleets,
    prefs,
    collapsedKeys,
    ...(appVersion ? { appVersion } : {}),
    ...(selectedWsHash ? { selectedWsHash } : {}),
    ...(boot ? { boot } : {}),
    ...(apps && apps.length > 0 ? { apps } : {}),
  };
}

/**
 * 514 — host → webview: the archives an app could be installed from.
 *
 * Sent only in answer to the install door being opened, never on the fleet heartbeat: it is the result
 * of a bounded filesystem scan, and nobody needs it until they ask.
 */
export const APP_ZIPS = "appZips" as const;
export interface AppZipsMessage {
  type: typeof APP_ZIPS;
  candidates: Array<{ path: string; name: string; dir: string }>;
  /** where the scan looked — the empty state has to say it, or "no zips" reads as a bug. */
  roots: string[];
}
export function appZipsMessage(candidates: AppZipsMessage["candidates"], roots: string[]): AppZipsMessage {
  return { type: APP_ZIPS, candidates, roots };
}

/** the union the sidebar webview listens for (host → webview). */
export type SidebarHostMessage = FleetMessage | AppZipsMessage;
