#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  const currentPidFile = path.join(fixture, ".dev-host.pid");
  const legacyPidFile = path.join(fixture, ".edh.pid");
  const pid = readOptionalPid(currentPidFile) ?? readOptionalPid(legacyPidFile);
  if (!pid) return;
  try { process.kill(pid, 0); }
  catch (error) {
    if (error?.code === "ESRCH") return;
    throw new Error("cannot prove the fixture EDH process has stopped");
  }
  const expectedUserData = [
    `--user-data-dir=${path.join(fixture, ".dev-host-user-data")}`,
    `--user-data-dir=${path.join(fixture, ".edh-user-data")}`,
  ];
  const argv = processCommandLine(pid);
  if (!argv) throw new Error("fixture EDH process is still alive or cannot be identified; close it before cleanup");
  if (expectedUserData.some((argument) => argv.includes(argument))) throw new Error("fixture EDH is still running; close it before cleanup");
  // A stale pid file whose pid has been reused by an unrelated process is not ownership proof.
}

function defaultRunSystemctl(args) {
  const result = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function fixtureEngineUnitName(fixtureRoot) {
  const fixture = path.resolve(fixtureRoot);
  const workspace = path.join(fixture, "workspace");
  requireOwnedDirectory(fixture, "fixture");
  requireOwnedDirectory(workspace, "fixture workspace");
  const canonicalWorkspace = fs.realpathSync(workspace);
  const key = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 32);
  return `tachyon-engine-${key}.service`;
}

export async function stopFixtureEngine(
  fixtureRoot,
  { timeoutMs = 2_000, pollMs = 25, runSystemctl = defaultRunSystemctl } = {},
) {
  const fixture = path.resolve(fixtureRoot);
  let unitName;
  try {
    unitName = fixtureEngineUnitName(fixture);
    assertFixtureEdhStopped(fixture);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    throw error;
  }

  const initial = await runSystemctl(["is-active", unitName]);
  const initialState = initial.stdout.trim();
  if (initial.status !== 0 && initial.status !== 3 && initial.status !== 4) {
    throw new Error(`cannot inspect fixture engine unit ${unitName}: ${initial.stderr.trim() || initialState || `exit ${initial.status}`}`);
  }
  if (initial.status !== 0) return { state: "absent", unitName };

  const stopped = await runSystemctl(["stop", unitName]);
  if (stopped.status !== 0) {
    throw new Error(`failed to stop fixture engine unit ${unitName}: ${stopped.stderr.trim() || stopped.stdout.trim() || `exit ${stopped.status}`}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await runSystemctl(["is-active", unitName]);
    if (probe.status === 3 || probe.status === 4) return { state: "stopped", unitName };
    if (probe.status !== 0) {
      throw new Error(`cannot confirm fixture engine stop for ${unitName}: ${probe.stderr.trim() || probe.stdout.trim() || `exit ${probe.status}`}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`fixture engine unit ${unitName} remained active after stop`);
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
  const engine = await stopFixtureEngine(fixture);
  const bridge = await stopFixtureBridge(fixture);
  process.stdout.write(`dev-host: persistent engine ${engine.state}; persistent Bridge ${bridge.state}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`dev-host: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
