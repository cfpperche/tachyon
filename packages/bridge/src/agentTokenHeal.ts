/**
 * Heal Bridge per-agent tokens from live process environments.
 *
 * Dogfood failure mode: agent still holds TACHYON_AGENT_BRIDGE_TOKEN in env, but the
 * digest-only registry no longer recognizes it (`token_unknown`) after remint/sweep/
 * registry reload edges. Reading the plaintext from /proc of a managed agent pane and
 * {@link CallerIdentityRegistry.adopt}ing it restores MCP without a restart.
 *
 * Security: the bearer must be reachable inside the process tree of a MANAGED agent pane, and the
 * adopted identity is that pane's roster name — never TACHYON_AGENT_NAME read from the scanned
 * process. A process outside every managed pane heals nothing, whatever env it carries (t-2a7d24).
 */

import fs from "node:fs";
import path from "node:path";
import type { CallerIdentityRegistry, CallerScope } from "./callerIdentity.js";
import { AGENT_TOKEN_ENV_VAR } from "./token.js";

export type ProcFs = {
  readdirSync(dir: string): string[];
  readFileSync(file: string): Buffer | string;
  existsSync?(file: string): boolean;
};

function readNullList(proc: ProcFs, file: string): string[] {
  try {
    const data = proc.readFileSync(file);
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
    return text.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/** Read a single env var from `/proc/<pid>/environ` (best-effort; may fail on permission). */
export function readProcEnvVar(
  pid: number,
  key: string,
  procRoot = "/proc",
  proc: ProcFs = fs,
): string | undefined {
  const lines = readNullList(proc, path.join(procRoot, String(pid), "environ"));
  const prefix = `${key}=`;
  for (const line of lines) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return undefined;
}

/**
 * Walk the process tree under `rootPid` (breadth-first) looking for TACHYON_AGENT_BRIDGE_TOKEN.
 * Prefer a process whose TACHYON_AGENT_NAME matches `agentName` when provided.
 */
export function findAgentBridgeTokenInTree(
  rootPid: number,
  opts?: {
    agentName?: string;
    procRoot?: string;
    proc?: ProcFs;
    maxNodes?: number;
  },
): string | undefined {
  const procRoot = opts?.procRoot ?? "/proc";
  const proc = opts?.proc ?? fs;
  const maxNodes = opts?.maxNodes ?? 64;
  const wantName = opts?.agentName;

  const queue = [rootPid];
  const seen = new Set<number>();
  let fallback: string | undefined;

  while (queue.length && seen.size < maxNodes) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);

    const token = readProcEnvVar(pid, AGENT_TOKEN_ENV_VAR, procRoot, proc);
    const envName = readProcEnvVar(pid, "TACHYON_AGENT_NAME", procRoot, proc);
    if (token && /^[0-9a-f]{64}$/i.test(token)) {
      if (wantName && envName === wantName) return token;
      if (!fallback) fallback = token;
    }

    // children via /proc scan of ppid would be expensive; use task children list when available
    try {
      const taskDir = path.join(procRoot, String(pid), "task");
      // Fall back: readdir /proc and match ppid from stat — too heavy; use children from cmdline tree
      void taskDir;
    } catch {
      /* ignore */
    }
  }

  // Second pass: scan /proc for processes with ppid in our seen set (one hop expansion loop).
  // Limited depth expansion by repeated parent scans.
  try {
    const names = proc.readdirSync(procRoot);
    const byPpid = new Map<number, number[]>();
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      try {
        const stat = proc.readFileSync(path.join(procRoot, name, "stat"));
        const text = Buffer.isBuffer(stat) ? stat.toString("utf8") : stat;
        const m = text.match(/^\d+\s+\(.*\)\s+\S+\s+(\d+)/);
        if (!m) continue;
        const ppid = Number(m[1]);
        const list = byPpid.get(ppid) ?? [];
        list.push(pid);
        byPpid.set(ppid, list);
      } catch {
        /* skip */
      }
    }
    const expand = [rootPid];
    const visited = new Set<number>();
    while (expand.length && visited.size < maxNodes) {
      const pid = expand.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);
      const token = readProcEnvVar(pid, AGENT_TOKEN_ENV_VAR, procRoot, proc);
      const envName = readProcEnvVar(pid, "TACHYON_AGENT_NAME", procRoot, proc);
      if (token && /^[0-9a-f]{64}$/i.test(token)) {
        if (wantName && envName === wantName) return token;
        if (!fallback) fallback = token;
      }
      for (const child of byPpid.get(pid) ?? []) expand.push(child);
    }
  } catch {
    /* /proc unavailable */
  }

  return fallback;
}

export type HealFromBearerResult =
  | { ok: true; name: string; adopted: boolean }
  | { ok: false; reason: "no_match" };

/**
 * Name the managed agent whose pane process tree holds this bearer as TACHYON_AGENT_BRIDGE_TOKEN.
 *
 * The search is confined to the given pane roots and the answer is the ROSTER name (`agent.name`),
 * so a bearer presented by a process outside every managed pane matches nothing — there is no
 * fallback that would read an identity out of an arbitrary pid's env (t-2a7d24).
 */
export function findAgentNameForBridgeToken(
  bearer: string,
  opts: {
    agents: ReadonlyArray<{ name: string; panePid: number }>;
    procRoot?: string;
    proc?: ProcFs;
  },
): string | undefined {
  const trimmed = bearer.trim();
  if (!trimmed || !/^[0-9a-f]{64}$/i.test(trimmed)) return undefined;
  const procRoot = opts.procRoot ?? "/proc";
  const proc = opts.proc ?? fs;

  for (const agent of opts.agents) {
    const token = findAgentBridgeTokenInTree(agent.panePid, {
      agentName: agent.name,
      procRoot,
      proc,
    });
    if (token === trimmed) return agent.name;
  }
  return undefined;
}

/**
 * If `bearer` is held inside the pane tree of one of these managed `agents`, adopt it into the
 * registry under that agent's roster name. Anything else is `no_match`.
 */
export function healUnknownBearerFromAgents(
  registry: CallerIdentityRegistry,
  bearer: string,
  agents: ReadonlyArray<{ name: string; panePid: number }>,
  scope: CallerScope,
  opts?: { procRoot?: string; proc?: ProcFs },
): HealFromBearerResult {
  const name = findAgentNameForBridgeToken(bearer, {
    agents,
    procRoot: opts?.procRoot,
    proc: opts?.proc,
  });
  if (!name) return { ok: false, reason: "no_match" };
  const result = registry.adopt(name, bearer.trim(), scope);
  if (result === "invalid") return { ok: false, reason: "no_match" };
  return { ok: true, name, adopted: result === "adopted" };
}
