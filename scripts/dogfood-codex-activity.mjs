#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const test = spawnSync("npm", ["test", "--", "--run", "test/unit/activityLog.integration.test.ts", "-t", "spec 305"], {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (test.status !== 0) process.exit(test.status ?? 1);

const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
const found = [];
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/^rollout-.*\.jsonl$/.test(e.name)) found.push(p);
  }
}
walk(root);

let proof;
for (const file of found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)) {
  const types = new Set();
  let cwd = "";
  let id = "";
  let lines;
  try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(0, 200); } catch { continue; }
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.type === "session_meta") {
        cwd = rec.payload?.cwd || cwd;
        id = rec.payload?.id || rec.payload?.session_id || id;
      }
      if (rec.type) types.add(rec.type);
      if (rec.payload?.type) types.add(`${rec.type}:${rec.payload.type}`);
    } catch {
      // Skip partial/bad lines; this dogfood only needs one current, parseable rollout.
    }
  }
  if (types.has("response_item") && types.has("event_msg")) {
    proof = { file, id, cwd, types: [...types].sort() };
    break;
  }
}

if (!proof) {
  console.error(`[dogfood-codex-activity] no local Codex rollout with response_item+event_msg found under ${root}`);
  process.exit(1);
}

console.log("[dogfood-codex-activity] real Codex rollout schema proof:");
console.log(JSON.stringify(proof, null, 2));
