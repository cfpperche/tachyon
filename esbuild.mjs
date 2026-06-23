import * as esbuild from "esbuild";
import { copyFileSync, cpSync, mkdirSync } from "node:fs";

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

mkdirSync("dist/webview", { recursive: true });
copyFileSync("src/config/tachyon.schema.json", "dist/tachyon.schema.json");
copyFileSync("node_modules/@vscode/codicons/dist/codicon.css", "dist/webview/codicon.css");
copyFileSync("node_modules/@vscode/codicons/dist/codicon.ttf", "dist/webview/codicon.ttf");
// KaTeX stylesheet + fonts (the CSS references fonts/ relatively → keep them adjacent under dist/webview).
copyFileSync("node_modules/katex/dist/katex.min.css", "dist/webview/katex.min.css");
cpSync("node_modules/katex/dist/fonts", "dist/webview/fonts", { recursive: true });

if (watch) {
  const ctxs = await Promise.all([extension, sidebar, activity, handoff, plugins, mermaid, katex].map((c) => esbuild.context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all([extension, sidebar, activity, handoff, plugins, mermaid, katex].map((c) => esbuild.build(c)));
}
