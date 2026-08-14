// spec 252 — design-system render harness. Renders each migrated webview under BOTH a dark AND a light
// VS Code theme (decision D3) so the maintainer can eyeball that (a) a panel title is 16px everywhere,
// (b) badges/buttons/cards/inputs are identical across panels, and (c) NO hardcoded color breaks the light
// theme (D4). It mounts the panel's REAL Preact <App> with a representative fixture (harness/<panel>.tsx),
// inlines the shared design-system.css + the panel's own <style> deltas (extracted from its host .ts), wraps
// it in a chosen theme's `--vscode-*` token block, and screenshots it with headless Chrome. A migrated
// panel whose CSS already lives in its own file points at that file directly.
//
//   node scripts/screenshots/ds/render.mjs [panel...]   # default: all known panels, both themes
//
// Output: scripts/screenshots/ds/out/<panel>-<theme>.png (gitignored). Deterministic; no real AI / VS Code.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { themeRootCss } from "./themes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const OUT = join(HERE, "out");
const DS_CSS = join(ROOT, "packages/webview-ui/src/webview/shared/design-system.css");

// Each entry pairs the panel stylesheet (an extracted host <style> or a direct CSS file) with EITHER a Preact harness (`harness`: a tsx
// that mounts <App> with a fixture) OR a static body fragment (`body`: an .html file of representative markup)
// for the vanilla-JS panels whose DOM is built host-side via postMessage and can't be mounted standalone.
const PANELS = {
  plugins: { harness: "harness/plugins.tsx", styleFrom: "apps/vscode-extension/src/webview/PluginsPanel.ts" },
  "plugins-consent": { harness: "harness/plugins-consent.tsx", styleFile: "packages/webview-ui/src/webview/plugins/plugins.css", width: 880 },
  handoff: { harness: "harness/handoff.tsx", styleFrom: "apps/vscode-extension/src/webview/HandoffPanel.ts" },
  inspector: { body: "harness/inspector.body.html", styleFrom: "apps/vscode-extension/src/webview/ServerInspector.ts" },
  studio: { body: "harness/studio.body.html", styleFrom: "apps/vscode-extension/src/webview/AgentStudioPanel.ts" },
  activity: { harness: "harness/activity.tsx", styleFrom: "apps/vscode-extension/src/webview/ActivityPanel.ts" },
  sidebar: { harness: "harness/sidebar.tsx", styleFrom: "apps/vscode-extension/src/webview/SidebarPrototype.ts", width: 340 },
};

/** Pull the FIRST `<style> … </style>` block's inner CSS out of a host .ts source (the panel's deltas). */
function extractStyle(relTsPath) {
  const src = readFileSync(join(ROOT, relTsPath), "utf8");
  const m = src.match(/<style>([\s\S]*?)<\/style>/);
  return m ? m[1] : "";
}

async function bundleHarness(rel) {
  const r = await build({
    entryPoints: [join(HERE, rel)],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: "preact",
    // Match the production webview build: Tachyon Kit's React peers must resolve to the one Preact runtime.
    alias: { react: "preact/compat", "react-dom": "preact/compat", "react-dom/client": "preact/compat" },
    logLevel: "warning",
  });
  return r.outputFiles[0].text;
}

function findChrome() {
  for (const c of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try { execFileSync("command", ["-v", c], { shell: "/bin/bash", stdio: "ignore" }); return c; } catch { /* next */ }
  }
  return "google-chrome";
}

function pageHtml({ themeCss, dsCss, panelCss, scriptFile, bodyHtml }) {
  // Preact panels load a bundle via <script src> (NOT inlined): a bundled dep can contain the literal
  // "</script>", which would prematurely close an inline tag and inject a SECOND <body> (double render).
  // Static panels drop in a representative body fragment instead.
  const inner = bodyHtml !== undefined ? bodyHtml : `<div id="root"></div><script src="${scriptFile}"></script>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<link rel="stylesheet" href="codicon.css">
<style>${themeCss}</style>
<style>${dsCss}</style>
<style>${panelCss}</style>
<!-- harness-only: a full-page screenshot tiles the page and re-paints position:sticky headers in every tile
     (a Chrome headless artifact, not a panel bug). Pin them static for the capture; the real panel is unchanged. -->
<style>.ds-head, .head, .feedhead, .topbar { position: static !important; }</style>
</head><body>${inner}</body></html>`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  // codicon font assets adjacent to the html so `codicon.css` resolves `codicon.ttf` relatively.
  copyFileSync(join(ROOT, "node_modules/@vscode/codicons/dist/codicon.css"), join(OUT, "codicon.css"));
  copyFileSync(join(ROOT, "node_modules/@vscode/codicons/dist/codicon.ttf"), join(OUT, "codicon.ttf"));
  const dsCss = readFileSync(DS_CSS, "utf8");
  const chrome = findChrome();

  const want = process.argv.slice(2).filter((a) => PANELS[a]);
  const panels = want.length ? want : Object.keys(PANELS);

  for (const name of panels) {
    const def = PANELS[name];
    let scriptFile, bodyHtml;
    if (def.body) {
      bodyHtml = readFileSync(join(HERE, def.body), "utf8");
    } else {
      try { const bundle = await bundleHarness(def.harness); scriptFile = `${name}.bundle.js`; writeFileSync(join(OUT, scriptFile), bundle); }
      catch (e) { console.error(`✗ ${name}: harness not buildable yet (${e.message.split("\n")[0]})`); continue; }
    }
    const panelCss = def.styleFile ? readFileSync(join(ROOT, def.styleFile), "utf8") : extractStyle(def.styleFrom);
    for (const theme of ["dark", "light"]) {
      const htmlPath = join(OUT, `${name}-${theme}.html`);
      const pngPath = join(OUT, `${name}-${theme}.png`);
      writeFileSync(htmlPath, pageHtml({ themeCss: themeRootCss(theme), dsCss, panelCss, scriptFile, bodyHtml }));
      execFileSync(chrome, [
        "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
        `--window-size=${def.width ?? 1000},1400`, "--virtual-time-budget=2500",
        "--run-all-compositor-stages-before-draw",
        `--screenshot=${pngPath}`, `file://${htmlPath}`,
      ], { stdio: "ignore" });
      console.log(`✓ ${name}-${theme}.png`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
