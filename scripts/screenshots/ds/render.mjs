// spec 252 — design-system render harness. Renders each migrated webview under BOTH a dark AND a light
// VS Code theme (decision D3) so the maintainer can eyeball that (a) a panel title is 16px everywhere,
// (b) badges/buttons/cards/inputs are identical across panels, and (c) NO hardcoded color breaks the light
// theme (D4). It mounts the panel's REAL Preact <App> with a representative fixture (harness/<panel>.tsx),
// inlines the shared design-system.css + the panel's own <style> deltas (extracted from its host .ts), wraps
// it in a chosen theme's `--vscode-*` token block, and screenshots it with headless Chrome.
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
const DS_CSS = join(ROOT, "src/webview/shared/design-system.css");

// Each entry: the harness tsx that mounts <App> with a fixture, + the host .ts whose <style> deltas we reuse.
const PANELS = {
  plugins: { harness: "harness/plugins.tsx", styleFrom: "src/webview/PluginsPanel.ts" },
  handoff: { harness: "harness/handoff.tsx", styleFrom: "src/webview/HandoffPanel.ts" },
  activity: { harness: "harness/activity.tsx", styleFrom: "src/webview/ActivityPanel.ts" },
  sidebar: { harness: "harness/sidebar.tsx", styleFrom: "src/webview/SidebarPrototype.ts" },
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

function pageHtml({ themeCss, dsCss, panelCss, bundle }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<link rel="stylesheet" href="codicon.css">
<style>${themeCss}</style>
<style>${dsCss}</style>
<style>${panelCss}</style>
</head><body><div id="root"></div><script>${bundle}</script></body></html>`;
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
    let bundle;
    try { bundle = await bundleHarness(def.harness); }
    catch (e) { console.error(`✗ ${name}: harness not buildable yet (${e.message.split("\n")[0]})`); continue; }
    const panelCss = extractStyle(def.styleFrom);
    for (const theme of ["dark", "light"]) {
      const htmlPath = join(OUT, `${name}-${theme}.html`);
      const pngPath = join(OUT, `${name}-${theme}.png`);
      writeFileSync(htmlPath, pageHtml({ themeCss: themeRootCss(theme), dsCss, panelCss, bundle }));
      execFileSync(chrome, [
        "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
        "--force-device-scale-factor=2", "--window-size=1000,1500",
        "--virtual-time-budget=2000", "--default-background-color=00000000",
        `--screenshot=${pngPath}`, `file://${htmlPath}`,
      ], { stdio: "ignore" });
      console.log(`✓ ${name}-${theme}.png`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
