#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const [, , command = "help", ...args] = process.argv;
const separator = args.indexOf("--");
const laneArgs = args.slice(0, separator < 0 ? args.length : separator);
function privateRuntimeBase() {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) {
    try {
      const stat = fs.lstatSync(runtime);
      const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
      if (stat.isDirectory() && !stat.isSymbolicLink() && owned && (stat.mode & 0o077) === 0) {
        return path.join(runtime, "tachyon-edh-lane-v1");
      }
    } catch { /* fall back to the user's stable home runtime directory */ }
  }
  return path.join(os.homedir(), ".tachyon", "runtime", "edh-lane-v1");
}

const base = path.resolve(process.env.TACHYON_EDH_LANE_BASE || privateRuntimeBase());
const leaseDir = path.join(base, "owner.lease");
const leaseFile = path.join(leaseDir, "lease.json");
const targets = new Set(["worktree", "main", "vsix"]);

function fail(message, code = 1) { console.error(`edh-lane: ${message}`); process.exit(code); }
function value(flag, fallback) { const i = laneArgs.indexOf(flag); return i >= 0 ? laneArgs[i + 1] : fallback; }
function owner() {
  const who = value("--owner", process.env.TACHYON_AGENT_NAME || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(who)) fail("--owner must be 1-80 ASCII letters, digits, dots, underscores, or hyphens", 2);
  return who;
}
function directoryState(dir, label) {
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a real directory (symlinks refused)`);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
function ensureDirectory(dir, label, options = {}) {
  if (!directoryState(dir, label)) fs.mkdirSync(dir, { ...options, mode: 0o700 });
  directoryState(dir, label);
}
function validateBase(create = false) {
  if (create) ensureDirectory(base, "lane base", { recursive: true });
  else directoryState(base, "lane base");
}
function readLease() {
  validateBase();
  if (!directoryState(leaseDir, "lease")) return null;
  try {
    const stat = fs.lstatSync(leaseFile);
    if (stat.isSymbolicLink() || !stat.isFile()) fail("lease.json must be a real file (symlinks refused)");
    return JSON.parse(fs.readFileSync(leaseFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
function bounded(text, limit = 240) { return String(text ?? "").replace(/[\r\n\x00-\x1f]+/g, " ").slice(0, limit); }
function writeJson(file, value, kind, options) {
  if (process.env.TACHYON_EDH_TEST_FAIL_WRITE === kind) throw new Error(`injected ${kind} write failure`);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, options);
}
function publishEvidence(dir, report) {
  const file = path.join(dir, "latest.json");
  const temporary = path.join(dir, `.latest.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    writeJson(temporary, report, "evidence", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
  return file;
}

function acquire() {
  const who = owner();
  const target = value("--target", "worktree");
  if (!targets.has(target)) fail("--target must be worktree, main, or vsix", 2);
  validateBase(true);
  try { fs.mkdirSync(leaseDir); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    directoryState(leaseDir, "lease");
    const held = readLease();
    fail(`lane busy: owner=${bounded(held?.owner, 80) || "unknown"} target=${bounded(held?.target, 20) || "unknown"}`);
  }
  const lease = { version: 1, owner: bounded(who, 80), target, pid: process.pid, acquiredAt: new Date().toISOString() };
  try {
    writeJson(leaseFile, lease, "lease", { flag: "wx" });
  } catch (error) {
    try { fs.rmdirSync(leaseDir); } catch (cleanupError) {
      if (cleanupError?.code !== "ENOTEMPTY" && cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
  console.log(JSON.stringify(lease));
}

function release() {
  const who = owner();
  const held = readLease();
  if (!held) { console.log("edh-lane: no lease"); return; }
  if (held.owner !== who) fail(`lease owned by ${bounded(held.owner, 80)}; matching --owner required`);
  fs.rmSync(leaseDir, { recursive: true, force: false });
  console.log(`edh-lane: released ${who}`);
}

function status() {
  const held = readLease();
  console.log(JSON.stringify({ version: 1, base, held: !!held, lease: held && { owner: bounded(held.owner, 80), target: held.target, acquiredAt: held.acquiredAt } }, null, 2));
}

function recover() {
  validateBase();
  if (!directoryState(leaseDir, "lease")) { console.log("edh-lane: no orphan lease"); return; }
  try {
    fs.rmdirSync(leaseDir);
  } catch (error) {
    if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") fail("lease recovery refused: lease directory is not empty");
    throw error;
  }
  console.log("edh-lane: recovered empty orphan lease");
}

function run() {
  if (separator < 0 || separator === args.length - 1) fail("run requires -- <command>", 2);
  validateBase(true);
  const evidenceRoot = path.resolve(process.env.TACHYON_EDH_EVIDENCE || path.join(base, "evidence"));
  ensureDirectory(evidenceRoot, "evidence", { recursive: true });
  acquire();
  const who = owner();
  const target = value("--target", "worktree");
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = spawnSync(args[separator + 1], args.slice(separator + 2), { stdio: "inherit", env: process.env });
  } finally {
    try {
      const report = { version: 1, owner: who, target, startedAt, finishedAt: new Date().toISOString(), exitCode: result?.status ?? 1, signal: bounded(result?.signal, 24) || null };
      const file = publishEvidence(evidenceRoot, report);
      console.log(`edh-lane: evidence ${file}`);
    } finally {
      release();
    }
  }
  process.exit(result?.status ?? 1);
}

switch (command) {
  case "acquire": acquire(); break;
  case "release": release(); break;
  case "status": status(); break;
  case "recover": recover(); break;
  case "run": run(); break;
  default: console.log("usage: lane.mjs acquire|release|status|recover|run --owner NAME --target worktree|main|vsix [-- COMMAND ...]");
}
