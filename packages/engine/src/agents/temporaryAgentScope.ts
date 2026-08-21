import crypto from "node:crypto";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TemporaryAgentScope =
  | { capability: "unavailable"; reason: string }
  | { capability: "available"; unit: string; invocationId: string; bootId: string };

function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

async function systemctl(args: string[], executable = "systemctl"): Promise<string> {
  const { stdout } = await execFileAsync(executable, ["--user", ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function currentBootId(): string {
  return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

export function temporaryAgentScopeUnitName(wsHash: string, agent: string): string {
  const workspace = wsHash.replace(/[^a-f0-9]/gi, "").slice(0, 8) || "workspace";
  const safeAgent = agent.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "agent";
  return `tachyon-agent-${workspace}-${safeAgent}-${crypto.randomBytes(4).toString("hex")}.scope`;
}

export async function temporaryAgentScopeSupport(
  platform = process.platform,
  systemctlExecutable = "systemctl",
): Promise<{ ok: true; bootId: string } | { ok: false; reason: string }> {
  if (platform !== "linux") return { ok: false, reason: `temporary agent process scopes require Linux (got ${platform})` };
  try {
    await systemctl(["show-environment"], systemctlExecutable);
    return { ok: true, bootId: currentBootId() };
  } catch (error) {
    return {
      ok: false,
      reason: `systemd --user unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function wrapTemporaryAgentScopeCommand(unit: string, command: string, memoryMax?: string): string {
  return [
    "systemd-run", "--user", "--scope", "--collect", "--quiet",
    `--unit=${quote(unit)}`,
    ...(memoryMax ? ["--property", `MemoryMax=${quote(memoryMax)}`] : []),
    "--", "/bin/sh", "-c", quote(command),
  ].join(" ");
}

export async function readTemporaryAgentScopeIdentity(
  unit: string,
  bootId: string,
  systemctlExecutable = "systemctl",
): Promise<TemporaryAgentScope> {
  const invocationId = await systemctl(["show", unit, "--property=InvocationID", "--value"], systemctlExecutable);
  if (!/^[a-f0-9]{32}$/i.test(invocationId)) throw new Error(`temporary agent scope '${unit}' has no stable InvocationID`);
  if (currentBootId() !== bootId) throw new Error(`temporary agent scope '${unit}' crossed a boot boundary before its identity was recorded`);
  return { capability: "available", unit, invocationId, bootId };
}

export async function closeTemporaryAgentScope(scope: TemporaryAgentScope, systemctlExecutable = "systemctl"): Promise<void> {
  if (scope.capability === "unavailable") return;
  if (process.platform !== "linux") {
    throw new Error(`temporary agent scope identity is unknown: '${scope.unit}' was created on Linux but this host is ${process.platform}`);
  }
  if (currentBootId() !== scope.bootId) {
    throw new Error(`temporary agent scope identity is unknown: boot ID drift for '${scope.unit}'`);
  }
  let invocationId: string;
  try {
    invocationId = await systemctl(["show", scope.unit, "--property=InvocationID", "--value"], systemctlExecutable);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|could not be found|no such/i.test(message)) return;
    throw new Error(`temporary agent scope identity is unknown: could not inspect '${scope.unit}': ${message}`);
  }
  if (!invocationId) return; // a collected unit has no membership left to kill
  if (invocationId !== scope.invocationId) {
    throw new Error(`temporary agent scope identity is unknown: InvocationID drift for '${scope.unit}'`);
  }
  await systemctl(["stop", scope.unit], systemctlExecutable);
}
