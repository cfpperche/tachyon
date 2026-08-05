/**
 * spec 278 — the dev preview harness DOM glue (bundled to dist/webview-preview/preview.js, dev-only,
 * never shipped). Reads `?view=&fixture=`, links the view's stylesheet set, frames it, loads the REAL
 * webview bundle, waits for the view's `{type:"ready"}` handshake, then injects the chosen fixture ONCE
 * (deterministic — no 10×-post race). Fails LOUD on every gap (unknown view/fixture, bundle that never
 * hydrates, a `ready` that never arrives) so a wrong preview can never pass as a clean screenshot.
 *
 * t-b24282 — this runs INSIDE the shell's sized iframe (`surface.html`, mounted by `shell.ts`), never as
 * a top-level page. That is what makes the frame a real viewport: `@media` and container width move
 * together from the one `?width=` the operator passed. Opened directly it would inherit the BROWSER's
 * viewport instead, so it refuses to render at all — see `frameDefect` below.
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
 * t-b24282 — the frame's SIZE is the shell's job now (the iframe this document lives in). What is left
 * here is the difference `route.pageFrame` has always named — what `#root` may resolve a height against:
 *
 *  - default — the harness anchors the chain (`html, body { height: 100% }`), so a surface whose sheet
 *    says `#root { height: 100% }` gets a definite frame height. That is what the old sized `#frame` div
 *    handed it directly, and several views are laid out expecting it.
 *  - page frame (t-32c872) — the surface IS the page, so the harness anchors NOTHING and `#root` gets a
 *    height only if the surface's own stylesheet chain (`page-frame.css`) provides one — the same
 *    condition the product has, instead of a free definite height from a harness box that does not ship.
 */
function anchorRootChain(pageFrame: boolean): void {
  if (pageFrame) return;
  document.documentElement.style.height = "100%";
  document.body.style.height = "100%";
}

/**
 * t-b24282 — the measurement contract, checked from inside the frame. A width that does not match this
 * document's own viewport means `@media` is being evaluated against something other than what was asked
 * for, which is precisely the false green this harness exists to prevent — so it is a hard failure, not
 * a warning. Returns the defect text, or undefined when the frame is honest.
 */
function frameDefect(params: URLSearchParams): string | undefined {
  if (window.parent === window) {
    return (
      "the preview surface was opened directly.\n\n" +
      "It must be loaded through /scripts/webview-preview/index.html, which sizes the iframe this document\n" +
      "renders in. Opened on its own it inherits the BROWSER window's viewport, so every `@media` query\n" +
      "evaluates against the window instead of the requested width — the exact defect t-b24282 closed."
    );
  }
  for (const [name, asked, actual] of [
    ["width", params.get("width"), window.innerWidth],
    ["height", params.get("height"), window.innerHeight],
  ] as const) {
    const n = Number(asked);
    if (asked !== null && Number.isFinite(n) && n > 0 && n !== actual) {
      return `frame ${name} mismatch: ?${name}=${n} but this surface's viewport is ${actual}px.\n\nThe shell did not size the frame as asked; a screenshot taken now would not be the width it claims.`;
    }
  }
  return undefined;
}

function run(): void {
  const params = new URLSearchParams(location.search);
  const view = params.get("view") || "sidebar";
  const fixtureName = params.get("fixture") || "default";

  const defect = frameDefect(params);
  if (defect) return fail(defect);

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

  // link the real panel's stylesheet set, in order, then anchor the surface in the frame the shell sized
  // from `?width=`/`?height=` (or the route's own). `?height=` still matters for the same reason it
  // always did — visual QA of a long form needs a taller frame — but it is no longer the ONLY way to
  // reach content below the fold: the surface document scrolls now, where the old `#frame` div clipped.
  for (const href of route.cssLinks) addStylesheet(href);
  anchorRootChain(route.pageFrame === true);
  if (params.get("showWidth") === "1") {
    const proof = document.createElement("output");
    proof.textContent = `window.innerWidth = ${window.innerWidth}`;
    proof.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:99999;padding:4px 7px;background:#111;color:#fff;font:12px monospace;border:1px solid #888";
    document.body.appendChild(proof);
  }
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
