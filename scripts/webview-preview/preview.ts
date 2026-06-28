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

function frameTo(frame: { w: number; h: number }): void {
  const el = document.getElementById("frame");
  if (el) {
    el.style.width = `${frame.w}px`;
    el.style.height = `${frame.h}px`;
  }
}

function run(): void {
  const params = new URLSearchParams(location.search);
  const view = params.get("view") || "sidebar";
  const fixtureName = params.get("fixture") || "default";

  const route: Route | undefined = ROUTES[view];
  if (!route) return fail(`unknown view: ${view}`, `known views: ${Object.keys(ROUTES).join(", ")}`);

  const fixture = route.fixtures[fixtureName];
  if (!fixture) return fail(`unknown fixture: ${fixtureName} (view ${view})`, `known: ${Object.keys(route.fixtures).join(", ")}`);

  // link the real panel's stylesheet set, in order, then frame the surface.
  for (const href of route.cssLinks) addStylesheet(href);
  frameTo(route.frame);

  // deterministic injection: wait for the view's ready handshake, inject the fixture exactly once.
  let injected = false;
  const onReady = (e: MessageEvent): void => {
    const d = e.data as { type?: string } | undefined;
    if (d?.type === READY && !injected) {
      injected = true;
      window.removeEventListener("message", onReady);
      const msg = route.makeMessage(fixture.vm);
      for (const m of Array.isArray(msg) ? msg : [msg]) window.postMessage(m, "*");
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
  s.src = route.bundle;
  document.body.appendChild(s);
}

run();
