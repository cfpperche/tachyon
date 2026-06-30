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
  /**
   * For a `mintsId` runtime, the minted id is a deterministic NAME (not a random uuid) that the
   * caller builds from the agent identity — claude `-n <name>` (spec 220). The real uuid is then
   * captured from disk by `customTitle` and the ledger upgrades to it (dup-proof resume-by-uuid).
   */
  nameMint?: boolean;
  /**
   * Resumable without a session id via a cwd-scoped "continue last" (qwen). The
   * activation path may then resume even when no id was minted/captured, since
   * Tachyon spawns one agent per workspace cwd.
   */
  resumesWithoutId?: boolean;
  /** Rewrite the raw spawn command (def.cmd) to pin a minted id. Identity for capture runtimes. */
  injectId(cmd: string, id: string): string;
  /** Build the resume command from the raw spawn command (def.cmd) — no instructions re-delivered. `id` may be "" for resumesWithoutId runtimes. */
  resumeCommand(cmd: string, id: string): string;
  /**
   * Deterministic on-disk transcript path for (configHome, cwd, id), when derivable from
   * inputs alone — used for a cheap existence/retention check. Undefined when the
   * path needs a disk scan (then resume is attempt-and-fallback).
   *
   * `configHome` is the dir that DIRECTLY contains the runtime's `projects/` tree — for claude that is
   * `~/.claude` normally, OR a redirected `CLAUDE_CONFIG_DIR` for a spec-226 isolated-harness agent
   * (whose transcripts live under `<CLAUDE_CONFIG_DIR>/projects/…`, not `~/.claude/projects/…`). The
   * caller passes the EFFECTIVE config home so a harness agent's transcript is found (H2).
   */
  transcriptPath?(configHome: string, cwd: string, id: string): string;
  /**
   * spec 225 — build the SPAWN command that FORKS a session: resume `sourceId`'s context into a NEW
   * session without mutating the original. Present ONLY for runtimes with a native fork primitive
   * (claude `--fork-session`); absent = NOT forkable (no lossy transcript-summary seed in v1). The
   * caller has already injected the fork's own `-n <fork-name>` via injectId, so this only appends the
   * resume+fork flags.
   */
  forkCommand?(cmd: string, sourceId: string): string;
  /**
   * spec 226 — isolated-harness support: how this runtime wires a per-agent config home + scoped MCP.
   * Present ONLY for runtimes that support it (v1: claude). Pure SHAPE — the fs materialization
   * (writing the home, symlinking auth, merging MCP) lives in HarnessManager. Gating mirrors
   * `forkCommand`/`forkable`: a `harness:` on a runtime without this is a config error.
   */
  harness?: {
    /** env var that redirects the whole config home (claude: CLAUDE_CONFIG_DIR). */
    configHomeEnv: string;
    /** auth files, relative to the home, symlinked from the real home so the agent stays logged in (H1). */
    authFiles: string[];
    /** transcripts dir under the (redirected) home — where resume must look once redirected (H2). */
    projectsSubdir: string;
    /** how MCP is scoped for an isolated harness. */
    mcp:
      | {
          mode: "flag";
          /** materialized config file under the home. */
          fileName: string;
          /** args that point the runtime at the materialized MCP config and forbid every other MCP source. */
          args(configPath: string): string[];
        }
      | {
          mode: "home-config";
          /** config file under the redirected home (codex: config.toml). */
          fileName: string;
        };
  };
}

/** spec 225 — a runtime can fork a session iff its adapter has a native fork primitive. */
export function forkable(adapter: ResumeAdapter | null | undefined): boolean {
  return !!adapter?.forkCommand;
}

/** spec 226 — a runtime supports an isolated harness iff its adapter declares the harness shape. */
export function harnessable(adapter: ResumeAdapter | null | undefined): boolean {
  return !!adapter?.harness;
}

const LAUNCHERS = new Set(["npx", "bunx", "pnpx", "env"]);

/** Index of the actual binary token, seeing through `env X=1`, `npx`, leading flags. */
export function binaryIndex(tokens: string[]): number {
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

/**
 * True when the user's command already manages its own session — it carries a
 * resume/continue/session-id flag. For a MINT runtime (claude/gemini) we must NOT
 * then layer our own `--session-id`/`--resume`: claude rejects `--session-id`
 * alongside `--resume`/`--continue` unless `--fork-session` is given (exit 1), and
 * a second `--resume` is malformed. Such a command is self-resuming, so we run it
 * verbatim and let it manage continuity. Token-exact match (won't catch `--resumex`).
 */
const SELF_SESSION_FLAGS = new Set(["--resume", "-r", "--continue", "-c", "--session-id", "--fork-session"]);
export function managesOwnSession(cmd: string): boolean {
  return cmd.trim().split(/\s+/).some((t) => SELF_SESSION_FLAGS.has(t));
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
    // spec 220: `--session-id <uuid>` no longer materializes a resumable transcript in claude
    // 2.1.177, so we spawn a NAMED session (`-n <name>`) — which DOES persist + carries the name as
    // the jsonl `customTitle` — then capture the real uuid and resume by it (dup-proof). The minted
    // `id` here is the deterministic name; resume's `id` is the captured uuid (or the name fallback).
    nameMint: true,
    // A self-resuming cmd (--resume/--continue/…) is run verbatim — injecting our own -n/--resume
    // would conflict (claude exits 1 on --session-id + --resume without --fork-session; a second
    // --resume is malformed). This keeps the user's `claude --resume evals` agents untouched.
    injectId: (cmd, id) => (managesOwnSession(cmd) ? cmd : append(cmd, "-n", id)),
    resumeCommand: (cmd, id) => (managesOwnSession(cmd) ? cmd : append(cmd, "--resume", id)),
    // configHome = `~/.claude` normally, or a redirected CLAUDE_CONFIG_DIR for a harness agent (H2).
    transcriptPath: (configHome, cwd, id) => `${configHome}/projects/${encodeClaudeCwd(cwd)}/${id}.jsonl`,
    // spec 225 — fork the source session into a NEW one (context carried, original untouched). Verified
    // live: `claude -n <fork-name> --resume <uuid> --fork-session` → a new named session. The caller
    // injects `-n <fork-name>` first; this appends the resume+fork flags.
    forkCommand: (cmd, sourceId) => append(cmd, "--resume", sourceId, "--fork-session"),
    // spec 226 — isolated harness. CLAUDE_CONFIG_DIR redirects the whole home (auth/settings/plugins/
    // transcripts); `--mcp-config <file> --strict-mcp-config` scopes MCP to ONLY the materialized file
    // (ignores project .mcp.json + global) — verified live: claude expands ${VAR} in that file from the
    // process env. Auth is seeded by symlinking .credentials.json; transcripts land in <home>/projects.
    harness: {
      configHomeEnv: "CLAUDE_CONFIG_DIR",
      authFiles: [".credentials.json"],
      projectsSubdir: "projects",
      mcp: {
        mode: "flag",
        fileName: "mcp.json",
        args: (p) => ["--mcp-config", p, "--strict-mcp-config"],
      },
    },
  },
  {
    runtime: "gemini",
    mintsId: true,
    injectId: (cmd, id) => (managesOwnSession(cmd) ? cmd : append(cmd, "--session-id", id)),
    resumeCommand: (cmd, id) => (managesOwnSession(cmd) ? cmd : append(cmd, "--resume", id)),
    // project_key is a friendly-name dir or a SHA — not derivable from inputs alone.
  },
  {
    runtime: "codex",
    mintsId: false,
    injectId: (cmd) => cmd,
    resumeCommand: (cmd, id) => afterBinary(cmd, "resume", id), // `codex resume <id>` (subcommand)
    harness: {
      configHomeEnv: "CODEX_HOME",
      authFiles: ["auth.json"],
      projectsSubdir: "sessions",
      mcp: {
        mode: "home-config",
        fileName: "config.toml",
      },
    },
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
    // No --session-id (QwenLM/qwen-code#2603) and sessions live in the cwd
    // (#1270), so resume the last session for this cwd via --continue; use the
    // precise --resume <id> only if an id was somehow captured.
    resumesWithoutId: true,
    injectId: (cmd) => cmd,
    resumeCommand: (cmd, id) => (id ? append(cmd, "--resume", id) : append(cmd, "--continue")),
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
