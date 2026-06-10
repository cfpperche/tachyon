import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
});

mkdirSync("dist/webview", { recursive: true });
copyFileSync("src/config/tachyon.schema.json", "dist/tachyon.schema.json");
copyFileSync("node_modules/@vscode/codicons/dist/codicon.css", "dist/webview/codicon.css");
copyFileSync("node_modules/@vscode/codicons/dist/codicon.ttf", "dist/webview/codicon.ttf");

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
