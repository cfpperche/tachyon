import * as esbuild from "esbuild";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");

// The extension host bundle (Node; vscode external).
const extension = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
};

// spec 265 — the standalone tool LAUNCHER bundle (Node; NO vscode). Copied to .tachyon/bin/_tachyon-tool.js
// and exec'd by a git pre-commit hook with no VS Code running, so it must be self-contained.
const toolLauncher = {
  entryPoints: ["src/toolLauncherEntry.ts"],
  bundle: true,
  outfile: "dist/tool-launcher.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
  logLevel: "info",
};

// spec 237 — the Preact sidebar webview bundle (browser; runs in the webview iframe, never imports vscode).
const sidebar = {
  entryPoints: ["src/webview/sidebar/main.tsx"],
  bundle: true,
  outfile: "dist/webview/sidebar.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: !watch,
  sourcemap: true,
  logLevel: "info",
};

const preactCompat = {
  react: "preact/compat",
  "react-dom": "preact/compat",
  "react-dom/client": "preact/compat",
  "react/jsx-runtime": "preact/jsx-runtime",
  "react/jsx-dev-runtime": "preact/jsx-dev-runtime",
};

// spec 238 — the Preact activity-view webview bundle (editor-area panel; never imports vscode).
const activity = {
  ...sidebar,
  entryPoints: ["src/webview/activity/main.tsx"],
  outfile: "dist/webview/activity.js",
};

// spec 245 — the Preact Project Handoff webview bundle (editor-area panel; never imports vscode).
const handoff = {
  ...sidebar,
  entryPoints: ["src/webview/handoff/main.tsx"],
  outfile: "dist/webview/handoff.js",
};

// spec 250 — the Preact Plugins View webview bundle (editor-area panel; never imports vscode).
const plugins = {
  ...sidebar,
  entryPoints: ["src/webview/plugins/main.tsx"],
  outfile: "dist/webview/plugins.js",
};

// spec 255 — the Preact/Tiptap Pin Studio editor-area webview bundle.
const pinStudio = {
  ...sidebar,
  entryPoints: ["src/webview/pin-studio/main.tsx"],
  outfile: "dist/webview/pin-studio.js",
};

// spec 256 — Excalidraw as its OWN on-demand bundle. It declares React peers; Tachyon webviews stay
// Preact-only by aliasing those peers at the bundle boundary and loading this file only for sketch editing.
const excalidraw = {
  ...sidebar,
  entryPoints: ["src/webview/pin-studio/excalidraw-entry.tsx"],
  outfile: "dist/webview/excalidraw.js",
  alias: preactCompat,
  define: {
    "process.env.IS_PREACT": "\"true\"",
    "process.env.NODE_ENV": watch ? "\"development\"" : "\"production\"",
  },
};

// spec 238 (inc 16) — mermaid as its OWN on-demand iife bundle (~3MB). NOT loaded with the activity panel;
// the webview injects it as a <script> only when a ```mermaid block first appears, then caches it.
const mermaid = {
  entryPoints: ["src/webview/activity/mermaid-entry.ts"],
  bundle: true,
  outfile: "dist/webview/mermaid.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  minify: true, // always minified — it's large; sourcemap omitted to keep dist lean
  logLevel: "info",
};

// spec 238 (inc 17) — KaTeX as its OWN on-demand iife bundle (+ its CSS/fonts copied below). Loaded only
// when a math span first appears, like mermaid; no-math chats never fetch it.
const katex = {
  entryPoints: ["src/webview/activity/katex-entry.ts"],
  bundle: true,
  outfile: "dist/webview/katex.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  minify: true,
  logLevel: "info",
};

// spec 278 — the dev-only preview-harness glue (reads ?view=&fixture=, loads a real webview bundle, injects a
// fixture). Output lives OUTSIDE dist/webview and is excluded from the vsix (.vscodeignore); never shipped.
const preview = {
  ...sidebar,
  entryPoints: ["scripts/webview-preview/preview.ts"],
  outfile: "dist/webview-preview/preview.js",
  format: "esm",
};

mkdirSync("dist/webview", { recursive: true });
copyFileSync("src/config/tachyon.schema.json", "dist/tachyon.schema.json");
copyFileSync("node_modules/@vscode/codicons/dist/codicon.css", "dist/webview/codicon.css");
copyFileSync("src/webview/shared/design-system.css", "dist/webview/design-system.css"); // spec 252 — shared webview design system
copyFileSync("src/webview/sidebar/sidebar.css", "dist/webview/sidebar.css"); // spec 274 — sidebar styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/plugins/plugins.css", "dist/webview/plugins.css"); // spec 278 — plugins styles (shared by the webview + the dev preview harness)
copyFileSync("node_modules/@vscode/codicons/dist/codicon.ttf", "dist/webview/codicon.ttf");
// KaTeX stylesheet + fonts (the CSS references fonts/ relatively → keep them adjacent under dist/webview).
copyFileSync("node_modules/katex/dist/katex.min.css", "dist/webview/katex.min.css");
cpSync("node_modules/katex/dist/fonts", "dist/webview/fonts", { recursive: true });
// Excalidraw package layouts differ by version:
// - 0.18.x ships dist/prod/index.css + dist/prod/fonts.
// - 0.17.x injects styles from JS and lazy-loads dist/excalidraw-assets/* chunks/fonts.
const excalidrawCss = "node_modules/@excalidraw/excalidraw/dist/prod/index.css";
const excalidrawFonts = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
const excalidrawAssets = "node_modules/@excalidraw/excalidraw/dist/excalidraw-assets";
if (existsSync(excalidrawCss)) {
  copyFileSync(excalidrawCss, "dist/webview/excalidraw.css");
} else {
  writeFileSync("dist/webview/excalidraw.css", "/* Excalidraw injects its styles from the JS bundle in this package layout. */\n");
}
if (existsSync(excalidrawFonts)) {
  cpSync(excalidrawFonts, "dist/webview/fonts", { recursive: true });
}
if (existsSync(excalidrawAssets)) {
  rmSync("dist/webview/excalidraw-assets", { recursive: true, force: true });
  cpSync(excalidrawAssets, "dist/webview/excalidraw-assets", { recursive: true });
}

if (watch) {
  const ctxs = await Promise.all([extension, toolLauncher, sidebar, activity, handoff, plugins, pinStudio, excalidraw, mermaid, katex, preview].map((c) => esbuild.context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all([extension, toolLauncher, sidebar, activity, handoff, plugins, pinStudio, excalidraw, mermaid, katex, preview].map((c) => esbuild.build(c)));
}
