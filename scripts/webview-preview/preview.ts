/**
 * spec 278 — the dev preview harness DOM glue (bundled to dist/webview-preview/preview.js, dev-only,
 * never shipped). Reads `?view=&fixture=`, links the view's stylesheet set, frames it, loads the REAL
 * webview bundle, waits for the view's `{type:"ready"}` handshake, then injects the chosen fixture ONCE
 * (deterministic — no 10×-post race). Fails LOUD on every gap (unknown view/fixture, bundle that never
 * hydrates, a `ready` that never arrives) so a wrong preview can never pass as a clean screenshot.
 */

import { ROUTES, type Route } from "./routes";
import { READY } from "../../src/webview/shared/ready";

const READY_TIMEOUT_MS = 4000;

function fail(message: string, known?: string): void {
  const root = document.getElementById("root");
  if (root) root.innerHTML = `<pre style="color:#f48771;padding:16px;white-space:pre-wrap">${message}${known ? `\n${known}` : ""}</pre>`;
}

function addStylesheet(href: string): void {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

/**
 * Size the surface. Two shapes, and the difference is the whole point of `route.pageFrame`:
 *
 *  - default — `#frame` is a sized box the surface renders inside (a sidebar view, a studio panel);
 *  - page frame (t-32c872) — the surface IS the page, so `#frame` is collapsed out of the layout
 *    (`display: contents`) and the size goes on `<html>`, which is what a real webview's page frame is.
 *    `#root` then gets a height only if the surface's own stylesheet chain provides one — the same
 *    condition the product has, instead of a free definite height from a harness div that does not ship.
 */
function frameTo(frame: { w: number; h: number }, pageFrame: boolean): void {
  const el = document.getElementById("frame");
  if (!el) return;
  if (pageFrame) {
    el.style.display = "contents";
    // inline, so a route sheet's own `html { height: 100% }` (page-frame.css) does not win over the
    // measurement width/height — the frame is the stand-in for the editor tab's viewport.
    document.documentElement.style.width = `${frame.w}px`;
    document.documentElement.style.height = `${frame.h}px`;
    return;
  }
  el.style.width = `${frame.w}px`;
  el.style.height = `${frame.h}px`;
}

function run(): void {
  const params = new URLSearchParams(location.search);
  const view = params.get("view") || "sidebar";
  const fixtureName = params.get("fixture") || "default";

  const route: Route | undefined = ROUTES[view];
  if (!route) return fail(`unknown view: ${view}`, `known views: ${Object.keys(ROUTES).join(", ")}`);

  const fixture = route.fixtures[fixtureName];
  if (!fixture) return fail(`unknown fixture: ${fixtureName} (view ${view})`, `known: ${Object.keys(route.fixtures).join(", ")}`);

  // Stand in for VS Code's one-way webview bridge. Without this, a browser-only fallback posts
  // outbound studio commands back onto the same window and the surface mistakes its own command
  // for a host response. Keep only the ready handshake observable by this harness.
  (window as Window & { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => ({
    postMessage(message: { type?: string }) {
      if (message?.type === READY) window.postMessage(message, "*");
    },
    getState() { return undefined; },
    setState() { return undefined; },
  });

  // link the real panel's stylesheet set, in order, then frame the surface.
  for (const href of route.cssLinks) addStylesheet(href);
  // optional width override for responsive visual QA (?width=360). The height override (?height=…)
  // exists because #frame is overflow:hidden with no scrollbar, so a surface taller than the route
  // frame is simply clipped and unreachable — visual QA of a long form needs a taller frame.
  const widthParam = params.get("width");
  const heightParam = params.get("height");
  const frameW = widthParam && Number(widthParam) > 0 ? Number(widthParam) : route.frame.w;
  const frameH = heightParam && Number(heightParam) > 0 ? Number(heightParam) : route.frame.h;
  frameTo({ w: frameW, h: frameH }, route.pageFrame === true);
  // Optional theme stand-ins; default remains Dark+ harness tokens.
  const requestedTheme = params.get("theme");
  const theme = requestedTheme === "light" || requestedTheme === "high-contrast" ? requestedTheme : "dark";
  if (theme === "light") {
    document.body.classList.add("vscode-light");
    document.body.classList.remove("vscode-dark");
    const darkLink = document.querySelector('link[href*="theme-dark.css"]') as HTMLLinkElement | null;
    if (darkLink) darkLink.href = "/scripts/webview-preview/theme-light.css";
  } else if (theme === "high-contrast") {
    document.body.classList.add("vscode-high-contrast");
    document.body.classList.remove("vscode-dark");
    const darkLink = document.querySelector('link[href*="theme-dark.css"]') as HTMLLinkElement | null;
    if (darkLink) darkLink.href = "/scripts/webview-preview/theme-high-contrast.css";
  } else {
    document.body.classList.add("vscode-dark");
  }
  // spec 281 — a DOM marker so the visual-qa skill can verify it actually rendered the resolved view+fixture
  // (catches a stale-but-valid catalog pointing at the wrong surface).
  document.body.dataset.previewView = view;
  document.body.dataset.previewFixture = fixtureName;

  // Seed on-demand asset URLs the real ActivityPanel bootstrap would inject (spec 238 / 374).
  // Without these, ```mermaid / math fences fail-closed in the harness.
  (window as Window & { __mermaidSrc?: string; __katexSrc?: string; __katexCssUri?: string }).__mermaidSrc =
    "/dist/webview/mermaid.js";
  (window as Window & { __katexSrc?: string }).__katexSrc = "/dist/webview/katex.js";
  (window as Window & { __katexCssUri?: string }).__katexCssUri = "/dist/webview/katex.min.css";
  if (route.globals) Object.assign(window, route.globals);

  // deterministic injection: wait for the view's ready handshake, inject the fixture exactly once.
  let injected = false;
  const onReady = (e: MessageEvent): void => {
    const d = e.data as { type?: string } | undefined;
    if (d?.type === READY && !injected) {
      injected = true;
      window.removeEventListener("message", onReady);
      const msg = route.makeMessage(fixture.vm);
      const batch = Array.isArray(msg) ? msg : [msg];
      // t-e722ce — SPACED, not same-tick. A Control-hosted studio receives host messages through ONE
      // shared `studioIncoming` state slot (cockpit/main.tsx), so two messages posted in the same
      // tick collapse to the last one and the studio never sees its `load` — it sits on "Loading…"
      // forever. Posting each on its own macrotask is how a real host delivers them (a reply always
      // follows a render), and it makes a request/response surface previewable at all.
      batch.forEach((m, index) => {
        if (index === 0) window.postMessage(m, "*");
        else window.setTimeout(() => window.postMessage(m, "*"), index * 50);
      });
    }
  };
  window.addEventListener("message", onReady);
  window.setTimeout(() => {
    if (!injected) fail(`view "${view}" never signaled ready within ${READY_TIMEOUT_MS}ms — the bundle did not hydrate.`);
  }, READY_TIMEOUT_MS);

  // surface page errors loudly (a console error must not pass as a clean screenshot).
  window.addEventListener("error", (e) => {
    const b = document.createElement("div");
    b.style.cssText = "position:fixed;top:0;left:0;right:0;background:#5a1d1d;color:#fff;padding:6px 10px;font:12px monospace;z-index:9999";
    b.textContent = `PAGE ERROR: ${e.message || (e.error as Error | undefined)?.message || "unknown"}`;
    document.body.appendChild(b);
  });

  // load the REAL webview bundle last (it mounts, then posts `ready` → onReady fires).
  const s = document.createElement("script");
  if (route.module) s.type = "module";
  s.src = route.bundle;
  document.body.appendChild(s);
}

run();
