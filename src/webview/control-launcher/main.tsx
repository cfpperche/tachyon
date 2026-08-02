import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import { CONTROL_SECTION_NAV } from "../../cockpit/sectionNav.js";
import {
  readyMessage,
  TILES,
  type ControlLauncherHostMessage,
  type ControlLauncherTile,
} from "./messages";
import type { CockpitSectionId } from "../../cockpit/model.js";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

const FALLBACK_TILES: ControlLauncherTile[] = CONTROL_SECTION_NAV.map((t) => ({
  id: t.id,
  icon: t.icon,
  label: t.label,
}));

const signalReady = (): void => {
  if (vscode) vscode.postMessage(readyMessage());
  else window.postMessage(readyMessage(), "*");
};

function Root() {
  // Host pushes localized labels after ready; fallback keeps the preview harness renderable offline.
  const [tiles, setTiles] = useState<ControlLauncherTile[]>(FALLBACK_TILES);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as Partial<ControlLauncherHostMessage> | undefined;
      if (d && d.type === TILES && Array.isArray(d.tiles) && d.tiles.length > 0) {
        setTiles(d.tiles as ControlLauncherTile[]);
      }
    };
    window.addEventListener("message", onMsg);
    signalReady();
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const onOpen = (section: CockpitSectionId) => {
    vscode?.postMessage({ type: "openSection", section });
  };

  return <App tiles={tiles} onOpen={onOpen} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
