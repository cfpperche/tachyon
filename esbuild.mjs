import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

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

mkdirSync("dist/webview", { recursive: true });
copyFileSync("src/config/tachyon.schema.json", "dist/tachyon.schema.json");
copyFileSync("node_modules/@vscode/codicons/dist/codicon.css", "dist/webview/codicon.css");
copyFileSync("node_modules/@vscode/codicons/dist/codicon.ttf", "dist/webview/codicon.ttf");

if (watch) {
  const ctxs = await Promise.all([esbuild.context(extension), esbuild.context(sidebar), esbuild.context(activity)]);
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(sidebar), esbuild.build(activity)]);
}
