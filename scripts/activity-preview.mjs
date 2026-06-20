#!/usr/bin/env node
// Headless dogfood for the Activity view (spec 238): render ANY claude transcript's normalized activity
// feed as plain text — no EDH, no live agent. Drives the SAME pure normalizer + view-model the webview uses.
//
//   node scripts/activity-preview.mjs <transcript.jsonl>
//   npm run activity:preview -- ~/.claude/projects/<enc-cwd>/<uuid>.jsonl
//
// Use it to eyeball how a real (or fixture) session renders, or to spot transcript shapes the normalizer
// drops to `raw`. Bundles src/activity on the fly via esbuild (already a dep).

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/activity-preview.mjs <transcript.jsonl>"); process.exit(64); }
if (!fs.existsSync(file)) { console.error(`not found: ${file}`); process.exit(66); }

const out = path.join(os.tmpdir(), `activity-preview-${process.pid}.mjs`);
await esbuild.build({
  stdin: {
    contents: `export { normalizeClaude } from "./src/activity/claudeNormalizer.ts";\nexport { buildActivityView } from "./src/activity/activityView.ts";`,
    resolveDir: ".",
    loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
});
const { normalizeClaude, buildActivityView } = await import(pathToFileURL(out).href);
fs.rmSync(out, { force: true });

const lines = fs.readFileSync(file, "utf8").split("\n");
const vm = buildActivityView(normalizeClaude(lines, file), { tier: "structured" });
const s = vm.summary;

const C = { dim: "\x1b[2m", b: "\x1b[1m", grn: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", yel: "\x1b[33m", r: "\x1b[0m" };
const trunc = (t, n = 100) => { const one = String(t).replace(/\s+/g, " ").trim(); return one.length > n ? one.slice(0, n) + "…" : one; };

console.log(`${C.b}Activity — ${path.basename(file)}${C.r}`);
console.log(`${C.dim}${vm.runtime ?? "?"} ${vm.runtimeVersion ?? ""} · ${s.messages} msgs · ${s.toolsRunning} running · ${s.toolsFailed} failed · ${s.filesChanged.length} files · ${s.tokens.input}/${s.tokens.output} tok${C.r}\n`);

for (const it of vm.items) {
  const t = it.timestamp ? `${C.dim}${(/T(\d{2}:\d{2})/.exec(it.timestamp) || [, "--:--"])[1]}${C.r} ` : "";
  if (it.kind === "message") {
    const who = it.role === "user" ? `${C.cyan}YOU${C.r}` : `${C.grn}AGENT${C.r}`;
    console.log(`${t}${who}  ${trunc(it.title, 140)}`);
  } else if (it.kind === "thinking") {
    console.log(`${t}${C.dim}💭 ${trunc(it.title, 120)}${C.r}`);
  } else if (it.kind === "image") {
    console.log(`${t}${C.dim}🖼  image (${it.detail}) ${it.role}${C.r}`);
  } else if (it.kind === "tool") {
    const mark = it.failed ? `${C.red}✗${C.r}` : "·";
    const res = it.result ? ` ${C.dim}↳ ${trunc(it.result, 60)}${C.r}` : "";
    console.log(`  ${mark} ${C.b}${it.title}${C.r} ${C.dim}${it.detail ?? it.path ?? ""}${C.r}${res}`);
  } else if (it.kind === "error") {
    console.log(`${t}${C.red}! ${trunc(it.title, 120)}${C.r}`);
  } else if (it.kind === "boundary") {
    console.log(`${C.dim}── ⌥ ${it.title}${it.detail ? ` (${it.detail})` : ""}${it.resultFull ? " [+summary]" : ""} ──${C.r}`);
  } else if (it.kind === "command") {
    console.log(`${C.dim}⌘ ${it.title}${C.r}`);
  }
}
console.log(`\n${C.dim}${vm.items.length} items rendered.${C.r}`);
