#!/usr/bin/env node
/**
 * Internal repo hygiene scan — project tooling under scripts/, not a Tachyon product plugin/skill.
 *
 * On-demand report only: unused-export / orphan-file candidates (knip) + textual clones (jscpd).
 * Never deletes code, never auto-fixes, not wired into verify:full.
 *
 * Usage:
 *   node scripts/code-hygiene/scan.mjs
 *   node scripts/code-hygiene/scan.mjs --out path/to/report.md
 *   node scripts/code-hygiene/scan.mjs --skip-knip | --skip-jscpd
 *   node scripts/code-hygiene/scan.mjs --exit-code
 *   npm run hygiene:scan
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HYGIENE_DIR = path.join(ROOT, ".tachyon", "code-hygiene");
const DEFAULT_OUT = path.join(HYGIENE_DIR, "report.md");

/** Pinned versions for local install / ensure (not product runtime deps). */
const KNIP_PKG = "knip@5.61.3";
const JSCPD_PKG = "jscpd@4.0.5";

const JSCPD_MIN_LINES = 10;
const JSCPD_MIN_TOKENS = 50;

function parseArgs(argv) {
  const args = {
    out: DEFAULT_OUT,
    skipKnip: false,
    skipJscpd: false,
    exitCode: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--skip-knip") args.skipKnip = true;
    else if (a === "--skip-jscpd") args.skipJscpd = true;
    else if (a === "--exit-code") args.exitCode = true;
    else if (a === "--out") {
      const next = argv[++i];
      if (!next) throw new Error("--out requires a path");
      args.out = path.isAbsolute(next) ? next : path.resolve(ROOT, next);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Build roots for reachability analysis. Prefer live entryPoints from esbuild.mjs
 * so the list tracks product bundles without a second hand-maintained catalog.
 */
export function extractEntrypoints(esbuildSource) {
  const found = new Set();
  const re = /entryPoints:\s*\[\s*([^\]]+?)\s*\]/gs;
  let m;
  while ((m = re.exec(esbuildSource))) {
    for (const piece of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
      found.add(piece[1]);
    }
  }
  return [...found].sort();
}

function loadEntrypoints() {
  const esbuildPath = path.join(ROOT, "esbuild.mjs");
  if (!existsSync(esbuildPath)) {
    throw new Error(`missing ${esbuildPath}; run from the Tachyon checkout root`);
  }
  const list = extractEntrypoints(readFileSync(esbuildPath, "utf8"));
  if (list.length === 0) {
    throw new Error("no entryPoints found in esbuild.mjs");
  }
  return list;
}

function localBin(name) {
  const bin = path.join(ROOT, "node_modules", ".bin", name);
  return existsSync(bin) ? bin : null;
}

/**
 * Prefer worktree node_modules binaries so knip resolves *this* checkout's typescript.
 * Isolated npx knip breaks here (ts.getDefaultLibFilePath is not a function).
 *
 * Missing tools are installed together with --no-save so package.json stays product-clean.
 * Install knip + jscpd in one npm call — sequential --no-save can prune the previous extraneous bin.
 */
function ensureScanTools(needKnip, needJscpd) {
  const missing = [];
  if (needKnip && !localBin("knip")) missing.push(KNIP_PKG);
  if (needJscpd && !localBin("jscpd")) missing.push(JSCPD_PKG);
  // If only one is missing, re-state both so a prior extraneous tool is not pruned away.
  if (missing.length > 0 && missing.length < 2 && (needKnip || needJscpd)) {
    const both = [];
    if (needKnip) both.push(KNIP_PKG);
    if (needJscpd) both.push(JSCPD_PKG);
    missing.length = 0;
    missing.push(...both);
  }
  if (missing.length > 0) {
    process.stderr.write(
      `code-hygiene: installing ${missing.join(", ")} into node_modules (--no-save; not product deps)…\n`,
    );
    const install = spawnSync(
      "npm",
      ["install", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", ...missing],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if ((install.status ?? 1) !== 0) {
      throw new Error(
        `failed to install ${missing.join(", ")}: ${(install.stderr || install.stdout || "").slice(0, 500)}`,
      );
    }
  }
  const tools = {};
  if (needKnip) {
    tools.knip = localBin("knip");
    if (!tools.knip) throw new Error("knip binary missing after install");
  }
  if (needJscpd) {
    tools.jscpd = localBin("jscpd");
    if (!tools.jscpd) throw new Error("jscpd binary missing after install");
  }
  return tools;
}

function runBin(binPath, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const result = spawnSync(binPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function writeKnipConfig(configPath, entrypoints) {
  // Scope to product sources. scripts/ and test/ are CLI/test roots, not esbuild
  // entrypoints — including them floods the report with intentional "orphans".
  const config = {
    $schema: "https://unpkg.com/knip@5/schema.json",
    entry: entrypoints,
    project: ["src/**/*.{ts,tsx}"],
    ignore: [
      "dist/**",
      "node_modules/**",
      ".vscode-test/**",
      "media/**",
      "l10n/**",
      "docs/**",
      "scripts/**",
      "test/**",
    ],
    ignoreDependencies: ["vscode"],
    rules: {
      files: "error",
      exports: "error",
      types: "error",
      nsExports: "error",
      nsTypes: "error",
      duplicates: "error",
      enumMembers: "off",
      classMembers: "off",
      dependencies: "off",
      devDependencies: "off",
      optionalPeerDependencies: "off",
      unlisted: "off",
      binaries: "off",
      unresolved: "off",
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function runKnip(entrypoints, knipBin) {
  // Generated under gitignored .tachyon/; pass path relative to ROOT (cwd).
  mkdirSync(HYGIENE_DIR, { recursive: true });
  const configRel = path.join(".tachyon", "code-hygiene", "knip.json");
  const configPath = path.join(ROOT, configRel);
  writeKnipConfig(configPath, entrypoints);
  if (!existsSync(configPath)) {
    throw new Error(`knip config was not written: ${configPath}`);
  }
  const result = runBin(knipBin, [
    "--config",
    configRel,
    "--reporter",
    "json",
    "--no-progress",
    "--no-config-hints",
  ]);
  let json = null;
  try {
    const start = result.stdout.indexOf("{");
    const end = result.stdout.lastIndexOf("}");
    if (start >= 0 && end > start) {
      json = JSON.parse(result.stdout.slice(start, end + 1));
    }
  } catch {
    json = null;
  }
  return { ...result, json, configPath, bin: knipBin };
}

function summarizeKnip(json) {
  if (!json || typeof json !== "object") {
    return {
      ok: false,
      files: [],
      exports: [],
      note: "knip JSON unavailable — see raw log",
    };
  }
  const files = (json.files ?? []).map(String);
  const exports = [];

  if (Array.isArray(json.exports)) {
    for (const exp of json.exports) {
      exports.push({
        file: exp.file,
        name: exp.name ?? exp.symbol ?? String(exp),
        line: exp.line,
        kind: "value",
      });
    }
  }
  if (Array.isArray(json.types)) {
    for (const exp of json.types) {
      exports.push({
        file: exp.file,
        name: exp.name ?? exp.symbol ?? String(exp),
        line: exp.line,
        kind: "type",
      });
    }
  }
  // issues[] shape (some reporters)
  for (const f of json.issues ?? []) {
    if (!f || typeof f === "string") continue;
    for (const exp of f.exports ?? []) {
      exports.push({ file: f.file, name: exp.name ?? exp, line: exp.line, kind: "value" });
    }
    for (const exp of f.types ?? []) {
      exports.push({ file: f.file, name: exp.name ?? exp, line: exp.line, kind: "type" });
    }
  }

  return { ok: true, files, exports, note: null };
}

function runJscpd(jscpdBin) {
  const outDir = path.join(HYGIENE_DIR, "jscpd");
  mkdirSync(outDir, { recursive: true });
  const result = runBin(jscpdBin, [
    "src",
    "--min-lines",
    String(JSCPD_MIN_LINES),
    "--min-tokens",
    String(JSCPD_MIN_TOKENS),
    "--reporters",
    "json",
    "--output",
    outDir,
    "--silent",
    "--ignore",
    "**/node_modules/**,**/dist/**,**/*.test.ts,**/*.spec.ts",
  ]);
  const reportPath = path.join(outDir, "jscpd-report.json");
  let json = null;
  if (existsSync(reportPath)) {
    try {
      json = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      json = null;
    }
  }
  return { ...result, json, reportPath, bin: jscpdBin };
}

function summarizeJscpd(json) {
  if (!json || typeof json !== "object") {
    return {
      ok: false,
      clones: [],
      total: null,
      note: "jscpd JSON unavailable — see raw log",
    };
  }
  const duplicates = json.duplicates ?? [];
  const clones = duplicates.map((d) => ({
    format: d.format,
    lines: d.lines,
    tokens: d.tokens,
    first: d.firstFile
      ? `${d.firstFile.name}:${d.firstFile.startLoc?.line ?? "?"}-${d.firstFile.endLoc?.line ?? "?"}`
      : "?",
    second: d.secondFile
      ? `${d.secondFile.name}:${d.secondFile.startLoc?.line ?? "?"}-${d.secondFile.endLoc?.line ?? "?"}`
      : "?",
  }));
  return { ok: true, clones, total: json.statistics?.total ?? null, note: null };
}

function mdEscape(s) {
  return String(s ?? "").replace(/\|/g, "\\|");
}

function buildReport({
  meta,
  entrypoints,
  knipSummary,
  jscpdSummary,
  knipRaw,
  jscpdRaw,
  skipped,
}) {
  const lines = [];
  lines.push("# Code hygiene report");
  lines.push("");
  lines.push(
    "> Internal project scan only (scripts/code-hygiene). Candidates are **not** proof of dead code. Do not delete without string-ref / package.json / dynamic wiring review.",
  );
  lines.push("");
  lines.push("## Meta");
  lines.push("");
  lines.push(`- Generated: ${meta.generatedAt}`);
  lines.push(`- Commit: \`${meta.commit ?? "unknown"}\``);
  lines.push(`- Tree: \`${meta.treeSha ?? "unknown"}\`${meta.dirty ? " (dirty worktree)" : ""}`);
  lines.push(`- Root: \`${meta.root}\``);
  lines.push(`- Tools: ${KNIP_PKG}, ${JSCPD_PKG} (local node_modules; --no-save if auto-installed)`);
  lines.push(
    `- jscpd thresholds: min-lines=${JSCPD_MIN_LINES}, min-tokens=${JSCPD_MIN_TOKENS}`,
  );
  lines.push("");
  lines.push("## Entrypoints (from esbuild.mjs)");
  lines.push("");
  for (const e of entrypoints) lines.push(`- \`${e}\``);
  lines.push("");
  lines.push("## Unused / unreachable candidates (knip)");
  lines.push("");
  if (skipped.knip) {
    lines.push("_Skipped (`--skip-knip`)._");
    lines.push("");
  } else if (!knipSummary.ok) {
    lines.push(`_Failed:_ ${knipSummary.note}`);
    lines.push("");
    lines.push("```");
    lines.push((knipRaw || "").slice(0, 4000));
    lines.push("```");
    lines.push("");
  } else {
    lines.push(`- Orphan **files**: **${knipSummary.files.length}**`);
    lines.push(`- Unused **exports** (values + types): **${knipSummary.exports.length}**`);
    lines.push("");
    if (knipSummary.files.length) {
      lines.push("### Files");
      lines.push("");
      for (const f of knipSummary.files.slice(0, 100)) lines.push(`- \`${mdEscape(f)}\``);
      if (knipSummary.files.length > 100) {
        lines.push(`- … and ${knipSummary.files.length - 100} more`);
      }
      lines.push("");
    }
    if (knipSummary.exports.length) {
      lines.push("### Exports");
      lines.push("");
      lines.push("| File | Name | Line | Kind |");
      lines.push("| --- | --- | ---: | --- |");
      for (const exp of knipSummary.exports.slice(0, 200)) {
        lines.push(
          `| \`${mdEscape(exp.file)}\` | \`${mdEscape(exp.name)}\` | ${exp.line ?? ""} | ${exp.kind ?? "value"} |`,
        );
      }
      if (knipSummary.exports.length > 200) {
        lines.push("");
        lines.push(`_… and ${knipSummary.exports.length - 200} more exports_`);
      }
      lines.push("");
    }
    if (!knipSummary.files.length && !knipSummary.exports.length) {
      lines.push("_No file/export candidates._");
      lines.push("");
    }
  }
  lines.push("## Textual clones (jscpd)");
  lines.push("");
  if (skipped.jscpd) {
    lines.push("_Skipped (`--skip-jscpd`)._");
    lines.push("");
  } else if (!jscpdSummary.ok) {
    lines.push(`_Failed:_ ${jscpdSummary.note}`);
    lines.push("");
    lines.push("```");
    lines.push((jscpdRaw || "").slice(0, 4000));
    lines.push("```");
    lines.push("");
  } else {
    const t = jscpdSummary.total;
    if (t) {
      lines.push(
        `- Sources: ${t.sources ?? "?"}, lines: ${t.lines ?? "?"}, tokens: ${t.tokens ?? "?"}`,
      );
      lines.push(
        `- Clones: **${t.clones ?? jscpdSummary.clones.length}**, duplicated lines: **${t.duplicatedLines ?? "?"}** (${t.percentage ?? "?"}%)`,
      );
    } else {
      lines.push(`- Clones: **${jscpdSummary.clones.length}**`);
    }
    lines.push("");
    if (jscpdSummary.clones.length) {
      lines.push("| Lines | Tokens | A | B |");
      lines.push("| ---: | ---: | --- | --- |");
      const sorted = [...jscpdSummary.clones].sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0));
      for (const c of sorted.slice(0, 80)) {
        lines.push(
          `| ${c.lines ?? ""} | ${c.tokens ?? ""} | \`${mdEscape(c.first)}\` | \`${mdEscape(c.second)}\` |`,
        );
      }
      if (sorted.length > 80) {
        lines.push("");
        lines.push(`_… and ${sorted.length - 80} more clones_`);
      }
      lines.push("");
    } else {
      lines.push("_No clones above thresholds._");
      lines.push("");
    }
  }
  lines.push("## How to read this");
  lines.push("");
  lines.push("1. **knip file/export** = no static importer from esbuild entrypoints. Still check:");
  lines.push("   - `package.json` contributes / commands");
  lines.push("   - stringly routes, Bridge/MCP names, dynamic `import()` / `require`");
  lines.push("   - tests, preview harness, dogfood-only surfaces");
  lines.push("2. **jscpd clone** = textual similarity, not always shared abstraction debt.");
  lines.push("   Runtime adapters that intentionally parallel each other are often fine.");
  lines.push("3. This harness never deletes or rewrites product code.");
  lines.push("");
  lines.push("## Re-run");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run hygiene:scan");
  lines.push("# or");
  lines.push("node scripts/code-hygiene/scan.mjs --out .tachyon/code-hygiene/report.md");
  lines.push("```");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function printHelp() {
  console.log(`code-hygiene scan — internal Tachyon *repo* tool (not a product plugin)

Usage:
  node scripts/code-hygiene/scan.mjs [options]
  npm run hygiene:scan -- [options]

Options:
  --out <path>     Report path (default: .tachyon/code-hygiene/report.md)
  --skip-knip      Skip unused-export scan
  --skip-jscpd     Skip clone scan
  --exit-code      Exit 1 when either tool reports candidates (default: 0 if tools ran)
  -h, --help       This help

Advisory only. Not part of verify:full. Does not modify product source.`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!existsSync(path.join(ROOT, "package.json"))) {
    console.error("code-hygiene: run from the Tachyon checkout (package.json missing)");
    process.exit(2);
  }
  if (!existsSync(path.join(ROOT, "node_modules"))) {
    console.error("code-hygiene: node_modules missing — run npm ci first");
    process.exit(2);
  }

  const entrypoints = loadEntrypoints();
  const meta = {
    generatedAt: new Date().toISOString(),
    commit: git(["rev-parse", "HEAD"]),
    treeSha: git(["rev-parse", "HEAD^{tree}"]),
    dirty: Boolean(git(["status", "--porcelain", "--untracked-files=no"])),
    root: ROOT,
  };

  let knipResult = null;
  let jscpdResult = null;
  let knipSummary = { ok: false, files: [], exports: [], note: "not run" };
  let jscpdSummary = { ok: false, clones: [], total: null, note: "not run" };
  let toolFailed = false;

  let tools;
  try {
    tools = ensureScanTools(!args.skipKnip, !args.skipJscpd);
  } catch (err) {
    console.error(`code-hygiene: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }

  if (!args.skipKnip) {
    process.stderr.write("code-hygiene: running knip…\n");
    try {
      knipResult = runKnip(entrypoints, tools.knip);
      if (knipResult.error) {
        toolFailed = true;
        knipSummary = { ok: false, files: [], exports: [], note: String(knipResult.error) };
      } else {
        knipSummary = summarizeKnip(knipResult.json);
        if (!knipSummary.ok) {
          toolFailed = true;
          knipSummary.note =
            knipSummary.note ||
            `knip exit ${knipResult.status}; stderr: ${(knipResult.stderr || "").slice(0, 300)}`;
        }
      }
    } catch (err) {
      toolFailed = true;
      knipSummary = {
        ok: false,
        files: [],
        exports: [],
        note: err instanceof Error ? err.message : String(err),
      };
      knipResult = { stdout: "", stderr: knipSummary.note };
    }
  }

  if (!args.skipJscpd) {
    process.stderr.write("code-hygiene: running jscpd…\n");
    try {
      jscpdResult = runJscpd(tools.jscpd);
      if (jscpdResult.error) {
        toolFailed = true;
        jscpdSummary = { ok: false, clones: [], total: null, note: String(jscpdResult.error) };
      } else {
        jscpdSummary = summarizeJscpd(jscpdResult.json);
        if (!jscpdSummary.ok) toolFailed = true;
      }
    } catch (err) {
      toolFailed = true;
      jscpdSummary = {
        ok: false,
        clones: [],
        total: null,
        note: err instanceof Error ? err.message : String(err),
      };
      jscpdResult = { stdout: "", stderr: jscpdSummary.note };
    }
  }

  const report = buildReport({
    meta,
    entrypoints,
    knipSummary,
    jscpdSummary,
    knipRaw: knipResult ? `${knipResult.stdout}\n${knipResult.stderr}` : "",
    jscpdRaw: jscpdResult ? `${jscpdResult.stdout}\n${jscpdResult.stderr}` : "",
    skipped: { knip: args.skipKnip, jscpd: args.skipJscpd },
  });

  mkdirSync(path.dirname(args.out), { recursive: true });
  writeFileSync(args.out, report);

  const fileCount = knipSummary.files?.length ?? 0;
  const exportCount = knipSummary.exports?.length ?? 0;
  const cloneCount = jscpdSummary.clones?.length ?? 0;
  const status = toolFailed ? "failed" : "ok";

  console.log(`code-hygiene: status=${status}`);
  console.log(`  entrypoints: ${entrypoints.length}`);
  if (!args.skipKnip) console.log(`  knip files: ${fileCount}, exports: ${exportCount}`);
  if (!args.skipJscpd) console.log(`  jscpd clones: ${cloneCount}`);
  console.log(`  report: ${args.out}`);
  console.log("  note: candidates only — review before any deletion; not a product plugin");

  if (toolFailed) process.exit(2);
  if (args.exitCode && (fileCount > 0 || exportCount > 0 || cloneCount > 0)) {
    process.exit(1);
  }
  process.exit(0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`code-hygiene: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
}
