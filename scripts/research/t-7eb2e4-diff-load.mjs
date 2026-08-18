#!/usr/bin/env node
/** Offline measurement for t-7eb2e4 / SDD 513 slice 0. No product path imports this file. */
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import hljs from "highlight.js/lib/common";
import puppeteer from "puppeteer-core";

const LANDINGS = [
  "c99bdf1c7a3aa8743a2c5ba1ca7f0bcbc783123c", "2adbe15d04d7da23cf87be2e8403ef94b381137b",
  "3d1649332dd000592ee5bba27b081c0f9fa26fea", "29d50032cfb17cd421c6e2c7d987840e392c3a42",
  "65243380cdf420794217b46036cfc80febad73bd", "8873ad7e04f8dcd9ae4e01b460ea7767a5e2cb03",
  "f1efd4197cca6824f6fa5caf9bac8d1a9afe0a5d", "c2967a4469c7a08049e1f2e1e9ef75874641d72a",
  "473c1acaaceb333a9fc92b158f29aeba34a8ce17", "8591113f094cee1d8a0890e22dad08878557d170",
  "e8e3202b282775ea9df44ba08c3e38f588a61b56", "551f7fe4aec99c9e81b02913daba71e497ce5048",
  "b35adb44e1d8b72cbaa36f773ecc042347700136", "123e86fe3ed1b8e33e4e18fcf4e4c03759897b80",
  "309745feb3748a572c6448fd4f3770bacc135bdf", "2778ccc472b7d16755a0da72bfe378f02b74f660",
  "d4668e192aeb24741eb0b68f532fb6aa42feff04", "ee7d34505068b43b1b94e7e16d02df47a2bf5f56",
  "2bbdbba473c65498015eb7639fbf6486549d6922", "1e472d9ee1562ad45c2f5902859b494f5af2cb3c",
  "3b720d0672841626287c3ea5883aebab7d0a71d6", "1187984208221d3ae86ebc8dc96951972d3a707b",
  "0718d20eec4ffc50f981e6d93f0f13a05b7609b6", "a855d46316fdd68032fd42f85c045b63da71c7a5",
  "00ac7ff1a458fd2978b2babf49b0fc28365cbc8e", "faf15070881cfd65f84284d32d8db1493c1df636",
  "774161b86dc4e08219252ea56668593ce74c32f6", "55de2fc42557838d9d4362da432c21d6e102fbc2",
];
const EXTS = new Set(["ts", "tsx", "css", "json", "md"]);
const skip = (path) => path.endsWith("/package-lock.json") || path === "package-lock.json" || !EXTS.has(path.split(".").at(-1));
const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const pct = (sorted, p) => sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)] ?? 0;
const summary = (values) => { const s = [...values].sort((a, b) => a - b); return { n: s.length, median: pct(s, 50), p90: pct(s, 90), max: s.at(-1) ?? 0 }; };
const columns = (line) => [...line].reduce((n, c) => c === "\t" ? n + (4 - n % 4) : n + 1, 0);

const started = performance.now();
const landings = [];
const perFile = [];
const displayColumns = [];
for (const sha of LANDINGS) {
  const byPath = new Map();
  const deleted = new Set(git(["diff", "--name-status", `${sha}^1`, sha, "--"]).split("\n")
    .filter((row) => row.startsWith("D\t")).map((row) => row.slice(2)));
  for (const row of git(["diff", "--numstat", `${sha}^1`, sha, "--"]).trim().split("\n")) {
    const [a, d, ...parts] = row.split("\t"); const path = parts.at(-1);
    if (!path || skip(path) || a === "-" || d === "-") continue;
    byPath.set(path, Number(a) + Number(d));
  }
  const patch = git(["diff", "--no-ext-diff", "--unified=0", `${sha}^1`, sha, "--", ...byPath.keys()]);
  for (const line of patch.split("\n")) {
    if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) displayColumns.push(columns(line.slice(1)));
  }
  const lines = [...byPath.values()];
  perFile.push(...lines);
  landings.push({ sha, files: lines.length, modifiedSideFiles: [...byPath.keys()].filter((path) => !deleted.has(path)).length,
    changedLines: lines.reduce((a, b) => a + b, 0) });
}

const largest = { sha: "2778ccc472b7d16755a0da72bfe378f02b74f660", path: "packages/engine/src/workspace/Workspace.ts" };
const source = git(["show", `${largest.sha}:${largest.path}`]);
for (let i = 0; i < 5; i++) hljs.highlight(source, { language: "typescript" }).value;
const highlightMs = [];
for (let i = 0; i < 30; i++) { const t = performance.now(); hljs.highlight(source, { language: "typescript" }).value; highlightMs.push(performance.now() - t); }

const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
const zeroPx = await page.evaluate(() => { const c = document.createElement("canvas"); const ctx = c.getContext("2d"); ctx.font = "12px monospace"; return ctx.measureText("0".repeat(100)).width / 100; });
await browser.close();
const unifiedColumns = Math.floor((880 - 96) / zeroPx);
const splitColumns = Math.floor(((880 - 168) / 2) / zeroPx);
const fit = (limit) => ({ limit, fits: displayColumns.filter((n) => n <= limit).length, total: displayColumns.length,
  fitPct: Number((100 * displayColumns.filter((n) => n <= limit).length / displayColumns.length).toFixed(2)), max: Math.max(...displayColumns) });

const clockSamples = [];
for (let i = 0; i < 100000; i++) { const t = performance.now(); clockSamples.push(performance.now() - t); }
process.stdout.write(`${JSON.stringify({
  measuredAt: new Date().toISOString(), sample: { landings: landings.length, filePairs: perFile.length, commits: landings },
  diff: { filesPerReview: summary(landings.map((x) => x.files)), changedLinesPerReview: summary(landings.map((x) => x.changedLines)), changedLinesPerFile: summary(perFile) },
  highlight: { ...largest, chars: source.length, lines: source.split("\n").length - 1, ms: summary(highlightMs) },
  width: { viewportPx: 880, measuredZeroPx: zeroPx, unified: fit(unifiedColumns), sideBySidePerSide: fit(splitColumns) },
  measurementCost: { wallMs: performance.now() - started, timingWrapperMedianMs: summary(clockSamples).median, hotPathCost: 0 },
}, null, 2)}\n`);
