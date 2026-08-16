#!/usr/bin/env node
/**
 * Disposable TUI probe for t-620a0b.
 *
 * Question: does a Codex TUI session (the spawn shape Tachyon uses) leave a
 * readable channel that can close a turn window and detect plan events?
 *
 * Not a product reader. Writes only under the run dir + private CODEX_HOME.
 * Never touches src/, packages/, or test/.
 *
 * Usage:
 *   node scripts/research/poc-tui-canal-codex.mjs --turns induce
 *   node scripts/research/poc-tui-canal-codex.mjs --turns induce,trivial
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const REAL_AUTH = "/home/goat/.codex/auth.json";
const HUMAN_CODEX_HOME = "/home/goat/.codex";
const INVENTED = [
  "tachyonInventedTurnClose_ZZ9",
  "turn/checklist/updated",
  "TodosInvented",
  "ChecklistTelemetry",
];
const PROMPTS = {
  induce: [
    "This is a protocol measurement, not real work.",
    "You MUST call the update_plan tool with exactly three steps about making a cup of tea.",
    "Do not execute any step. Do not run commands. Do not write files.",
    "After update_plan succeeds, reply with only the word PLANNED.",
  ].join(" "),
  trivial: [
    "Reply with only the word PONG.",
    "Do not use any tools. Do not call update_plan. Do not write a plan.",
  ].join(" "),
};

const args = process.argv.slice(2);
const turnsArg = argValue(args, "--turns") ?? "induce";
const turnNames = turnsArg.split(",").map((s) => s.trim()).filter(Boolean);
for (const name of turnNames) {
  if (!PROMPTS[name]) {
    console.error(`unknown turn ${name}; known: ${Object.keys(PROMPTS).join(",")}`);
    process.exit(2);
  }
}

const runDir = join(tmpdir(), `poc-tui-canal-codex-${Date.now()}`);
const home = join(runDir, "codex-home");
const cwd = join(runDir, "cwd");
const tmuxTmpdir = join(runDir, "tmux");
const hooksPath = join(runDir, "hooks.jsonl");
const dumpHook = join(runDir, "dump-hook.cjs");
const launchSh = join(runDir, "launch.sh");
const summaryPath = join(runDir, "summary.json");
const paneLog = join(runDir, "pane.log");
mkdirSync(cwd, { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(tmuxTmpdir, { recursive: true, mode: 0o700 });
writeFileSync(join(cwd, "README"), "isolated cwd for t-620a0b TUI probe\n");

if (!existsSync(REAL_AUTH)) {
  console.error(`missing ${REAL_AUTH}`);
  process.exit(2);
}
symlinkSync(REAL_AUTH, join(home, "auth.json"));

writeFileSync(
  join(home, "config.toml"),
  [
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    `model = "gpt-5.6-sol"`,
    "",
    `[projects.${JSON.stringify(cwd)}]`,
    'trust_level = "trusted"',
    "",
  ].join("\n"),
);

writeFileSync(
  dumpHook,
  `// t-620a0b disposable hook stdin dump — not product code.
const fs = require("fs");
const event = process.argv[2] || "unknown";
const out = process.argv[3] || "";
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  if (!out) return;
  let parsed = null;
  let parseError = null;
  try { parsed = JSON.parse(raw || "{}"); } catch (e) { parseError = String(e && e.message || e); }
  const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [];
  const row = {
    ts: new Date().toISOString(),
    event,
    bytes: Buffer.byteLength(raw),
    keys,
    parsed,
    parseError,
    raw,
  };
  fs.appendFileSync(out, JSON.stringify(row) + "\\n");
});
`,
);

function hookOverride(eventName) {
  const cmd = `node ${shQuote(dumpHook)} ${eventName} ${shQuote(hooksPath)}`;
  return `hooks.${eventName}=[{hooks=[{type="command",command=${tomlString(cmd)}}]}]`;
}

const hookEvents = ["SessionStart", "Stop", "UserPromptSubmit", "PreToolUse", "PostToolUse"];
const hookFlags = hookEvents.flatMap((name) => ["-c", hookOverride(name)]);

const firstPrompt = PROMPTS[turnNames[0]];
const launchArgs = [
  "--dangerously-bypass-hook-trust",
  "-s",
  "read-only",
  "-a",
  "never",
  ...hookFlags,
  firstPrompt,
];

writeFileSync(
  launchSh,
  [
    "#!/bin/bash",
    "set -euo pipefail",
    `export CODEX_HOME=${shQuote(home)}`,
    `cd ${shQuote(cwd)}`,
    `exec codex ${launchArgs.map(shQuote).join(" ")}`,
    "",
  ].join("\n"),
  { mode: 0o755 },
);

const beforeHuman = fingerprintHome(HUMAN_CODEX_HOME);
const version = spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim();
const startedAt = new Date().toISOString();
const sessionName = "t620a0b-tui";
const tmuxEnv = {
  ...process.env,
  TMUX_TMPDIR: tmuxTmpdir,
  TMUX: undefined,
  TMUX_PANE: undefined,
  CODEX_HOME: home,
};

function tmux(argv, timeoutMs = 20_000) {
  const r = spawnSync("tmux", argv, { env: tmuxEnv, encoding: "utf8", timeout: timeoutMs });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

tmux(["kill-session", "-t", sessionName]);
const created = tmux(["new-session", "-d", "-s", sessionName, "-x", "140", "-y", "40", "-c", cwd, launchSh]);
if (created.status !== 0) {
  console.error("tmux new-session failed", created);
  process.exit(1);
}

const observations = [];
let stopCount = 0;
let lastPane = "";
const deadline = Date.now() + 180_000;
let readyAfterFirst = false;
let sentSecond = false;

try {
  while (Date.now() < deadline) {
    sleep(2000);
    const pane = tmux(["capture-pane", "-p", "-t", sessionName]).stdout;
    lastPane = pane;
    appendFileSync(paneLog, `\n----- ${new Date().toISOString()} -----\n${pane}\n`);
    const screen = classifyScreen(pane);
    const hooks = readJsonl(hooksPath);
    const stops = hooks.filter((h) => h.event === "Stop");
    const rollouts = listRollouts(home);
    const rolloutStats = rollouts.map(summarizeRollout);
    const row = {
      t: new Date().toISOString(),
      screen,
      hookEvents: hooks.map((h) => h.event),
      stopCount: stops.length,
      rolloutFiles: rollouts.length,
      rolloutStats,
    };
    observations.push(row);
    console.log(JSON.stringify({ tick: row.t, screen, stopCount: stops.length, hooks: row.hookEvents, rollouts: rollouts.length }));

    if (stops.length > stopCount) stopCount = stops.length;

    if (!readyAfterFirst && stops.length >= 1 && screen === "ready") {
      readyAfterFirst = true;
      if (turnNames[1] && !sentSecond) {
        const second = PROMPTS[turnNames[1]];
        console.log("sending second prompt after recognized ready screen");
        tmux(["send-keys", "-t", sessionName, "-l", second]);
        tmux(["send-keys", "-t", sessionName, "Enter"]);
        sentSecond = true;
        continue;
      }
      if (!turnNames[1]) break;
    }
    if (sentSecond && stops.length >= 2 && screen === "ready") break;
    if (/Sign in with ChatGPT/.test(pane) || /Missing bearer/.test(pane)) {
      console.error("auth failure on pane; aborting");
      break;
    }
  }
} finally {
  tmux(["kill-session", "-t", sessionName]);
  spawnSync("tmux", ["kill-server"], {
    env: tmuxEnv,
    timeout: 20_000,
    encoding: "utf8",
  });
}

const afterHuman = fingerprintHome(HUMAN_CODEX_HOME);
const inventory = walkInventory(home);
const hooks = readJsonl(hooksPath);
const rollouts = listRollouts(home).map((p) => ({ path: p, ...summarizeRollout(p), samples: sampleRollout(p) }));
const sqlite = inspectSqlite(home);
const inventedHits = searchInvented(home, INVENTED);
const hookKeyUnion = {};
for (const h of hooks) {
  hookKeyUnion[h.event] = Array.from(new Set([...(hookKeyUnion[h.event] ?? []), ...(h.keys ?? [])])).sort();
}

const summary = {
  task: "t-620a0b",
  measuredAt: startedAt,
  finishedAt: new Date().toISOString(),
  runtime: version,
  runDir,
  home,
  cwd,
  turnsRequested: turnNames,
  sentSecond,
  humanHomeUnchanged: JSON.stringify(beforeHuman) === JSON.stringify(afterHuman),
  humanHomeBefore: beforeHuman,
  humanHomeAfter: afterHuman,
  hookEventNamesConfigured: hookEvents,
  hookDumps: hooks.map((h) => ({
    ts: h.ts,
    event: h.event,
    bytes: h.bytes,
    keys: h.keys,
    parseError: h.parseError,
    parsed: redactHook(h.parsed),
  })),
  hookKeyUnion,
  rollouts,
  sqlite,
  inventory,
  inventedHits,
  lastScreen: classifyScreen(lastPane),
  lastPane: lastPane.slice(0, 4000),
  observations,
};

writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(runDir, "last-pane.txt"), lastPane);
console.log(JSON.stringify({
  summaryPath,
  version,
  stopDumps: hooks.filter((h) => h.event === "Stop").length,
  hookEventsSeen: hooks.map((h) => h.event),
  hookKeyUnion,
  rollouts: rollouts.map((r) => ({ file: r.path, types: r.types, payloadTypes: r.payloadTypes, toolNames: r.toolNames, turnIds: r.turnIds })),
  inventedHits,
  humanHomeUnchanged: summary.humanHomeUnchanged,
}, null, 2));

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function sleep(ms) {
  spawnSync("sleep", [String(ms / 1000)], { timeout: ms + 2000 });
}

function classifyScreen(pane) {
  if (/Do you trust the contents of this directory\?/.test(pane)) return "trust-prompt";
  if (/Sign in with ChatGPT/.test(pane)) return "sign-in";
  if (/OpenAI Codex \(v/.test(pane)) return "ready";
  if (/Hooks need review/.test(pane)) return "hooks-review";
  return "unknown";
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { parseError: "row", raw: line }; }
  });
}

function listRollouts(root) {
  const sessions = join(root, "sessions");
  if (!existsSync(sessions)) return [];
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(sessions);
  return out.sort();
}

function summarizeRollout(file) {
  const types = {};
  const payloadTypes = {};
  const toolNames = {};
  const turnIds = new Set();
  const flags = {
    task_started: 0,
    task_complete: 0,
    turn_aborted: 0,
    update_plan: 0,
    turn_plan_updated: 0,
    function_call: 0,
  };
  for (const rec of readJsonl(file)) {
    const t = rec.type ?? "?";
    types[t] = (types[t] ?? 0) + 1;
    const p = rec.payload && typeof rec.payload === "object" ? rec.payload : {};
    if (p.type) payloadTypes[p.type] = (payloadTypes[p.type] ?? 0) + 1;
    if (p.name) toolNames[p.name] = (toolNames[p.name] ?? 0) + 1;
    if (typeof p.turn_id === "string") turnIds.add(p.turn_id);
    if (p.type === "task_started") flags.task_started += 1;
    if (p.type === "task_complete") flags.task_complete += 1;
    if (p.type === "turn_aborted") flags.turn_aborted += 1;
    if (p.name === "update_plan" || p.name === "update_plan_notebook_uid") flags.update_plan += 1;
    if (t === "turn/plan/updated" || p.method === "turn/plan/updated") flags.turn_plan_updated += 1;
    if (p.type === "function_call") flags.function_call += 1;
  }
  return { types, payloadTypes, toolNames, turnIds: [...turnIds], flags, bytes: statSync(file).size };
}

function sampleRollout(file) {
  const samples = { session_meta: null, task_started: null, task_complete: null, turn_aborted: null, update_plan: null, turn_context: null };
  for (const rec of readJsonl(file)) {
    const p = rec.payload && typeof rec.payload === "object" ? rec.payload : {};
    if (rec.type === "session_meta" && !samples.session_meta) samples.session_meta = slim(rec);
    if (rec.type === "turn_context" && !samples.turn_context) samples.turn_context = slim(rec);
    if (p.type === "task_started" && !samples.task_started) samples.task_started = slim(rec);
    if (p.type === "task_complete" && !samples.task_complete) samples.task_complete = slim(rec);
    if (p.type === "turn_aborted" && !samples.turn_aborted) samples.turn_aborted = slim(rec);
    if ((p.name === "update_plan" || p.name === "update_plan_notebook_uid") && !samples.update_plan) {
      samples.update_plan = slim(rec);
    }
  }
  return samples;
}

function slim(rec) {
  const copy = JSON.parse(JSON.stringify(rec));
  const p = copy.payload;
  if (p && typeof p === "object") {
    for (const key of ["base_instructions", "developer_instructions", "text", "last_agent_message"]) {
      if (typeof p[key] === "string" && p[key].length > 400) p[key] = `${p[key].slice(0, 400)}…`;
    }
    if (p.collaboration_mode && p.collaboration_mode.settings && typeof p.collaboration_mode.settings.developer_instructions === "string") {
      p.collaboration_mode.settings.developer_instructions = `${p.collaboration_mode.settings.developer_instructions.slice(0, 200)}…`;
    }
  }
  return copy;
}

function redactHook(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;
  const out = { ...parsed };
  for (const key of ["last_assistant_message", "prompt", "transcript", "cwd"]) {
    if (typeof out[key] === "string" && out[key].length > 500) out[key] = `${out[key].slice(0, 500)}…`;
  }
  return out;
}

function walkInventory(root) {
  const files = [];
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else {
        files.push({
          rel: relative(root, full),
          bytes: st.size,
          mtime: st.mtime.toISOString(),
        });
      }
    }
  };
  walk(root);
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function inspectSqlite(root) {
  const names = ["logs_2.sqlite", "state_5.sqlite", "goals_1.sqlite", "memories_1.sqlite"];
  const out = {};
  for (const name of names) {
    const p = join(root, name);
    if (!existsSync(p)) {
      out[name] = { present: false };
      continue;
    }
    const script = `
import sqlite3, json, sys
con = sqlite3.connect(${JSON.stringify(`file:${p}?mode=ro`)}, uri=True)
cur = con.cursor()
tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")]
info = {"present": True, "tables": {}}
needles = ${JSON.stringify(INVENTED.concat(["turn/plan/updated", "update_plan", "task_complete", "turn/completed"]))}
for t in tables:
    cols = [c[1] for c in cur.execute(f"PRAGMA table_info({t})")]
    n = cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
    hits = {}
    for needle in needles:
        q = " OR ".join([f"CAST({c} AS TEXT) LIKE ?" for c in cols])
        if not q:
            continue
        try:
            hits[needle] = cur.execute(f"SELECT COUNT(*) FROM {t} WHERE {q}", [f"%{needle}%"] * len(cols)).fetchone()[0]
        except Exception as e:
            hits[needle] = f"err:{e}"
    sample = None
    if t == "logs" and n:
        bodies = [r[0] for r in cur.execute("SELECT feedback_log_body FROM logs WHERE feedback_log_body LIKE '%turn/%' OR feedback_log_body LIKE '%hook/%' OR feedback_log_body LIKE '%plan%' LIMIT 30")]
        sample = bodies
    info["tables"][t] = {"rows": n, "cols": cols, "needleHits": hits, "sample": sample}
print(json.dumps(info))
`;
    const r = spawnSync("python3", ["-c", script], { encoding: "utf8", timeout: 30_000 });
    try { out[name] = JSON.parse(r.stdout); }
    catch { out[name] = { present: true, error: r.stderr || r.stdout }; }
  }
  return out;
}

function searchInvented(root, needles) {
  const hits = Object.fromEntries(needles.map((n) => [n, []]));
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (st.size > 20_000_000) continue;
      let text;
      try { text = readFileSync(full, "utf8"); } catch { continue; }
      for (const needle of needles) {
        if (text.includes(needle)) hits[needle].push(relative(root, full));
      }
    }
  };
  walk(root);
  if (existsSync(hooksPath)) {
    const text = readFileSync(hooksPath, "utf8");
    for (const needle of needles) {
      if (text.includes(needle)) hits[needle].push(relative(runDir, hooksPath));
    }
  }
  return hits;
}

function fingerprintHome(root) {
  const files = ["config.toml", "auth.json"];
  const out = {};
  for (const name of files) {
    const p = join(root, name);
    try {
      const buf = readFileSync(p);
      out[name] = { bytes: buf.length, sha256_16: createHash("sha256").update(buf).digest("hex").slice(0, 16) };
    } catch {
      out[name] = { bytes: 0, sha256_16: "absent" };
    }
  }
  return out;
}
