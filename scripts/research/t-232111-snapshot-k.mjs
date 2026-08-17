#!/usr/bin/env node
/**
 * t-232111 / SDD 511 fatia 0b — snapshot context k.
 *
 * Counts how many POSITIONS in a file match the whole (line ± k) block.
 * Does not count substring occurrences: a line "}" does not match inside "});".
 *
 * Usage: node scripts/research/t-232111-snapshot-k.mjs
 */

import { execFileSync } from "node:child_process";

const KS = [0, 1, 3];
const EXTRA_KS = [5];
const EXTS = new Set(["ts", "tsx", "css", "json", "md"]);
const SKIP_BASENAMES = new Set(["package-lock.json"]);

/** First-parent landings on main that actually touched reviewable source. */
const LANDINGS = [
  { sha: "c99bdf1c7a3aa8743a2c5ba1ca7f0bcbc783123c", subject: "merge(t-00bf87) Orca anchors" },
  { sha: "2adbe15d04d7da23cf87be2e8403ef94b381137b", subject: "chore(t-487702) bridge tool descriptions" },
  { sha: "3d1649332dd000592ee5bba27b081c0f9fa26fea", subject: "chore(t-0af538) card layout config out" },
  { sha: "29d50032cfb17cd421c6e2c7d987840e392c3a42", subject: "merge(t-617077) inbox triaged" },
  { sha: "65243380cdf420794217b46036cfc80febad73bd", subject: "merge(t-55fa50) runtime-config css" },
  { sha: "8873ad7e04f8dcd9ae4e01b460ea7767a5e2cb03", subject: "merge(t-5b06ba) plugins zerada" },
  { sha: "f1efd4197cca6824f6fa5caf9bac8d1a9afe0a5d", subject: "merge(t-d588c3) sidebar geometry" },
  { sha: "c2967a4469c7a08049e1f2e1e9ef75874641d72a", subject: "merge(t-e16954) agent-pane ramp" },
  { sha: "473c1acaaceb333a9fc92b158f29aeba34a8ce17", subject: "merge(t-4aac93) plugin multi-surface" },
  { sha: "8591113f094cee1d8a0890e22dad08878557d170", subject: "merge(t-07acef) inbox D" },
  { sha: "e8e3202b282775ea9df44ba08c3e38f588a61b56", subject: "merge(t-1cacae) inbox A" },
  { sha: "551f7fe4aec99c9e81b02913daba71e497ce5048", subject: "merge(t-affc0b) inbox C" },
  { sha: "b35adb44e1d8b72cbaa36f773ecc042347700136", subject: "merge(t-3484a4) inbox B" },
  { sha: "123e86fe3ed1b8e33e4e18fcf4e4c03759897b80", subject: "merge(t-d244e1) zombie engine" },
  { sha: "309745feb3748a572c6448fd4f3770bacc135bdf", subject: "merge(t-9f21ac) checklist 335MB" },
  { sha: "2778ccc472b7d16755a0da72bfe378f02b74f660", subject: "merge(checklist interno) Workspace.ts" },
  { sha: "d4668e192aeb24741eb0b68f532fb6aa42feff04", subject: "fix(t-544911) activity scroll" },
  { sha: "ee7d34505068b43b1b94e7e16d02df47a2bf5f56", subject: "merge(t-54cdb2) plugin dest harness" },
  { sha: "2bbdbba473c65498015eb7639fbf6486549d6922", subject: "merge(t-5554b4) agent-pane theme" },
  { sha: "1e472d9ee1562ad45c2f5902859b494f5af2cb3c", subject: "merge(t-9c7ce8) sidebar scale" },
  { sha: "3b720d0672841626287c3ea5883aebab7d0a71d6", subject: "merge(t-6e7d8a) sidebar absence" },
  { sha: "1187984208221d3ae86ebc8dc96951972d3a707b", subject: "merge(t-824fc3) design tokens" },
  { sha: "0718d20eec4ffc50f981e6d93f0f13a05b7609b6", subject: "merge(t-c2209d) parity dim 18" },
  { sha: "a855d46316fdd68032fd42f85c045b63da71c7a5", subject: "merge(t-30af3e) Node PATH refuse" },
  { sha: "00ac7ff1a458fd2978b2babf49b0fc28365cbc8e", subject: "meas(t-17674a) event-loop I/O" },
  { sha: "faf15070881cfd65f84284d32d8db1493c1df636", subject: "merge(t-0bf709) event-loop warning" },
  { sha: "774161b86dc4e08219252ea56668593ce74c32f6", subject: "merge(t-9eacf9) sidebar card" },
  { sha: "55de2fc42557838d9d4362da432c21d6e102fbc2", subject: "merge(t-025bce) Runbooks/Commands out" },
];

/** Full-file scan at HEAD — large + high structural repetition, one copy each. */
const STRESS_HEAD = [
  "packages/engine/src/workspace/Workspace.ts",
  "packages/engine/src/agents/AgentManager.ts",
  "apps/vscode-extension/src/extension.ts",
  "packages/webview-ui/src/webview/sidebar/App.tsx",
  "packages/webview-ui/src/webview/agent-studio-shell/App.tsx",
  "packages/webview-ui/src/webview/sidebar/sidebar.css",
  "packages/webview-ui/src/webview/shared/design-system.css",
  "scripts/webview-preview/routes.json",
  "apps/vscode-extension/package.json",
  "CHANGELOG.md",
  "docs/runtimes/parity.md",
  "test/unit/agentManager.test.ts",
];

const gitEnv = { ...process.env, LC_ALL: "C" };

function git(args, encoding = "utf8") {
  return execFileSync("git", args, { encoding, maxBuffer: 64 * 1024 * 1024, env: gitEnv });
}

function extOf(path) {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i + 1);
}

function basename(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function keepPath(path) {
  if (!EXTS.has(extOf(path))) return false;
  if (SKIP_BASENAMES.has(basename(path))) return false;
  return true;
}

function splitLines(text) {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function extractBlock(lines, index, k) {
  const start = Math.max(0, index - k);
  const end = Math.min(lines.length, index + k + 1);
  return lines.slice(start, end);
}

function windowCounts(lines, length) {
  const map = new Map();
  if (length <= 0 || lines.length < length) return map;
  const limit = lines.length - length;
  for (let i = 0; i <= limit; i++) {
    const key = lines.slice(i, i + length).join("\n");
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

function findStarts(lines, block) {
  const starts = [];
  const n = block.length;
  if (n === 0) return starts;
  const limit = lines.length - n;
  for (let i = 0; i <= limit; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (lines[i + j] !== block[j]) {
        ok = false;
        break;
      }
    }
    if (ok) starts.push(i);
  }
  return starts;
}

function blob(rev, path) {
  try {
    return git(["show", `${rev}:${path}`]);
  } catch {
    return null;
  }
}

function parseNameStatus(sha) {
  const out = git(["diff", "--name-status", `${sha}^1`, sha]);
  const files = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const status = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    if (status.startsWith("D")) continue;
    let path;
    if (status.startsWith("R") || status.startsWith("C")) {
      const parts = rest.split("\t");
      path = parts[parts.length - 1];
    } else {
      path = rest;
    }
    if (keepPath(path)) files.push(path);
  }
  return files;
}

function parseAddedLines(sha, path) {
  const out = git(["diff", "-U0", `${sha}^1`, sha, "--", path]);
  const added = [];
  let newLine = 0;
  for (const line of out.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      added.push(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      // old line: do not advance new-side counter
    } else if (line.startsWith(" ")) {
      newLine += 1;
    }
  }
  return added;
}

function classifyLine(text) {
  if (text.length === 0) return "empty";
  if (/^\s+$/.test(text)) return "whitespace";
  const trimmed = text.trim();
  if (trimmed === "}") return "}";
  if (trimmed === "};") return "};";
  if (trimmed === "},") return "},";
  if (trimmed === ");") return ");";
  if (trimmed === ");") return ");";
  if (trimmed === "})") return "})";
  if (trimmed === "});") return "});";
  if (trimmed === "return;") return "return;";
  if (trimmed === "{" || trimmed === "};" || trimmed === "],") return trimmed;
  if (trimmed === "]" || trimmed === "]," || trimmed === ");") return trimmed;
  if (/^\/\//.test(trimmed) || /^\/\*/.test(trimmed) || /^\*/.test(trimmed)) return "comment";
  if (trimmed.length <= 4) return `short:${JSON.stringify(trimmed)}`;
  return "other";
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function mean(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function emptyAgg() {
  return {
    observations: 0,
    files: 0,
    byExt: {},
    byK: Object.fromEntries([...KS, ...EXTRA_KS].map((k) => [k, {
      unique: 0,
      ambiguous: 0,
      missing: 0,
      bytes: [],
    }])),
    worst: [],
  };
}

function ensureExt(agg, ext) {
  if (!agg.byExt[ext]) {
    agg.byExt[ext] = {
      observations: 0,
      files: 0,
      byK: Object.fromEntries([...KS, ...EXTRA_KS].map((k) => [k, { unique: 0, ambiguous: 0 }])),
    };
  }
  return agg.byExt[ext];
}

function measureFile(agg, { rev, path, indices, source }) {
  const text = blob(rev, path);
  if (text === null) return;
  const lines = splitLines(text);
  if (lines.length === 0) return;
  const ext = extOf(path);
  const extAgg = ensureExt(agg, ext);
  extAgg.files += 1;
  agg.files += 1;

  const needed = [...KS, ...EXTRA_KS];
  const countsByLen = new Map();
  let maxBlock = 1;
  for (const k of needed) maxBlock = Math.max(maxBlock, 2 * k + 1);
  for (let len = 1; len <= maxBlock; len++) {
    countsByLen.set(len, windowCounts(lines, len));
  }

  const seen = new Set();
  for (const raw of indices) {
    const index = raw - 1;
    if (index < 0 || index >= lines.length) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    agg.observations += 1;
    extAgg.observations += 1;

    for (const k of needed) {
      const block = extractBlock(lines, index, k);
      const key = block.join("\n");
      const matches = countsByLen.get(block.length)?.get(key) ?? 0;
      const bucket = agg.byK[k];
      const extBucket = extAgg.byK[k];
      if (matches === 0) {
        throw new Error(`capture-time miss ${path}:${index + 1} k=${k} len=${block.length}`);
      }
      else if (matches === 1) {
        bucket.unique += 1;
        extBucket.unique += 1;
      } else {
        bucket.ambiguous += 1;
        extBucket.ambiguous += 1;
        if (k === 3 || k === 5) {
          agg.worst.push({
            k,
            matches,
            rev,
            path,
            line: index + 1,
            ext,
            source,
            text: lines[index],
            class: classifyLine(lines[index]),
            fileLines: lines.length,
            blockLines: block.length,
          });
        }
      }
      bucket.bytes.push(Buffer.byteLength(key, "utf8"));
    }
  }
}

function summarizeBytes(bytes) {
  const sorted = [...bytes].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? 0,
    mean: Number(mean(sorted).toFixed(1)),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function summarizeAgg(agg) {
  const byK = {};
  for (const k of [...KS, ...EXTRA_KS]) {
    const b = agg.byK[k];
    const n = b.unique + b.ambiguous + b.missing;
    byK[k] = {
      observations: n,
      unique: b.unique,
      ambiguous: b.ambiguous,
      missing: b.missing,
      ambiguousPct: n === 0 ? 0 : Number(((100 * b.ambiguous) / n).toFixed(3)),
      bytes: summarizeBytes(b.bytes),
    };
  }
  const byExt = {};
  for (const [ext, e] of Object.entries(agg.byExt)) {
    byExt[ext] = {
      observations: e.observations,
      files: e.files,
      byK: Object.fromEntries([...KS, ...EXTRA_KS].map((k) => {
        const b = e.byK[k];
        const n = b.unique + b.ambiguous;
        return [k, {
          unique: b.unique,
          ambiguous: b.ambiguous,
          ambiguousPct: n === 0 ? 0 : Number(((100 * b.ambiguous) / n).toFixed(3)),
        }];
      })),
    };
  }
  agg.worst.sort((a, b) => b.matches - a.matches || a.k - b.k);
  const at3 = agg.worst.filter((w) => w.k === 3);
  const worstByExt = {};
  for (const w of at3) {
    if (!worstByExt[w.ext]) worstByExt[w.ext] = w;
  }
  const classCounts = {};
  for (const w of at3) {
    classCounts[w.class] = (classCounts[w.class] ?? 0) + 1;
  }
  const noJson = { unique: 0, ambiguous: 0 };
  for (const [ext, e] of Object.entries(byExt)) {
    if (ext === "json") continue;
    noJson.unique += e.byK[3].unique;
    noJson.ambiguous += e.byK[3].ambiguous;
  }
  const noJsonN = noJson.unique + noJson.ambiguous;
  return {
    observations: agg.observations,
    files: agg.files,
    byK,
    byExt,
    noJsonAt3: {
      unique: noJson.unique,
      ambiguous: noJson.ambiguous,
      observations: noJsonN,
      ambiguousPct: noJsonN === 0 ? 0 : Number(((100 * noJson.ambiguous) / noJsonN).toFixed(3)),
    },
    classCountsAt3: classCounts,
    worstByExt,
    worstTop: agg.worst.slice(0, 15),
    worstAt3: at3.slice(0, 5),
    worstAt5: agg.worst.filter((w) => w.k === 5).slice(0, 5),
  };
}

function rangeList(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(i);
  return out;
}

const reviewAll = emptyAgg();
const reviewAdded = emptyAgg();
const stress = emptyAgg();
const landingStats = [];
const fileSizes = [];

for (const landing of LANDINGS) {
  const paths = parseNameStatus(landing.sha);
  let addedCount = 0;
  let allCount = 0;
  const extSet = new Set();
  let maxLines = 0;
  let maxPath = "";
  for (const path of paths) {
    const text = blob(landing.sha, path);
    if (text === null) continue;
    const lines = splitLines(text);
    extSet.add(extOf(path));
    if (lines.length > maxLines) {
      maxLines = lines.length;
      maxPath = path;
    }
    fileSizes.push({ sha: landing.sha.slice(0, 8), path, lines: lines.length, ext: extOf(path) });
    const added = parseAddedLines(landing.sha, path);
    addedCount += added.length;
    allCount += lines.length;
    measureFile(reviewAll, {
      rev: landing.sha,
      path,
      indices: rangeList(lines.length),
      source: "review-all",
    });
    measureFile(reviewAdded, {
      rev: landing.sha,
      path,
      indices: added,
      source: "review-added",
    });
  }
  landingStats.push({
    sha: landing.sha,
    short: landing.sha.slice(0, 8),
    subject: landing.subject,
    files: paths.length,
    addedLines: addedCount,
    allLines: allCount,
    exts: [...extSet].sort(),
    largest: maxPath ? { path: maxPath, lines: maxLines } : null,
  });
}

const head = git(["rev-parse", "HEAD"]).trim();
for (const path of STRESS_HEAD) {
  const text = blob("HEAD", path);
  if (text === null) {
    console.error(`stress missing at HEAD: ${path}`);
    continue;
  }
  const lines = splitLines(text);
  measureFile(stress, {
    rev: head,
    path,
    indices: rangeList(lines.length),
    source: "stress-head",
  });
}

function decorateWorst(items) {
  return items.map((w) => {
    const text = blob(w.rev, w.path);
    if (text === null) return { ...w, otherStarts: [] };
    const lines = splitLines(text);
    const block = extractBlock(lines, w.line - 1, w.k);
    const starts = findStarts(lines, block).map((i) => i + 1);
    return {
      ...w,
      blockPreview: block.map((l) => (l.length > 80 ? `${l.slice(0, 77)}...` : l)),
      otherStarts: starts.slice(0, 12),
      startCount: starts.length,
    };
  });
}

const result = {
  measuredAt: new Date().toISOString(),
  head,
  method: {
    match: "whole consecutive line-block positions (not substring)",
    snapshot: "k lines before + the line + k lines after; shorter at file edges",
    ambiguous: "block appears at more than one starting line index",
    ks: KS,
    extraKs: EXTRA_KS,
    excluded: ["package-lock.json"],
    extensions: [...EXTS],
  },
  landings: landingStats,
  reviewAll: summarizeAgg(reviewAll),
  reviewAdded: summarizeAgg(reviewAdded),
  stressHead: summarizeAgg(stress),
};

for (const key of ["reviewAll", "reviewAdded", "stressHead"]) {
  result[key].worstAt3 = decorateWorst(result[key].worstAt3);
  result[key].worstAt5 = decorateWorst(result[key].worstAt5);
  result[key].worstByExt = Object.fromEntries(
    Object.entries(result[key].worstByExt).map(([ext, w]) => [ext, decorateWorst([w])[0]]),
  );
}

function mdTable(title, summary) {
  const rows = [];
  rows.push(`### ${title}`);
  rows.push("");
  rows.push(`Observações: ${summary.observations} linhas em ${summary.files} arquivos (pares commit×path).`);
  rows.push("");
  rows.push("| k | únicas | ambíguas | ausentes | % ambíguas | bytes média | p50 | p95 | máx |");
  rows.push("|---|--------|----------|----------|------------|-------------|-----|-----|-----|");
  for (const k of [...KS, ...EXTRA_KS]) {
    const b = summary.byK[k];
    rows.push(`| ${k} | ${b.unique} | ${b.ambiguous} | ${b.missing} | ${b.ambiguousPct}% | ${b.bytes.mean} | ${b.bytes.p50} | ${b.bytes.p95} | ${b.bytes.max} |`);
  }
  rows.push("");
  rows.push("| ext | linhas | arquivos | k=0 amb | k=1 amb | k=3 amb | k=5 amb |");
  rows.push("|-----|--------|----------|---------|---------|---------|---------|");
  for (const ext of Object.keys(summary.byExt).sort()) {
    const e = summary.byExt[ext];
    rows.push(`| .${ext} | ${e.observations} | ${e.files} | ${e.byK[0].ambiguous} (${e.byK[0].ambiguousPct}%) | ${e.byK[1].ambiguous} (${e.byK[1].ambiguousPct}%) | ${e.byK[3].ambiguous} (${e.byK[3].ambiguousPct}%) | ${e.byK[5].ambiguous} (${e.byK[5].ambiguousPct}%) |`);
  }
  rows.push("");
  return rows.join("\n");
}

const md = [
  mdTable("Amostra review-all — todas as linhas do lado modificado", result.reviewAll),
  mdTable("Corte review-added — só linhas `+` do diff", result.reviewAdded),
  mdTable("Controle negativo stress-head — arquivos grandes/repetitivos em HEAD", result.stressHead),
].join("\n");

process.stdout.write(md);
process.stdout.write("\n--- JSON ---\n");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
