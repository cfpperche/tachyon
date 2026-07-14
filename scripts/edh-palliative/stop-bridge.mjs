#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CONTROL_FILE_BYTES = 32 * 1024;

function requireRealPath(candidate, kind) {
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error(`${kind} must not be a symlink`);
  return stat;
}

function requireOwnedDirectory(candidate, kind) {
  const stat = requireRealPath(candidate, kind);
  if (!stat.isDirectory()) throw new Error(`${kind} must be a directory`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${kind} must be owned by the current user`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${kind} must not be group/world writable`);
}

function readDescriptor(candidate) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(candidate, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("persistent Bridge descriptor must be a file");
    if (stat.size > MAX_CONTROL_FILE_BYTES) throw new Error("persistent Bridge descriptor is too large");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("persistent Bridge descriptor must be owned by the current user");
    if ((stat.mode & 0o022) !== 0) throw new Error("persistent Bridge descriptor must not be group/world writable");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function readOptionalPid(candidate) {
  let stat;
  try { stat = requireRealPath(candidate, "EDH pid file"); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.size > 32) throw new Error("EDH pid file is invalid");
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(candidate, flags);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > 32) throw new Error("EDH pid file is invalid");
    if (typeof process.getuid === "function" && opened.uid !== process.getuid()) throw new Error("EDH pid file must be owned by the current user");
    if ((opened.mode & 0o022) !== 0) throw new Error("EDH pid file must not be group/world writable");
    const raw = fs.readFileSync(fd, "utf8").trim();
    if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw new Error("EDH pid file is invalid");
    return Number(raw);
  } finally {
    fs.closeSync(fd);
  }
}

function processCommandLine(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); }
  catch { return undefined; }
}

function assertFixtureEdhStopped(fixture) {
  const pid = readOptionalPid(path.join(fixture, ".edh.pid"));
  if (!pid) return;
  try { process.kill(pid, 0); }
  catch (error) {
    if (error?.code === "ESRCH") return;
    throw new Error("cannot prove the fixture EDH process has stopped");
  }
  const expectedUserData = `--user-data-dir=${path.join(fixture, ".edh-user-data")}`;
  const argv = processCommandLine(pid);
  if (!argv) throw new Error("fixture EDH process is still alive or cannot be identified; close it before cleanup");
  if (argv.includes(expectedUserData)) throw new Error("fixture EDH is still running; close it before cleanup");
  // A stale pid file whose pid has been reused by an unrelated process is not ownership proof.
}

function isAbsent(error) {
  return error?.code === "ENOENT" || error?.code === "ECONNREFUSED";
}

function stopRequest(socketPath, workspaceHash, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = "";
    const timer = setTimeout(() => socket.destroy(new Error("persistent Bridge stop timed out")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ op: "stop", workspaceHash })}\n`));
    socket.on("data", (chunk) => {
      output += chunk;
      if (output.length > 32_768) socket.destroy(new Error("persistent Bridge stop response too large"));
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("end", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(output)); }
      catch { reject(new Error("invalid persistent Bridge stop response")); }
    });
  });
}

async function waitUntilAbsent(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { fs.lstatSync(socketPath); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("persistent Bridge control socket remained after stop");
}

export async function stopFixtureBridge(fixtureRoot, { timeoutMs = 2_000 } = {}) {
  const fixture = path.resolve(fixtureRoot);
  const workspace = path.join(fixture, "workspace");
  const serviceDir = path.join(workspace, ".tachyon", "bridge-service");
  const descriptorPath = path.join(serviceDir, "service.json");
  const socketPath = path.join(serviceDir, "control.sock");

  try {
    requireOwnedDirectory(fixture, "fixture");
    requireOwnedDirectory(workspace, "fixture workspace");
    assertFixtureEdhStopped(fixture);
    requireOwnedDirectory(serviceDir, "persistent Bridge service directory");
    if (!requireRealPath(descriptorPath, "persistent Bridge descriptor").isFile()) throw new Error("persistent Bridge descriptor must be a file");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    throw error;
  }

  const descriptor = readDescriptor(descriptorPath);
  const canonicalWorkspace = fs.realpathSync(workspace);
  if (
    descriptor?.protocol !== 1
    || !Number.isSafeInteger(descriptor?.pid)
    || descriptor.pid <= 0
    || descriptor?.workspaceRoot !== canonicalWorkspace
    || descriptor?.controlSocket !== socketPath
    || !/^[a-f0-9]{8}$/i.test(descriptor?.workspaceHash ?? "")
  ) {
    throw new Error("persistent Bridge descriptor does not match the fixture workspace");
  }

  try {
    const socketStat = requireRealPath(socketPath, "persistent Bridge control socket");
    if (!socketStat.isSocket()) throw new Error("persistent Bridge control path is not a socket");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    throw error;
  }

  let response;
  try { response = await stopRequest(socketPath, descriptor.workspaceHash, timeoutMs); }
  catch (error) { if (isAbsent(error)) return { state: "absent" }; throw error; }
  if (
    !response?.ok
    || response.descriptor?.workspaceHash !== descriptor.workspaceHash
    || response.descriptor?.workspaceRoot !== canonicalWorkspace
    || response.descriptor?.controlSocket !== socketPath
  ) {
    throw new Error("persistent Bridge refused fixture-scoped stop");
  }
  await waitUntilAbsent(socketPath, timeoutMs);
  return { state: "stopped" };
}

async function main() {
  const fixture = process.argv[2];
  if (!fixture) throw new Error("usage: stop-bridge.mjs <fixture-root>");
  const result = await stopFixtureBridge(fixture);
  process.stdout.write(`edh-palliative: persistent Bridge ${result.state}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`edh-palliative: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
