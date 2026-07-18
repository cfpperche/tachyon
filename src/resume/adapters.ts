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
 *     by cwd (codex/antigravity/opencode/qwen/continue).
 * Resume is the SAME on-disk transcript replayed; we never re-deliver instructions
 * (the conversation already holds them) but DO re-pass the original flags.
 */

export type ResumeRuntime = "claude" | "codex" | "gemini" | "antigravity" | "opencode" | "qwen" | "continue" | "grok" | "hermes" | "pi";

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
   * Present ONLY for runtimes that support it (v1: claude/codex; spec t-e2ebe3: opencode). Pure SHAPE —
   * the fs materialization (writing the home, symlinking/copying auth, merging MCP) lives in
   * HarnessManager. Gating mirrors `forkCommand`/`forkable`: a `harness:` on a runtime without this is
   * a config error.
   */
  harness?: {
    /** env var that redirects the whole config home (claude: CLAUDE_CONFIG_DIR, codex: CODEX_HOME,
     *  opencode: XDG_CONFIG_HOME — see `xdg` for opencode's data/state vars). */
    configHomeEnv: string;
    /** auth files. Normally relative to the home (claude/codex: symlinked from the real home, H1). For an
     *  `xdg` layout they are relative to the redirected XDG_DATA_HOME (opencode: COPY, mode 600 — never a
     *  symlink, because opencode refreshes its token in-place and a shared symlink would race the real
     *  home on multi-agent runs). */
    authFiles: string[];
    /** transcripts dir under the (redirected) home — where resume must look once redirected (H2). For an
     *  `xdg` layout it is relative to the redirected XDG_DATA_HOME. */
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
          /** config file under the redirected home (codex: config.toml; opencode: opencode/opencode.json). For
           *  an `xdg` layout the path is relative to the redirected XDG_CONFIG_HOME, not the home root. */
          fileName: string;
        };
    /** spec t-e2ebe3 — opencode is XDG-compliant (verified 1.17.15): redirecting
     *  XDG_CONFIG/DATA/STATE_HOME to per-agent subdirs under the home isolates config, auth (mode-600 copy),
     *  and state with NO `OPENCODE_CONFIG` (opencode auto-discovers its config under XDG_CONFIG_HOME). When
     *  present, HarnessManager lays out three subdirs (`configRel`/`dataRel`/`stateRel`) under the home,
     *  injects all three XDG env vars, seeds auth under `<dataRel>/<authFile>` (copy + chmod 600), and
     *  writes the mcp config under `<configRel>/<fileName>`. */
    xdg?: {
      dataEnv: string;
      stateEnv: string;
      configRel: string;
      dataRel: string;
      stateRel: string;
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
/** GNU env options whose operand is a separate token, not the wrapped runtime binary. */
const ENV_OPERAND_FLAGS = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);

/** Index of the actual binary token, seeing through `env X=1`, `npx`, leading flags. */
export function binaryIndex(tokens: string[]): number {
  for (let i = 0; i < tokens.length; i++) {
    const base = tokens[i].split("/").pop() ?? tokens[i];
    if (LAUNCHERS.has(base)) continue; // launcher (npx/bunx/env) — keep scanning
    if (ENV_OPERAND_FLAGS.has(base)) { i++; continue; } // env option + operand
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
  agy: "antigravity",
  opencode: "opencode",
  qwen: "qwen",
  cn: "continue",
  continue: "continue",
  grok: "grok",
  hermes: "hermes",
  pi: "pi",
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
const SELF_SESSION_FLAGS = new Set(["--resume", "-r", "--continue", "-c", "--session-id", "-s", "--session", "--fork-session"]);
export function managesOwnSession(cmd: string): boolean {
  const tokens = cmd.trim().split(/\s+/);
  const binary = (tokens[binaryIndex(tokens)] ?? "").split("/").pop() ?? "";
  if (binary === "pi") {
    const piSessionFlags = new Set([
      "--session", "--session-id", "--session-dir", "--continue", "-c", "--resume", "-r", "--fork", "--no-session",
    ]);
    return tokens.some((token) => piSessionFlags.has(token) || [...piSessionFlags].some((flag) => token.startsWith(`${flag}=`)));
  }
  if (binary === "codex") {
    // Codex resumes through the `resume` subcommand (`codex resume …` or
    // `codex exec resume …`). Its short flags are unrelated: `-c` supplies a
    // config override and `-s` selects a sandbox. Treating those as Claude's
    // continue/session flags suppresses Tachyon hooks for ordinary model and
    // sandbox configuration.
    return tokens.slice(binaryIndex(tokens) + 1).includes("resume");
  }
  return tokens.some((token) => SELF_SESSION_FLAGS.has(token));
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

/**
 * Grok session dir key under `$GROK_HOME/sessions/<encoded>/…` — measured 2026-07-12 as
 * `encodeURIComponent(cwd)` (e.g. `/home/goat/tachyon` → `%2Fhome%2Fgoat%2Ftachyon`).
 * Distinct from Claude's slash/dot → hyphen encoding.
 */
export function encodeGrokCwd(cwd: string): string {
  return encodeURIComponent(cwd);
}

/** On-disk Grok transcript for (GROK_HOME, cwd, sessionId). */
export function grokTranscriptPath(configHome: string, cwd: string, id: string): string {
  return `${configHome}/sessions/${encodeGrokCwd(cwd)}/${id}/chat_history.jsonl`;
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
    runtime: "pi",
    mintsId: true,
    injectId: (cmd, id) => (managesOwnSession(cmd) ? cmd : append(cmd, "--session-id", id)),
    resumeCommand: (cmd, id) => (managesOwnSession(cmd) ? cmd : append(cmd, "--session", id)),
    // Pi's filename is `<timestamp>_<id>.jsonl`, so the exact path requires a bounded directory/header
    // scan in resolvers.ts rather than a dishonest direct transcriptPath formula.
  },
  {
    runtime: "gemini",
    mintsId: true,
    injectId: (cmd, id) => (managesOwnSession(cmd) ? cmd : append(cmd, "--session-id", id)),
    resumeCommand: (cmd, id) => (managesOwnSession(cmd) ? cmd : append(cmd, "--resume", id)),
    // project_key is a friendly-name dir or a SHA — not derivable from inputs alone.
  },
  {
    runtime: "grok",
    mintsId: true,
    injectId: (cmd, id) => (managesOwnSession(cmd) ? cmd : append(cmd, "-s", id)),
    resumeCommand: (cmd, id) => (managesOwnSession(cmd) ? cmd : append(cmd, "-r", id)),
    forkCommand: (cmd, sourceId) => append(cmd, "-r", sourceId, "--fork-session"),
    // t-9874be — transcript is `$GROK_HOME/sessions/<encodeURIComponent(cwd)>/<id>/chat_history.jsonl`
    // (measured 2026-07-12 on bridge + real homes). `configHome` is the effective GROK_HOME
    // (bridge-mcp / harness / ~/.grok) from AgentManager.runtimeConfigHome.
    transcriptPath: (configHome, cwd, id) => grokTranscriptPath(configHome, cwd, id),
    // t-4891dd — Grok supports a native config home override (`GROK_HOME`; default `~/.grok`) and
    // trusted global hooks under that home's `hooks/*.json`. Tachyon points GROK_HOME at the private
    // `<harness>/<agent>/.grok` dir so auth/config/hooks/sessions are isolated per harnessed agent.
    harness: {
      configHomeEnv: "GROK_HOME",
      authFiles: ["auth.json"],
      projectsSubdir: "sessions",
      mcp: {
        mode: "home-config",
        fileName: "config.toml",
      },
    },
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
    runtime: "antigravity",
    mintsId: false,
    injectId: (cmd) => cmd,
    resumeCommand: (cmd, id) => (id ? append(cmd, "--conversation", id) : append(cmd, "--continue")),
    resumesWithoutId: true,
  },
  {
    runtime: "opencode",
    mintsId: false,
    injectId: (cmd) => cmd,
    resumeCommand: (cmd, id) => append(cmd, "-s", id), // `opencode -s <id>`
    forkCommand: (cmd, sourceId) => append(cmd, "-s", sourceId, "--fork"),
    // spec t-e2ebe3 — opencode is XDG-compliant (measured 2026-07-08, opencode 1.17.15):
    //   - XDG_CONFIG_HOME redirects config (opencode auto-discovers opencode.json under it, no
    //     OPENCODE_CONFIG needed);
    //   - XDG_DATA_HOME hosts auth (~/.local/share/opencode/auth.json, mode 600);
    //   - XDG_STATE_HOME hosts state.
    // An empty XDG_DATA_HOME is the FOOTGUN: the agent DEGRADES SILENTLY to a fallback model
    // (big-pickle), NOT the signed GLM — so auth MUST be seeded (copy + chmod 600 from the real
    // XDG_DATA_HOME). Copy (not symlink): opencode refreshes its token in-place, and a shared symlink
    // would race the real home on multi-agent runs.
    harness: {
      configHomeEnv: "XDG_CONFIG_HOME",
      authFiles: ["opencode/auth.json"],
      projectsSubdir: "opencode/storage",
      mcp: { mode: "home-config", fileName: "opencode/opencode.json" },
      xdg: {
        dataEnv: "XDG_DATA_HOME",
        stateEnv: "XDG_STATE_HOME",
        configRel: "config",
        dataRel: "data",
        stateRel: "state",
      },
    },
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
  {
    // Hermes Agent (Nous Research): capture-style session ids (e.g. 20260713_185208_da5df2)
    // in `$HERMES_HOME/state.db`. No native fork. Brief is env HERMES_TUI_QUERY (not argv).
    runtime: "hermes",
    mintsId: false,
    resumesWithoutId: true,
    injectId: (cmd) => cmd,
    resumeCommand: (cmd, id) => (id ? append(cmd, "--resume", id) : append(cmd, "--continue")),
    // Activity reads `$HERMES_HOME/state.db` (SQLite); session id is carried separately by the host.
    transcriptPath: (configHome, _cwd, _id) => `${configHome}/state.db`,
    harness: {
      configHomeEnv: "HERMES_HOME",
      authFiles: ["auth.json"],
      projectsSubdir: "sessions",
      mcp: {
        mode: "home-config",
        fileName: "config.yaml",
      },
    },
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
