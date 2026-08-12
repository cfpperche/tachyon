/**
 * t-b24282 — the dev preview harness SHELL (bundled to dist/webview-preview/shell.js, dev-only, never
 * shipped). It owns exactly one thing: the SIZE of the frame the surface renders in.
 *
 * Why a shell at all. The frame used to be a `<div>` that `preview.ts` sized from `?width=`. A div is a
 * box, not a viewport — so the surface reflowed by container width while `window.innerWidth` stayed at
 * whatever the browser window happened to be, and every `@media (max-width: …)` in the surface's own
 * stylesheet stayed dormant. A 360px screenshot taken that way shows a layout the product never produces
 * at 360px. The mirror-image mistake (shrink the BROWSER instead) fires the media queries but leaves the
 * surface laid out at the route's wide frame, inventing horizontal overflow that does not exist. Both
 * halves have to move, and an iframe is the one element whose content box IS a viewport, so ONE number
 * moves both — without the operator having to know there were two.
 *
 * This file therefore resolves the requested frame size (explicit `?width=`/`?height=`, else the view's
 * `route.frame`) and points the sized iframe at `surface.html` with the SAME query string. Everything
 * else — stylesheets, the real bundle, the ready handshake, the fixture — happens inside that frame, in
 * `preview.ts`, exactly as before.
 *
 * t-4a477f — the catalog door is the other half. `buildCatalog` emits view+fixture URLs with no
 * `?width=`, because one entry is photographed at 880 and at 360. When that query is omitted, the
 * shell passes the OUTER window's width into the iframe (clamped to `route.frame.w`) so a visual-qa
 * capture that only shrinks the browser still gets a 360 iframe viewport. Explicit `?width=` still
 * wins and is not clamped — that is the puppeteer / t-b24282 door above.
 */

import { ROUTES } from "./routes";

const SURFACE = "/scripts/webview-preview/surface.html";
/** used only when `?view=` names no route: the surface itself fails loud with the known-view list, and
 *  this is just a box big enough to read that message in. */
const UNKNOWN_VIEW_FRAME = { w: 880, h: 760 };

function positiveInt(raw: string | null): number | undefined {
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Window width the photo will actually show. Prefer clientWidth so a shell scrollbar cannot
 *  shrink the available box after we size the iframe to it (resize-loop). */
function availableWidth(): number {
  return document.documentElement.clientWidth || window.innerWidth;
}

function resolvedWidth(asked: number | undefined, routeFrameW: number): number {
  return asked ?? Math.min(routeFrameW, availableWidth());
}

function mount(): void {
  const iframe = document.getElementById("frame") as HTMLIFrameElement | null;
  if (!iframe) return;
  document.getElementById("shell-error")?.remove();

  const params = new URLSearchParams(location.search);
  const route = ROUTES[params.get("view") || "sidebar"];
  const frame = route?.frame ?? UNKNOWN_VIEW_FRAME;
  const askedWidth = positiveInt(params.get("width"));
  const h = positiveInt(params.get("height")) ?? frame.h;

  const applyWidth = (): void => {
    // content-box sizing (the default) — `style.width` is the iframe's viewport width, and the shell's own
    // `border-right` stays outside it. `preview.ts` re-checks an explicit `?width=` from inside and fails
    // loud on a mismatch. An omitted width is inferred here and is not written into the surface URL, so
    // a later outer-window resize can move the iframe without a frameDefect false fail.
    iframe.style.width = `${resolvedWidth(askedWidth, frame.w)}px`;
    iframe.style.height = `${h}px`;
  };
  applyWidth();
  if (askedWidth === undefined) window.addEventListener("resize", applyWidth);

  // spec 281 — the "it really rendered this view+fixture" markers live on the SURFACE's body (that is the
  // document that resolved them). Mirror them onto the shell's body so a caller inspecting the top-level
  // page still reads a value the surface actually produced, never one the shell inferred from the URL.
  iframe.addEventListener("load", () => {
    const surfaceBody = iframe.contentDocument?.body;
    if (!surfaceBody) return;
    const { previewView, previewFixture } = surfaceBody.dataset;
    if (previewView) document.body.dataset.previewView = previewView;
    if (previewFixture) document.body.dataset.previewFixture = previewFixture;
  });

  iframe.src = `${SURFACE}${location.search}`;
}

mount();
