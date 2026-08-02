/**
 * t-6e2952 — Control launcher webview protocol (host ↔ preact).
 * Pure data; no vscode / DOM.
 */

import { READY } from "../shared/ready.js";
import type { CockpitSectionId } from "../../cockpit/model.js";

export const TILES = "tiles" as const;

export interface ControlLauncherTile {
  id: CockpitSectionId;
  icon: string;
  label: string;
}

export type ControlLauncherHostMessage =
  | { type: typeof TILES; tiles: ControlLauncherTile[] };

export type ControlLauncherClientMessage =
  | { type: typeof READY }
  | { type: "openSection"; section: CockpitSectionId };

export function readyMessage(): ControlLauncherClientMessage {
  return { type: READY };
}

export function tilesMessage(tiles: ControlLauncherTile[]): ControlLauncherHostMessage {
  return { type: TILES, tiles };
}

export function openSectionMessage(section: CockpitSectionId): ControlLauncherClientMessage {
  return { type: "openSection", section };
}
