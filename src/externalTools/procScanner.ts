import fs from "node:fs";
import path from "node:path";
import type { ExternalToolInput } from "./registry.js";
import type { ExternalToolKind } from "./types.js";

export interface ProcEntry {
  pid: number;
  ppid: number;
  comm: string;
  cmdline: string[];
  environAgent?: string;
}

export interface ProcFs {
  readdirSync(dir: string): string[];
  readFileSync(file: string): Buffer | string;
}

export const GUI_PROCESS_ALLOWLIST = new Set([
  "chrome",
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "msedge",
  "msedge.exe",
  "microsoft-edge",
  "powershell.exe",
  "powershell",
  "pwsh",
  "cmd.exe",
  "wslview",
  "explorer.exe",
  "code",
  "code.exe",
]);

function basename(name: string): string {
  return name.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? name.toLowerCase();
}

export function externalKindForProcess(comm: string, cmdline: string[] = []): ExternalToolKind | undefined {
  const name = basename(comm || cmdline[0] || "");
  if (!GUI_PROCESS_ALLOWLIST.has(name)) return undefined;
  if (/chrome|chromium|edge/.test(name)) return "browser";
  if (name === "wslview" || name === "explorer.exe" || name === "cmd.exe" || name === "powershell.exe" || name === "powershell" || name === "pwsh") return "gui";
  if (name === "code" || name === "code.exe") return "desktop";
  return "gui";
}

function readText(proc: ProcFs, file: string): string {
  try {
    const data = proc.readFileSync(file);
    return Buffer.isBuffer(data) ? data.toString("utf8") : data;
  } catch {
    return "";
  }
}

function readNullList(proc: ProcFs, file: string): string[] {
  const text = readText(proc, file);
  return text.split("\0").filter(Boolean);
}

function readEnvironAgentFile(proc: ProcFs, file: string): string | undefined {
  return readNullList(proc, file).find((v) => v.startsWith("TACHYON_AGENT_NAME="))?.slice("TACHYON_AGENT_NAME=".length);
}

export function readProcEnvironAgent(pid: number, procRoot = "/proc", proc: ProcFs = fs): string | undefined {
  return readEnvironAgentFile(proc, path.join(procRoot, String(pid), "environ"));
}

export function readProcEntries(procRoot = "/proc", proc: ProcFs = fs): ProcEntry[] {
  let names: string[];
  try {
    names = proc.readdirSync(procRoot);
  } catch {
    return [];
  }
  const out: ProcEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const dir = path.join(procRoot, name);
    const stat = readText(proc, path.join(dir, "stat"));
    const m = stat.match(/^\d+\s+\((.*)\)\s+\S+\s+(\d+)/);
    const comm = readText(proc, path.join(dir, "comm")).trim() || m?.[1] || "";
    const ppid = m ? Number(m[2]) : Number.NaN;
    if (!Number.isFinite(ppid)) continue;
    out.push({
      pid,
      ppid,
      comm,
      cmdline: readNullList(proc, path.join(dir, "cmdline")),
    });
  }
  return out;
}

export interface ProcScanAgent {
  agent: string;
  panePid: number;
}

export function scanExternalToolProcesses(
  agents: ProcScanAgent[],
  entries: ProcEntry[],
  now = Date.now(),
  envAgentForPid?: (pid: number) => string | undefined,
): ExternalToolInput[] {
  const byPid = new Map(entries.map((e) => [e.pid, e]));
  const children = new Map<number, ProcEntry[]>();
  for (const entry of entries) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry);
    children.set(entry.ppid, list);
  }

  const found = new Map<string, ExternalToolInput>();
  for (const { agent, panePid } of agents) {
    const stack = [...(children.get(panePid) ?? [])];
    const seen = new Set<number>();
    while (stack.length) {
      const entry = stack.pop()!;
      if (seen.has(entry.pid)) continue;
      seen.add(entry.pid);
      stack.push(...(children.get(entry.pid) ?? []));
      const kind = externalKindForProcess(entry.comm, entry.cmdline);
      if (!kind) continue;
      const foundEnvAgent = entry.environAgent ?? envAgentForPid?.(entry.pid);
      const envAgent = foundEnvAgent && byPid.has(entry.pid) ? foundEnvAgent : undefined;
      const attributedAgent = envAgent || agent;
      if (envAgent && envAgent !== agent) continue;
      const confidence = envAgent === agent ? "medium" : "weak";
      const source = envAgent === agent ? "proc-env" : "proc-tree";
      const id = `ets-proc-${entry.pid}`;
      found.set(id, {
        id,
        agent: attributedAgent,
        kind,
        tool: basename(entry.comm || entry.cmdline[0] || "unknown"),
        source,
        confidence,
        startedAt: new Date(now).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        pid: entry.pid,
        state: "active",
      });
    }
  }
  return [...found.values()];
}

export function isPidAlive(pid: number, procRoot = "/proc"): boolean {
  return fs.existsSync(path.join(procRoot, String(pid)));
}
