import { render } from "preact";
import { ErrorBoundary } from "../shared/ErrorBoundary.js";
import { App, type DesignModeOverlayOptions } from "./App.js";

const VERSION = 1;
let host: HTMLDivElement | null = null;

function unmount(): boolean {
  if (!host) return false;
  render(null, host);
  host.remove();
  host = null;
  delete window.__tachyonDmCleanup;
  delete window.__tachyonDmOverlay;
  return true;
}

function mount(options: DesignModeOverlayOptions): { version: number } {
  unmount();
  host = document.createElement("div");
  document.documentElement.appendChild(host);
  render(<ErrorBoundary><App {...options} /></ErrorBoundary>, host);
  window.__tachyonDmCleanup = () => { window.__tachyonDmOverlay?.unmount(); };
  return { version: VERSION };
}

window.__tachyonDmOverlay = { version: VERSION, mount, unmount };

declare global {
  interface Window {
    __tachyonDmCleanup?: () => void;
    __tachyonDmOverlay?: {
      version: number;
      mount: (options: DesignModeOverlayOptions) => { version: number };
      unmount: () => boolean;
    };
  }
}
