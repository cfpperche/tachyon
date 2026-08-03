/**
 * SDD 485 C2 — "does the build emit `dist/webview/<view>.js`?", asked once.
 *
 * Before this phase every webview bundle was its own esbuild target with a literal
 * `outfile: "dist/webview/<view>.js"`, so three separate tests answered the question with
 * `esbuild.includes("dist/webview/<view>.js")`. The standalone apps are now entries of ONE splitting
 * invocation with `outdir` + `entryNames: "[name]"`, so their output paths do not appear as literals
 * anywhere — a string search would report the two biggest surfaces in the repo as unbuilt.
 *
 * Both shapes are read here rather than in each caller, because three copies of "how the build names its
 * outputs" is exactly how one of them comes to be wrong quietly.
 */

const APP_VIEWS_RE = /const WEBVIEW_APP_VIEWS = \[([\s\S]*?)\];/;

/** the views built as entries of the multi-entry, code-split invocation. */
export function multiEntryWebviewViews(esbuildSource: string): string[] {
  const block = APP_VIEWS_RE.exec(esbuildSource)?.[1];
  if (!block) return [];
  return [...block.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

/** does `esbuild.mjs` emit `dist/webview/<view>.js`, by either build shape? */
export function buildsWebviewEntry(esbuildSource: string, view: string): boolean {
  return esbuildSource.includes(`dist/webview/${view}.js`) || multiEntryWebviewViews(esbuildSource).includes(view);
}
