/**
 * Per-runtime session-resume adapters (spec 209 / F29). Pure command/path builders —
 * no fs, no process; the disk-scanning id resolvers for capture runtimes live in
 * resolvers.ts, file IO in SessionLedger.ts, and the activation logic in Workspace.
 *
 * Two id strategies (see docs/specs/209-tachyon-agent-resume/notes.md, verified
 * against the live binaries 2026-06-11):
 *   - MINT: the CLI accepts a caller-supplied session id at spawn (claude/gemini
 *     `--session-id <uuid>`). We generate a UUID, inject it, persist it — robust to
 *     a crash before any output.
 *   - CAPTURE: the CLI mints its own id; we resolve it from disk/JSON later, keyed
 *     by cwd (codex/opencode/qwen/continue).
 * Resume is the SAME on-disk transcript replayed; we never re-deliver instructions
 * (the conversation already holds them) but DO re-pass the original flags.
 */

export type ResumeRuntime = "claude" | "codex" | "gemini" | "opencode" | "qwen" | "continue";

export interface ResumeAdapter {
  runtime: ResumeRuntime;
  /** True when we mint the session id at spawn (claude/gemini). */
  mintsId: boolean;
  /** Rewrite the raw spawn command (def.cmd) to pin a minted id. Identity for capture runtimes. */
  injectId(cmd: string, id: string): string;
  /** Build the resume command from the raw spawn command (def.cmd) — no instructions re-delivered. */
  resumeCommand(cmd: string, id: string): string;
  /**
   * Deterministic on-disk transcript path for (home, cwd, id), when derivable from
   * inputs alone — used for a cheap existence/retention check. Undefined when the
   * path needs a disk scan (then resume is attempt-and-fallback).
   */
  transcriptPath?(home: string, cwd: string, id: string): string;
}

const LAUNCHERS = new Set(["npx", "bunx", "pnpx", "env"]);

/** Index of the actual binary token, seeing through `env X=1`, `npx`, leading flags. */
function binaryIndex(tokens: string[]): number {
  for (let i = 0; i < tokens.length; i++) {
    const base = tokens[i].split("/").pop() ?? tokens[i];
    if (LAUNCHERS.has(base)) continue; // launcher (npx/bunx/env) — keep scanning
    if (base.includes("=") || base.startsWith("-")) continue; // env assignment / flag
    return i; // first real binary token
  }
  return 0;
}

/** Base name of the runtime binary in a command, or "" — mirrors inferKind's parsing. */
export function binaryOf(cmd: string): string {
  const tokens = cmd.trim().split(/\s+/);
  return (tokens[binaryIndex(tokens)] ?? "").split("/").pop() ?? "";
}

const RUNTIME_BY_BIN: Record<string, ResumeRuntime> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
  qwen: "qwen",
  cn: "continue",
  continue: "continue",
};

export function runtimeOf(cmd: string): ResumeRuntime | null {
  return RUNTIME_BY_BIN[binaryOf(cmd)] ?? null;
}

/** Append a flag-style argument to the end of a command (flag-style runtimes). */
function append(cmd: string, ...args: string[]): string {
  return `${cmd.trim()} ${args.join(" ")}`.trim();
}

/** Insert a subcommand right after the binary token (subcommand-style, e.g. codex). */
function afterBinary(cmd: string, ...inserted: string[]): string {
  const tokens = cmd.trim().split(/\s+/);
  const i = binaryIndex(tokens);
  return [...tokens.slice(0, i + 1), ...inserted, ...tokens.slice(i + 1)].join(" ");
}

/** abs cwd with `/` and `.` collapsed to `-` (Claude Code's project-dir encoding). */
export function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

const ADAPTERS: ResumeAdapter[] = [
  {
    runtime: "claude",
    mintsId: true,
    injectId: (cmd, id) => append(cmd, "--session-id", id),
    resumeCommand: (cmd, id) => append(cmd, "--resume", id),
    transcriptPath: (home, cwd, id) => `${home}/.claude/projects/${encodeClaudeCwd(cwd)}/${id}.jsonl`,
  },
  {
    runtime: "gemini",
    mintsId: true,
    injectId: (cmd, id) => append(cmd, "--session-id", id),
    resumeCommand: (cmd, id) => append(cmd, "--resume", id),
    // project_key is a friendly-name dir or a SHA — not derivable from inputs alone.
  },
  {
    runtime: "codex",
    mintsId: false,
    injectId: (cmd) => cmd,
    resumeCommand: (cmd, id) => afterBinary(cmd, "resume", id), // `codex resume <id>` (subcommand)
  },
  {
    runtime: "opencode",
    mintsId: false,
    injectId: (cmd) => cmd,
    resumeCommand: (cmd, id) => append(cmd, "-s", id), // `opencode -s <id>`
  },
  {
    runtime: "qwen",
    mintsId: false,
    injectId: (cmd) => cmd,
    resumeCommand: (cmd, id) => append(cmd, "--resume", id),
  },
  {
    runtime: "continue",
    mintsId: false,
    injectId: (cmd) => cmd,
    resumeCommand: (cmd, id) => append(cmd, "--resume", id),
  },
];

const BY_RUNTIME = new Map(ADAPTERS.map((a) => [a.runtime, a]));

export function adapterFor(cmd: string): ResumeAdapter | null {
  const rt = runtimeOf(cmd);
  return rt ? (BY_RUNTIME.get(rt) ?? null) : null;
}

export function adapterForRuntime(rt: ResumeRuntime): ResumeAdapter | undefined {
  return BY_RUNTIME.get(rt);
}
