#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [, , command = "help", ...args] = process.argv;
const base = path.resolve(process.env.TACHYON_EDH_LANE_BASE || path.join(os.tmpdir(), "tachyon-edh-lane-v1"));
const leaseDir = path.join(base, "owner.lease");
const leaseFile = path.join(leaseDir, "lease.json");
const targets = new Set(["worktree", "main", "vsix"]);

function fail(message, code = 1) { console.error(`edh-lane: ${message}`); process.exit(code); }
function value(flag, fallback) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; }
function owner() { return value("--owner", process.env.TACHYON_AGENT_NAME || "").trim(); }
function readLease() { try { return JSON.parse(fs.readFileSync(leaseFile, "utf8")); } catch { return null; } }
function bounded(text, limit = 240) { return String(text ?? "").replace(/[\r\n\x00-\x1f]+/g, " ").slice(0, limit); }

function acquire() {
  const who = owner();
  const target = value("--target", "worktree");
  if (!who) fail("--owner is required");
  if (!targets.has(target)) fail("--target must be worktree, main, or vsix", 2);
  fs.mkdirSync(base, { recursive: true });
  try { fs.mkdirSync(leaseDir); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const held = readLease();
    fail(`lane busy: owner=${bounded(held?.owner, 80) || "unknown"} target=${bounded(held?.target, 20) || "unknown"}`);
  }
  const lease = { version: 1, owner: bounded(who, 80), target, pid: process.pid, acquiredAt: new Date().toISOString() };
  fs.writeFileSync(leaseFile, `${JSON.stringify(lease, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(lease));
}

function release() {
  const who = owner();
  const held = readLease();
  if (!held) { console.log("edh-lane: no lease"); return; }
  if (!who || held.owner !== who) fail(`lease owned by ${bounded(held.owner, 80)}; matching --owner required`);
  fs.rmSync(leaseDir, { recursive: true, force: false });
  console.log(`edh-lane: released ${who}`);
}

function status() {
  const held = readLease();
  console.log(JSON.stringify({ version: 1, base, held: !!held, lease: held && { owner: bounded(held.owner, 80), target: held.target, acquiredAt: held.acquiredAt } }, null, 2));
}

function run() {
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) fail("run requires -- <command>", 2);
  acquire();
  const who = owner();
  const target = value("--target", "worktree");
  const evidenceRoot = path.resolve(process.env.TACHYON_EDH_EVIDENCE || path.join(base, "evidence"));
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = spawnSync(args[separator + 1], args.slice(separator + 2), { stdio: "inherit", env: process.env });
  } finally {
    const report = { version: 1, owner: bounded(who, 80), target, startedAt, finishedAt: new Date().toISOString(), exitCode: result?.status ?? 1, signal: bounded(result?.signal, 24) || null };
    const file = path.join(evidenceRoot, "latest.json");
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    release();
    console.log(`edh-lane: evidence ${file}`);
  }
  process.exit(result?.status ?? 1);
}

switch (command) {
  case "acquire": acquire(); break;
  case "release": release(); break;
  case "status": status(); break;
  case "run": run(); break;
  default: console.log("usage: lane.mjs acquire|release|status|run --owner NAME --target worktree|main|vsix [-- COMMAND ...]");
}
