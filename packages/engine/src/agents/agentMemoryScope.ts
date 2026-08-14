/**
 * t-0d0152 — opt-in whole-tree MemoryMax for ordinary agent spawns via systemd --user scope.
 *
 * Only wraps the pane command when settings.agentMemoryMax / tachyon.agentMemoryMax is set.
 * Fail-open when Linux/user-systemd is unavailable: callers skip the wrap.
 */

/** POSIX single-quote escaping for arguments embedded in a shell command line. */
export function posixShellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** systemd MemoryMax: plain bytes, K/M/G/T, or percent (e.g. 2G, 512M, 50%). */
const MEMORY_MAX_RE = /^(?:\d+%$|\d+[KMGT]?)$/i;

export function parseAgentMemoryMax(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") return raw ? undefined : undefined;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    return String(Math.floor(raw));
  }
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s || s === "0" || /^off$/i.test(s) || /^false$/i.test(s) || /^none$/i.test(s)) return undefined;
  if (!MEMORY_MAX_RE.test(s)) return undefined;
  return s.toUpperCase().endsWith("%") ? s : s.replace(/([kmgt])$/i, (_, u: string) => u.toUpperCase());
}

/** Stable, systemd-safe unit name (no raw secrets). */
export function agentMemoryScopeUnitName(wsHash: string, agentName: string, nonceHex: string): string {
  const ws = (wsHash || "ws").replace(/[^a-f0-9]/gi, "").slice(0, 8) || "ws";
  const agent = (agentName || "agent").replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "agent";
  const nonce = (nonceHex || "x").replace(/[^a-f0-9]/gi, "").slice(0, 8) || "x";
  return `tachyon-mem-${ws}-${agent}-${nonce}.scope`;
}

/**
 * Wrap `command` in `systemd-run --user --scope` with MemoryMax.
 * Command is passed as a single sh -c payload.
 */
export function wrapAgentMemoryScopeCommand(unitName: string, memoryMax: string, command: string): string {
  const max = parseAgentMemoryMax(memoryMax);
  if (!max) throw new Error(`invalid agent MemoryMax: ${memoryMax}`);
  return [
    "systemd-run",
    "--user",
    "--scope",
    "--collect",
    `--unit=${posixShellQuote(unitName)}`,
    `-p`,
    `MemoryMax=${max}`,
    "--",
    "/bin/sh",
    "-c",
    posixShellQuote(command),
  ].join(" ");
}

export type AgentMemoryScopeSupport =
  | { ok: true }
  | { ok: false; reason: string };

/** Cheap static gate — does not prove MemoryMax enforcement, only that wrapping is plausible. */
export function agentMemoryScopeSupport(platform = process.platform): AgentMemoryScopeSupport {
  if (platform !== "linux") return { ok: false, reason: `agent MemoryMax scopes require Linux (got ${platform})` };
  return { ok: true };
}
