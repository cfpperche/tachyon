declare global {
  interface Window {
    /** t-610705 (SDD 410 Phase B) — webview-resource URIs for lazy cockpit sections' stylesheets,
     *  keyed by CockpitSectionId. Populated only for sections NOT active at initial paint — the
     *  active section's sheet still loads eagerly in the shell `<head>` for a flash-free first paint. */
    __tachyonSectionStyles?: Record<string, string>;
  }
}

const injected = new Set<string>();

/**
 * Injects a section's stylesheet into <head> the first time its lazy body chunk loads, instead of
 * the cockpit shell loading every embedded section's CSS unconditionally on every open (t-610705 —
 * the "CSS co-load bleed" gap called out in docs/specs/410-cockpit-single-app/plan.md). Idempotent:
 * safe to call every time the lazy import resolves (re-render, HMR, a second embed instance).
 */
export function loadSectionStylesheet(sectionId: string): void {
  const href = window.__tachyonSectionStyles?.[sectionId];
  if (!href || injected.has(href)) return;
  injected.add(href);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}
