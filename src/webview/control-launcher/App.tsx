/**
 * t-6e2952 — phone-format Control launcher grid.
 *
 * Layout is surface CSS (`.cl-*`); each tile is the shared `Button` primitive restyled as a
 * home-screen cell (icon over label). No new component-library entry — a vertical app-tile is a
 * one-surface layout, not a second button primitive (documented exception: layout only).
 */

import { Button } from "../shared/ui";
import type { ControlLauncherTile } from "./messages";
import type { CockpitSectionId } from "../../cockpit/model.js";

export interface ControlLauncherAppProps {
  tiles: ControlLauncherTile[];
  onOpen: (section: CockpitSectionId) => void;
}

export function App({ tiles, onOpen }: ControlLauncherAppProps) {
  return (
    <div class="cl-root" data-testid="control-launcher">
      <div class="cl-phone" role="navigation" aria-label="Control">
        <div class="cl-grid">
          {tiles.map((tile) => (
            <Button
              key={tile.id}
              class="cl-tile"
              icon={tile.icon}
              title={tile.label}
              data-section={tile.id}
              data-testid={`control-launcher-tile-${tile.id}`}
              onClick={() => onOpen(tile.id)}
            >
              {tile.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
