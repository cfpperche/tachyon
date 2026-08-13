import { render } from "preact";
import { ErrorBoundary } from "../shared/ErrorBoundary.js";
import { App, type DesignModeOverlayOptions } from "./App.js";
import { OVERLAY_CSS } from "./styles.js";

const VERSION = 2;
const THEME_CSS = "__TACHYON_DM_THEME_CSS__";
let host: HTMLElement | null = null;

function unmount(): boolean {
  if (!host) return false;
  render(null, host.shadowRoot!);
  host.remove();
  host = null;
  delete window.__tachyonDmCleanup;
  delete window.__tachyonDmOverlay;
  return true;
}

function mount(options: DesignModeOverlayOptions): { version: number } {
  unmount();
  host = document.createElement("tachyon-design-mode");
  host.setAttribute("data-tachyon-dm-overlay", "");
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "2147483647";
  host.style.pointerEvents = "none";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `${THEME_CSS}\n${OVERLAY_CSS}`;
  root.appendChild(style);
  document.documentElement.appendChild(host);
  render(<ErrorBoundary><App {...options} /></ErrorBoundary>, root);
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
