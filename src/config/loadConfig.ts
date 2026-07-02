import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { type Role, isRole, ROLES } from "../roles/templates.js";
import { binaryOf, binaryIndex } from "../resume/adapters.js";

export interface AttentionDef {
  enabled: boolean;
  silenceSec: number;
  patterns: string[];
}

export const ATTENTION_DEFAULT_SILENCE_SEC = 8;

export type RestartPolicy = "never" | "on-crash";

export type EntryKind = "agent" | "terminal";

/** CLIs we recognize as AI agents — drives kind inference and attention defaults. */
export const KNOWN_AI_CLIS = [
  "claude",
  "codex",
  "opencode",
  "gemini",
  "aider",
  "goose",
  "amp",
  "cursor-agent",
  "copilot",
  "grok",
  "qwen",
];

const LAUNCHERS = new Set(["npx", "bunx", "pnpx"]);
/** GNU `env` options that consume the FOLLOWING token as an operand (so it's not the command). */
const ENV_OPERAND_FLAGS = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);

/**
 * The effective binary base name, seeing through `npx/bunx/pnpx <bin>` and
 * `env [-i] [-u NAME] [-C DIR] [NAME=VAL]… <bin>`. SHARED by `inferKind` (classification) and
 * `composeCommand` (prompt delivery) so they always agree — a spawn classified as an AI agent
 * (and thus gated by the spec-246 contract) MUST also receive its brief (codex impl review #1/#3).
 */
export function resolveBinary(cmd: string): string {
  const tokens = cmd.trim().split(/\s+/);
  const head = (tokens[0] ?? "").split("/").pop() ?? "";
  if (LAUNCHERS.has(head)) {
    const bin = tokens.slice(1).find((t) => !t.startsWith("-") && !t.includes("="));
    return (bin ?? tokens[0] ?? "").split("/").pop() ?? "";
  }
  if (head === "env") {
    let i = 1;
    while (i < tokens.length) {
      const t = tokens[i];
      if (ENV_OPERAND_FLAGS.has(t)) { i += 2; continue; } // flag + its operand are not the command
      if (t.startsWith("-") || t.includes("=")) { i++; continue; } // other env flag / NAME=VALUE
      break; // first remaining token is the command
    }
    return (tokens[i] ?? "").split("/").pop() ?? "";
  }
  return head;
}

/** agent = known AI CLI; everything else (servers, shells, builds) = terminal. Explicit `kind:` wins. */
export function inferKind(cmd: string): EntryKind {
  return KNOWN_AI_CLIS.includes(resolveBinary(cmd)) ? "agent" : "terminal";
}

/** spec 226 — a single MCP server scoped to ONE agent's isolated harness. v1 = stdio shape only
 *  (command/args/env); http/sse (url/headers) is a follow pass. Every `env` value must be an exact
 *  `${VAR}` reference (H7 — never a literal secret on disk; claude expands it from the process env). */
export interface HarnessMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** spec 226/228/298/311 — an agent's isolated harness: its OWN MCP servers, skills, instructions/rules, and hooks,
 *  materialized into a private config home so they never leak to sibling agents.
 *  `inherit` decides whether the workspace base config is seeded first (`global` is a follow pass —
 *  rejected). At least one accepted capability must be present. */
export interface HarnessDef {
  inherit: "none" | "workspace";
  mcp?: Record<string, HarnessMcpServer>;
  /** spec 228/311 — claude settings.json `hooks` object; codex `hooks.<Event>` config.toml object. */
  hooks?: Record<string, unknown>;
  /** spec 228 — rule files (paths), concatenated into `<home>/CLAUDE.md`. */
  rules?: string[];
  /** spec 311 — codex instruction files (paths), concatenated into `<CODEX_HOME>/AGENTS.md`. */
  instructions?: string[];
  /** spec 228/311 — skill dirs (paths, each with a SKILL.md), copied into `<home>/skills/`. */
  skills?: string[];
}

/** Exactly a `${VAR}` reference — no literal value, no `${VAR:-default}` (a default could smuggle a
 *  literal secret onto disk). v1 strict; non-secret literals are a documented follow-pass gap. */
const ENV_REF_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
/** Flags Tachyon OWNS for a harness agent — a user-supplied one makes merge order security-significant (H4). */
const HARNESS_RESERVED_FLAGS = ["--mcp-config", "--strict-mcp-config", "--settings"];

export interface ManagedEntryDef {
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
  autostart: boolean;
  watch: string[];
  attention: AttentionDef;
  restart: RestartPolicy;
  kind: EntryKind;
  /** role prompt, delivered as a positional arg on spawn for CLIs that accept one */
  instructions?: string;
  /** spec 216 — built-in role template (coder/reviewer/tester/orchestrator/custom); composed
   *  with `instructions` at delivery (template first). agents-only — terminals have no AI. */
  role?: Role;
  /** spec 210 — run this agent in its own git worktree+branch (opt-in, off by default) */
  worktree?: boolean;
  /** per-agent literal branch name (overrides the global template); authoritatively validated via git check-ref-format at worktree-create */
  branch?: string;
  /** commands run ONCE in the fresh worktree before the agent starts (sequential, stop-on-failure); normalized to a list */
  worktreeSetup?: string[];
  /** spec 214 (C3) — verify-gate: a command/runbook name (or inline shell) run IN the worktree to prove it shippable; resolves like a runbook step (command name > runbook name > inline) */
  verify?: string;
  /** spec 226 — isolated harness: agent-scoped MCP/config materialized into a private config home. */
  harness?: HarnessDef;
  /** spec 240 — lightweight per-agent isolation of the claude config HOME (its own transcript namespace) WITHOUT
   *  the harness MCP/skills isolation. Lets agents that share a cwd each get an attributable session + activity
   *  log while still loading the workspace project config. Claude/Codex; "transcript" is the only mode in v1. */
  isolate?: "transcript";
}

/** Compatibility name for the unified managed-entry definition. Prefer `ManagedEntryDef`
 *  in new code; `AgentDef` remains exported for existing imports and public surfaces. */
export type AgentDef = ManagedEntryDef;

/**
 * spec 210 — cheap parse-time pre-filter for an obviously-bad literal branch name.
 * The authoritative check is `git check-ref-format` at worktree creation; this just
 * rejects garbage early with a clear config error. The template form (`tachyon/{agent}`)
 * is validated separately (it carries `{}` which are illegal in a final ref).
 */
export function validateBranchLiteral(branch: string): string | null {
  if (branch.trim().length === 0) return "must not be empty";
  if (/\s/.test(branch)) return "must not contain whitespace";
  if (branch.includes("..") || branch.includes("@{")) return "must not contain '..' or '@{'";
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) return "must not start or end with '/' or contain '//'";
  if (branch.endsWith(".") || branch.endsWith(".lock")) return "must not end with '.' or '.lock'";
  return null;
}

/** Per-runtime template turning instructions into CLI args; absent = not deliverable. */
const INSTRUCTION_ARG: Record<string, (quoted: string) => string> = {
  claude: (q) => q,
  codex: (q) => q,
  gemini: (q) => `-i ${q}`,
};

/** POSIX single-quote escaping — safe inside the shell command tmux runs. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function instructionsDeliverable(cmd: string): boolean {
  const tokens = cmd.trim().split(/\s+/);
  const base = (tokens[0] ?? "").split("/").pop() ?? "";
  return base in INSTRUCTION_ARG;
}

/**
 * spec 232 — register the Tachyon Bridge MCP on a codex command so a codex pipeline node can call the
 * `complete_node` tool. Inserts a `-c` config override right after the codex binary token (seeing through
 * `env X=1` / `npx` launchers), under a COLLISION-SAFE server name (`tachyon_bridge`) so a user's existing
 * `mcp_servers.tachyon` — even an stdio-shaped one — is untouched (a same-name `-c` errors with "url is
 * not supported for stdio"). The bearer token stays in env (`TACHYON_BRIDGE_TOKEN`, referenced indirectly
 * via `bearer_token_env_var`) — it is NEVER placed on the command line. No-op for a non-codex command.
 */
export function codexBridgeCmd(cmd: string, url: string): string {
  const tokens = cmd.trim().split(/\s+/);
  const i = binaryIndex(tokens);
  const base = (tokens[i] ?? "").split("/").pop() ?? "";
  if (base !== "codex") return cmd;
  // Idempotent — inspect ONLY the slot right after the binary, where WE always splice our `-c`. A prompt
  // is a trailing positional (composeCommand appends it last), never at i+1, so prompt text — even an
  // unquoted `-c mcp_servers.tachyon_bridge` inside a quoted prompt — can't masquerade as our flag.
  const afterBinary = tokens[i + 2]?.replace(/^'/, "") ?? "";
  if (tokens[i + 1] === "-c" && afterBinary.startsWith("mcp_servers.tachyon_bridge=")) return cmd;
  const table = `mcp_servers.tachyon_bridge={url="${url}", bearer_token_env_var="TACHYON_BRIDGE_TOKEN"}`;
  // Splice as a STRING right after the binary token so the trailing instructions positional keeps its
  // exact whitespace/newlines (codex gets a prompt positional — a split/join round-trip would collapse
  // multi-space/multi-line prompts). Find the char offset of the end of the i-th whitespace token.
  const re = /\S+/g;
  let count = 0;
  let endOfBinary = cmd.length;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    if (count === i) {
      endOfBinary = m.index + m[0].length;
      break;
    }
    count++;
  }
  return `${cmd.slice(0, endOfBinary)} -c ${shellQuote(table)}${cmd.slice(endOfBinary)}`;
}

export function codexConfigCmd(cmd: string, configOverride: string | string[]): string {
  const tokens = cmd.trim().split(/\s+/);
  const i = binaryIndex(tokens);
  const base = (tokens[i] ?? "").split("/").pop() ?? "";
  if (base !== "codex") return cmd;
  const overrides = Array.isArray(configOverride) ? configOverride : [configOverride];
  const args = overrides.map((override) => `-c ${shellQuote(override)}`).join(" ");
  const re = /\S+/g;
  let count = 0;
  let endOfBinary = cmd.length;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    if (count === i) {
      endOfBinary = m.index + m[0].length;
      break;
    }
    count++;
  }
  return `${cmd.slice(0, endOfBinary)} ${args}${cmd.slice(endOfBinary)}`;
}

/** The command actually spawned: cmd + instructions arg when the runtime accepts one. */
export function composeCommand(def: Pick<AgentDef, "cmd" | "instructions">): string {
  if (!def.instructions || def.instructions.trim().length === 0) return def.cmd;
  const base = resolveBinary(def.cmd); // see through npx/bunx/env so `npx claude` still gets its prompt (codex #1)
  const template = INSTRUCTION_ARG[base];
  if (!template) return def.cmd; // unknown CLI — stored but not delivered (documented)
  return `${def.cmd} ${template(shellQuote(def.instructions.trim()))}`;
}

// spec 234 — GridShape / LayoutDef removed (layouts feature retired; `layouts:` stays a tolerated, ignored key).

export interface CommandDef {
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface RunbookDef {
  /** each step: an exact command-name reference (commands: map) or an inline shell string */
  steps: string[];
}

export interface ScheduleDef {
  /** interval form, e.g. "30m" / "1h" / "2h" — exactly one of every/at */
  every?: string;
  /** daily wall-clock form "HH:MM" (24h, local time) */
  at?: string;
  /** action: a command/runbook name to run — exactly one of run/spawn */
  run?: string;
  /** action: a declared agent name to spawn */
  spawn?: string;
  /** startup prompt delivered when spawning (spawn only) */
  instructions?: string;
  /** at-form only: if the time already passed today and it never ran, fire on activation */
  catchUp?: boolean;
}

export interface TachyonConfig {
  /** Unified managed-entry map. Parsed from both `agents:` and `terminals:` blocks; the
   *  property name is compatibility surface, not a statement that every entry is an AI agent. */
  agents: Record<string, AgentDef>;
  commands: Record<string, CommandDef>;
  runbooks: Record<string, RunbookDef>;
  schedules: Record<string, ScheduleDef>;
  settings: {
    maxAgents?: number;
    bridgePort?: number;
    auth?: boolean;
    tmux?: Record<string, string>;
    /** spec 210 — global worktree location root + branch-name template ({agent} placeholder); spec 214 — global default verify-gate */
    worktree?: { base?: string; branch?: string; verify?: string };
    /** spec 216 — auto re-anchor an agent's role after a detected compaction (OFF by default; risky live injection) */
    anchor?: { auto?: boolean };
    /** spec 216 — append Bridge-coordination guidance to agents spawned via the Bridge (default true) */
    bridgeGuidance?: boolean;
    /** spec 219 — clean clipboard copy: "auto" (default) wires a UTF-8 copy-mode helper; "off" leaves OSC 52 */
    clipboard?: "auto" | "off";
    /** spec 245 — project handoff: canonical file path (RELATIVE to workspace root, default .tachyon/HANDOFF.md)
     *  + the append-note nudge cadence (`off` | an interval like `30m`/`1h`; default `30m`, throttled per-workspace). */
    handoff?: { path?: string; nudgeEvery?: string };
    /** spec 312 — default-on runtime-native silent persistence hooks for declared Claude/Codex agents. */
    persistence?: { silentHooks?: boolean };
  };
}

/** Parses an `every:` interval ("30m"/"1h"/"90m"/"2h") to ms; null if malformed. */
export function parseEvery(value: string): number | null {
  const m = /^(\d+)\s*(m|h)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1) return null;
  return m[2] === "h" ? n * 3600_000 : n * 60_000;
}

/** Validates an `at:` "HH:MM" (24h); returns {h,m} or null. */
export function parseAt(value: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

export interface ParseResult {
  config?: TachyonConfig;
  errors: string[];
}

export const CONFIG_FILENAMES = ["tachyon.yml", "tachyon.yaml"];

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every recognized entry key. `kind`/`instructions` are recognized everywhere (so they're never
 *  "unknown"); under `terminals:` they're rejected explicitly with a clearer message instead. */
const AGENT_KEYS = ["cmd", "cwd", "env", "autostart", "watch", "attention", "restart", "kind", "instructions", "role", "worktree", "branch", "worktreeSetup", "verify", "harness", "isolate"];

/** Recognized harness keys (spec 226 mcp + spec 228 hooks/rules/skills). */
const HARNESS_KEYS = ["inherit", "mcp", "hooks", "rules", "instructions", "skills"];

/**
 * spec 226/228 — parse + validate an `agents.<name>.harness` block (H4/H7/H9). Fail-closed: only on a
 * claude/codex agent, only `inherit: none|workspace`, MCP env values must be exact `${VAR}` references;
 * rejects a `cmd`/`env` that already owns the harness plumbing. Requires at least one of
 * the runtime's supported harness capabilities. Returns the def or undefined (errors pushed). `cmd`/`env` are the agent's,
 * for the H4 ownership checks.
 */
function parseHarness(name: string, raw: unknown, cmd: string, env: Record<string, string> | undefined, isTerminal: boolean, errors: string[]): HarnessDef | undefined {
  if (isTerminal) {
    errors.push(`agents.${name}: 'harness' applies only to agents (this entry is a terminal — it has no runtime harness)`);
    return undefined;
  }
  const binary = binaryOf(cmd);
  if (binary !== "claude" && binary !== "codex") {
    errors.push(`agents.${name}.harness: only supported for claude/codex agents in v1 (got '${binary || cmd}')`);
    return undefined;
  }
  // H4 — Tachyon owns CLAUDE_CONFIG_DIR + the strict-mcp flags for a harness agent. Match both the
  // space-separated form (`--settings x`) AND the equals form (`--settings=x`) — claude accepts both,
  // so a bare token check would let `--settings=/tmp/x` slip past (codex impl-review M4).
  if (binary === "claude") {
    const tokens = cmd.trim().split(/\s+/);
    for (const flag of HARNESS_RESERVED_FLAGS) {
      if (tokens.some((t) => t === flag || t.startsWith(`${flag}=`))) {
        errors.push(`agents.${name}.harness: remove '${flag}' from cmd — Tachyon manages MCP config for a harness agent`);
        return undefined;
      }
    }
  }
  const ownedEnv = binary === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  if (env && ownedEnv in env) {
    errors.push(`agents.${name}.harness: remove 'env.${ownedEnv}' — Tachyon owns the config home for a harness agent`);
    return undefined;
  }
  if (!isPlainObject(raw)) {
    errors.push(`agents.${name}.harness: must be a mapping with 'mcp' (and optional 'inherit')`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!HARNESS_KEYS.includes(key)) errors.push(`agents.${name}.harness: unknown key '${key}'`);
  }
  if (binary === "codex") {
    const unsupported = ["rules"].filter((key) => raw[key] !== undefined);
    if (unsupported.length > 0) {
      errors.push(`agents.${name}.harness: codex does not support 'rules'; use 'instructions' for AGENTS.md guidance`);
    }
  } else if (raw.instructions !== undefined) {
    errors.push(`agents.${name}.harness.instructions: only supported for codex agents; use 'rules' for claude`);
  }
  let inherit: HarnessDef["inherit"] = "workspace";
  if (raw.inherit !== undefined) {
    if (raw.inherit === "none" || raw.inherit === "workspace") {
      inherit = raw.inherit;
    } else if (raw.inherit === "global") {
      errors.push(`agents.${name}.harness.inherit: 'global' is not supported yet (use 'none' or 'workspace')`);
    } else {
      errors.push(`agents.${name}.harness.inherit: must be 'none' or 'workspace'`);
    }
  }
  const harness: HarnessDef = { inherit };

  // mcp (optional) — stdio servers; each env value must be an exact ${VAR} reference (H7).
  if (raw.mcp !== undefined) {
    if (!isPlainObject(raw.mcp) || Object.keys(raw.mcp).length === 0) {
      errors.push(`agents.${name}.harness.mcp: must be a non-empty mapping of server name -> definition`);
    } else {
      const mcp: Record<string, HarnessMcpServer> = {};
      for (const [server, sdef] of Object.entries(raw.mcp)) {
        if (!NAME_RE.test(server)) {
          errors.push(`agents.${name}.harness.mcp.${server}: invalid server name (must match ${NAME_RE})`);
          continue;
        }
        if (server === "tachyon" || server === "tachyon_bridge") {
          errors.push(`agents.${name}.harness.mcp.${server}: '${server}' is reserved for the Tachyon Bridge (injected automatically); use a different name`);
          continue;
        }
        if (!isPlainObject(sdef) || typeof sdef.command !== "string" || sdef.command.trim().length === 0) {
          errors.push(`agents.${name}.harness.mcp.${server}: must be a mapping with a non-empty 'command' (stdio servers only)`);
          continue;
        }
        const server_def: HarnessMcpServer = { command: sdef.command };
        if (sdef.args !== undefined) {
          if (!Array.isArray(sdef.args) || sdef.args.some((a) => typeof a !== "string")) {
            errors.push(`agents.${name}.harness.mcp.${server}.args: must be a list of strings`);
            continue;
          }
          server_def.args = sdef.args as string[];
        }
        if (sdef.env !== undefined) {
          if (!isPlainObject(sdef.env) || Object.values(sdef.env).some((v) => typeof v !== "string")) {
            errors.push(`agents.${name}.harness.mcp.${server}.env: must be a mapping of string -> string`);
            continue;
          }
          const senv: Record<string, string> = {};
          let bad = false;
          for (const [k, v] of Object.entries(sdef.env as Record<string, string>)) {
            if (!ENV_REF_RE.test(v)) {
              errors.push(`agents.${name}.harness.mcp.${server}.env.${k}: must be an exact \${VAR} reference (a literal value would write a secret to disk)`);
              bad = true;
              continue;
            }
            if (binary === "codex" && v !== `\${${k}}`) {
              errors.push(`agents.${name}.harness.mcp.${server}.env.${k}: codex requires the env key to match its reference ('\${${k}}')`);
              bad = true;
              continue;
            }
            senv[k] = v;
          }
          if (bad) continue;
          server_def.env = senv;
        }
        for (const key of Object.keys(sdef)) {
          if (!["command", "args", "env"].includes(key)) {
            errors.push(`agents.${name}.harness.mcp.${server}: unknown key '${key}' (stdio command/args/env; url/headers is a follow pass)`);
          }
        }
        mcp[server] = server_def;
      }
      if (Object.keys(mcp).length > 0) harness.mcp = mcp;
    }
  }

  // spec 228 — hooks (a claude settings.json `hooks` object; shape pass-through, claude validates contents)
  if (raw.hooks !== undefined) {
    if (!isPlainObject(raw.hooks) || Object.keys(raw.hooks).length === 0) {
      errors.push(`agents.${name}.harness.hooks: must be a non-empty mapping (the claude settings.json 'hooks' shape)`);
    } else {
      harness.hooks = raw.hooks;
    }
  }

  // spec 228/311 — rules/instructions (file paths concatenated into runtime guidance files) and skills (skill dirs copied
  // into <home>/skills/); both a non-empty string or list of non-empty strings. Paths must be
  // workspace-relative (codex M4: reject absolute / `..`-traversal early — materialize also re-checks
  // the resolved real path against the workspace as the fail-closed backstop).
  const isContained = (p: string): boolean => !p.startsWith("/") && !p.startsWith("~") && !/(^|[\\/])\.\.([\\/]|$)/.test(p) && !/^[A-Za-z]:[\\/]/.test(p);
  const parsePathList = (key: "rules" | "instructions" | "skills"): string[] | undefined => {
    const rawVal = raw[key];
    if (rawVal === undefined) return undefined;
    const list = typeof rawVal === "string" ? [rawVal] : rawVal;
    if (!Array.isArray(list) || list.length === 0 || list.some((p) => typeof p !== "string" || p.trim().length === 0)) {
      errors.push(`agents.${name}.harness.${key}: must be a non-empty path or list of non-empty paths`);
      return undefined;
    }
    if ((list as string[]).some((p) => !isContained(p.trim()))) {
      errors.push(`agents.${name}.harness.${key}: paths must be workspace-relative (no absolute paths or '..')`);
      return undefined;
    }
    return list as string[];
  };
  const rules = parsePathList("rules");
  if (rules) harness.rules = rules;
  const instructions = parsePathList("instructions");
  if (instructions) harness.instructions = instructions;
  const skills = parsePathList("skills");
  if (skills) harness.skills = skills;

  // At least one capability must actually be ACCEPTED (codex M5: raw-key presence isn't enough — an
  // empty/invalid `mcp: {}` / `rules: []` errors above but must not leave a no-op harness).
  if (!harness.mcp && !harness.hooks && !harness.rules && !harness.instructions && !harness.skills) {
    errors.push(`agents.${name}.harness: declare at least one of mcp, skills, rules, instructions, hooks`);
    return undefined;
  }
  return harness;
}

/**
 * spec 215 — parse one agent/terminal entry's fields, shared by the `agents:` and `terminals:`
 * blocks so they never drift. For `terminals:` the kind is forced to `terminal`, and a `kind:` or
 * `instructions:` key is rejected (kind is implied; instructions need an AI). Error prefixes use
 * the real section so messages stay accurate. Returns the def, or null when `cmd` is missing.
 */
function parseAgentEntry(section: "agents" | "terminals", name: string, def: Record<string, unknown>, errors: string[]): AgentDef | null {
  const forceTerminal = section === "terminals";
  if (typeof def.cmd !== "string" || def.cmd.trim().length === 0) {
    errors.push(`${section}.${name}.cmd: required non-empty string`);
    return null;
  }
  const agent: AgentDef = {
    cmd: def.cmd,
    autostart: false,
    watch: [],
    attention: { enabled: true, silenceSec: ATTENTION_DEFAULT_SILENCE_SEC, patterns: [] },
    restart: "never",
    kind: forceTerminal ? "terminal" : inferKind(def.cmd),
  };
  if (forceTerminal) {
    if (def.kind !== undefined) errors.push(`terminals.${name}: remove 'kind' — entries under terminals: are always terminals`);
    if (def.instructions !== undefined) errors.push(`terminals.${name}: 'instructions' applies only to agents (declare it under agents: with kind: agent)`);
  } else if (def.kind !== undefined) {
    if (def.kind !== "agent" && def.kind !== "terminal") errors.push(`agents.${name}.kind: must be 'agent' or 'terminal'`);
    else agent.kind = def.kind;
  }
  if (def.cwd !== undefined) {
    if (typeof def.cwd !== "string") errors.push(`${section}.${name}.cwd: must be a string`);
    else agent.cwd = def.cwd;
  }
  if (def.env !== undefined) {
    if (!isPlainObject(def.env) || Object.values(def.env).some((v) => typeof v !== "string")) {
      errors.push(`${section}.${name}.env: must be a mapping of string -> string`);
    } else {
      agent.env = def.env as Record<string, string>;
    }
  }
  if (def.autostart !== undefined) {
    if (typeof def.autostart !== "boolean") errors.push(`${section}.${name}.autostart: must be a boolean`);
    else agent.autostart = def.autostart;
  }
  if (def.watch !== undefined) {
    const globs = typeof def.watch === "string" ? [def.watch] : def.watch;
    if (!Array.isArray(globs) || globs.length === 0 || globs.some((g) => typeof g !== "string" || g.length === 0)) {
      errors.push(`${section}.${name}.watch: must be a non-empty glob string or list of globs`);
    } else {
      agent.watch = globs as string[];
    }
  }
  if (def.attention !== undefined) {
    if (typeof def.attention === "boolean") {
      agent.attention.enabled = def.attention;
    } else if (isPlainObject(def.attention)) {
      agent.attention.enabled = true;
      const att = def.attention;
      if (att.enabled !== undefined) {
        if (typeof att.enabled !== "boolean") errors.push(`${section}.${name}.attention.enabled: must be a boolean`);
        else agent.attention.enabled = att.enabled;
      }
      if (att.silenceSec !== undefined) {
        if (typeof att.silenceSec !== "number" || !Number.isInteger(att.silenceSec) || att.silenceSec < 1) {
          errors.push(`${section}.${name}.attention.silenceSec: must be an integer >= 1`);
        } else {
          agent.attention.silenceSec = att.silenceSec;
        }
      }
      if (att.patterns !== undefined) {
        if (!Array.isArray(att.patterns) || att.patterns.some((p) => typeof p !== "string" || p.length === 0)) {
          errors.push(`${section}.${name}.attention.patterns: must be a list of non-empty regex strings`);
        } else {
          agent.attention.patterns = att.patterns as string[];
        }
      }
      for (const key of Object.keys(att)) {
        if (!["enabled", "silenceSec", "patterns"].includes(key)) {
          errors.push(`${section}.${name}.attention: unknown key '${key}'`);
        }
      }
    } else {
      errors.push(`${section}.${name}.attention: must be a boolean or a mapping`);
    }
  } else if (agent.kind === "terminal") {
    // Terminals (servers, shells, builds) are silent by nature — attention defaults off.
    agent.attention.enabled = false;
  }
  if (!forceTerminal && def.instructions !== undefined) {
    if (typeof def.instructions !== "string") {
      errors.push(`agents.${name}.instructions: must be a string`);
    } else if (def.instructions.trim().length > 0) {
      agent.instructions = def.instructions;
    }
  }
  if (def.role !== undefined) {
    // role is agents-only — reject under terminals: AND under agents: with kind: terminal
    // (codex r1 m5: the old terminal-declaration style must honor the same contract).
    if (forceTerminal || agent.kind === "terminal") {
      errors.push(`${section}.${name}: 'role' applies only to agents (this entry is a terminal — it has no AI to take a role)`);
    } else if (typeof def.role !== "string" || !isRole(def.role)) {
      errors.push(`agents.${name}.role: must be one of ${ROLES.join(", ")}`);
    } else {
      agent.role = def.role;
    }
  }
  if (def.restart !== undefined) {
    if (def.restart !== "never" && def.restart !== "on-crash") {
      errors.push(`${section}.${name}.restart: must be 'never' or 'on-crash'`);
    } else {
      agent.restart = def.restart;
    }
  }
  if (def.worktree !== undefined) {
    if (typeof def.worktree !== "boolean") errors.push(`${section}.${name}.worktree: must be a boolean`);
    else agent.worktree = def.worktree;
  }
  if (def.branch !== undefined) {
    if (typeof def.branch !== "string") {
      errors.push(`${section}.${name}.branch: must be a string`);
    } else {
      const bad = validateBranchLiteral(def.branch);
      if (bad) errors.push(`${section}.${name}.branch: ${bad}`);
      else agent.branch = def.branch;
    }
  }
  if (def.worktreeSetup !== undefined) {
    const list = typeof def.worktreeSetup === "string" ? [def.worktreeSetup] : def.worktreeSetup;
    if (!Array.isArray(list) || list.length === 0 || list.some((c) => typeof c !== "string" || c.trim().length === 0)) {
      errors.push(`${section}.${name}.worktreeSetup: must be a non-empty command string or list of non-empty command strings`);
    } else {
      agent.worktreeSetup = list as string[];
    }
  }
  if (def.verify !== undefined) {
    if (typeof def.verify !== "string" || def.verify.trim().length === 0) {
      errors.push(`${section}.${name}.verify: must be a non-empty command/runbook name or inline command string`);
    } else {
      agent.verify = def.verify.trim();
    }
  }
  if (def.harness !== undefined) {
    const harness = parseHarness(name, def.harness, agent.cmd, agent.env, forceTerminal || agent.kind === "terminal", errors);
    if (harness) agent.harness = harness;
  }
  if (def.isolate !== undefined) {
    // spec 240/298 — claude/codex, agents-only, Tachyon owns the home. (Redundant with harness:, which already
    // gives a private home — claudeConfigHome resolves either to the same home, so harness wins harmlessly.)
    if (def.isolate !== "transcript") {
      errors.push(`${section}.${name}.isolate: the only supported value is 'transcript'`);
    } else if (forceTerminal || agent.kind === "terminal") {
      errors.push(`${section}.${name}: 'isolate' applies only to agents (this entry is a terminal — it has no transcript)`);
    } else if (binaryOf(agent.cmd) !== "claude" && binaryOf(agent.cmd) !== "codex") {
      errors.push(`agents.${name}.isolate: only supported for claude/codex agents in v1 (got '${binaryOf(agent.cmd) || agent.cmd}')`);
    } else if (agent.env?.[binaryOf(agent.cmd) === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] !== undefined) {
      const ownedEnv = binaryOf(agent.cmd) === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
      errors.push(`agents.${name}.isolate: remove 'env.${ownedEnv}' — Tachyon owns the config home for an isolated agent`);
    } else {
      agent.isolate = "transcript";
    }
  }
  // kind/instructions are recognized keys (rejected above for terminals:) so they don't also trip
  // the generic "unknown key" error — only genuinely-unrecognized keys do.
  for (const key of Object.keys(def)) {
    if (!AGENT_KEYS.includes(key)) errors.push(`${section}.${name}: unknown key '${key}'`);
  }
  return agent;
}

/** Validates the parsed YAML by hand — keeps the extension dependency-light; the JSON Schema covers editor-time validation. */
export function parseConfig(yamlText: string): ParseResult {
  const errors: string[] = [];

  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    return { errors: [`invalid YAML: ${err instanceof Error ? err.message : String(err)}`] };
  }

  if (!isPlainObject(raw)) {
    return { errors: ["tachyon.yml must be a YAML mapping with at least an 'agents' section"] };
  }

  for (const key of Object.keys(raw)) {
    if (!["agents", "terminals", "layouts", "commands", "runbooks", "schedules", "settings"].includes(key)) {
      errors.push(`unknown top-level key '${key}' (expected agents, terminals, layouts, commands, runbooks, schedules, settings)`);
    }
  }

  // spec 215 — agents: and terminals: merge into ONE kind-tagged record (the engine's single
  // source of truth). At least one entry must exist across the two blocks.
  const agents: Record<string, ManagedEntryDef> = {};
  const hasAgents = isPlainObject(raw.agents) && Object.keys(raw.agents).length > 0;
  const hasTerminals = isPlainObject(raw.terminals) && Object.keys(raw.terminals as Record<string, unknown>).length > 0;
  if (raw.agents !== undefined && !isPlainObject(raw.agents)) {
    errors.push("'agents' must be a non-empty mapping of agent name -> definition");
  } else if (!hasAgents && !hasTerminals) {
    errors.push("'agents' must be a non-empty mapping of agent name -> definition (or declare a 'terminals' block)");
  }
  if (isPlainObject(raw.agents)) {
    for (const [name, def] of Object.entries(raw.agents)) {
      if (!NAME_RE.test(name)) {
        errors.push(`agents.${name}: invalid name (must match ${NAME_RE})`);
        continue;
      }
      if (!isPlainObject(def)) {
        errors.push(`agents.${name}: must be a mapping with at least 'cmd'`);
        continue;
      }
      const agent = parseAgentEntry("agents", name, def, errors);
      if (agent) agents[name] = agent;
    }
  }

  if (raw.terminals !== undefined) {
    if (!isPlainObject(raw.terminals)) {
      errors.push("'terminals' must be a mapping of terminal name -> definition");
    } else {
      for (const [name, def] of Object.entries(raw.terminals)) {
        if (!NAME_RE.test(name)) {
          errors.push(`terminals.${name}: invalid name (must match ${NAME_RE})`);
          continue;
        }
        if (!isPlainObject(def)) {
          errors.push(`terminals.${name}: must be a mapping with at least 'cmd'`);
          continue;
        }
        if (name in agents) {
          errors.push(`terminals.${name}: name already declared under agents: — agents and terminals share one namespace`);
          continue;
        }
        const terminal = parseAgentEntry("terminals", name, def, errors);
        if (terminal) agents[name] = terminal;
      }
    }
  }

  // spec 234 — layouts: is recognized (allowed-keys list) but no longer parsed/validated (feature retired).

  const commands: Record<string, CommandDef> = {};
  if (raw.commands !== undefined) {
    if (!isPlainObject(raw.commands)) {
      errors.push("'commands' must be a mapping of command name -> definition");
    } else {
      for (const [name, def] of Object.entries(raw.commands)) {
        if (!NAME_RE.test(name)) {
          errors.push(`commands.${name}: invalid name (must match ${NAME_RE})`);
          continue;
        }
        if (!isPlainObject(def) || typeof def.cmd !== "string" || def.cmd.trim().length === 0) {
          errors.push(`commands.${name}: must be a mapping with a non-empty 'cmd'`);
          continue;
        }
        const command: CommandDef = { cmd: def.cmd };
        if (def.cwd !== undefined) {
          if (typeof def.cwd !== "string") errors.push(`commands.${name}.cwd: must be a string`);
          else command.cwd = def.cwd;
        }
        if (def.env !== undefined) {
          if (!isPlainObject(def.env) || Object.values(def.env).some((v) => typeof v !== "string")) {
            errors.push(`commands.${name}.env: must be a mapping of string -> string`);
          } else {
            command.env = def.env as Record<string, string>;
          }
        }
        for (const key of Object.keys(def)) {
          if (!["cmd", "cwd", "env"].includes(key)) errors.push(`commands.${name}: unknown key '${key}'`);
        }
        commands[name] = command;
      }
    }
  }

  const runbooks: Record<string, RunbookDef> = {};
  if (raw.runbooks !== undefined) {
    if (!isPlainObject(raw.runbooks)) {
      errors.push("'runbooks' must be a mapping of runbook name -> definition");
    } else {
      for (const [name, def] of Object.entries(raw.runbooks)) {
        if (!NAME_RE.test(name)) {
          errors.push(`runbooks.${name}: invalid name (must match ${NAME_RE})`);
          continue;
        }
        if (
          !isPlainObject(def) ||
          !Array.isArray(def.steps) ||
          def.steps.length === 0 ||
          def.steps.some((st) => typeof st !== "string" || st.trim().length === 0)
        ) {
          errors.push(`runbooks.${name}: must declare a non-empty 'steps' list of strings`);
          continue;
        }
        for (const key of Object.keys(def)) {
          if (key !== "steps") errors.push(`runbooks.${name}: unknown key '${key}'`);
        }
        runbooks[name] = { steps: def.steps as string[] };
      }
    }
  }

  const schedules: Record<string, ScheduleDef> = {};
  if (raw.schedules !== undefined) {
    if (!isPlainObject(raw.schedules)) {
      errors.push("'schedules' must be a mapping of schedule name -> definition");
    } else {
      for (const [name, def] of Object.entries(raw.schedules)) {
        if (!NAME_RE.test(name)) {
          errors.push(`schedules.${name}: invalid name (must match ${NAME_RE})`);
          continue;
        }
        if (!isPlainObject(def)) {
          errors.push(`schedules.${name}: must be a mapping`);
          continue;
        }
        for (const key of Object.keys(def)) {
          if (!["every", "at", "run", "spawn", "instructions", "catchUp"].includes(key)) {
            errors.push(`schedules.${name}: unknown key '${key}'`);
          }
        }
        const hasEvery = def.every !== undefined;
        const hasAt = def.at !== undefined;
        if (hasEvery === hasAt) {
          errors.push(`schedules.${name}: exactly one of 'every' or 'at' is required`);
          continue;
        }
        if (hasEvery && (typeof def.every !== "string" || parseEvery(def.every) === null)) {
          errors.push(`schedules.${name}.every: must be like '30m', '1h', '2h'`);
          continue;
        }
        if (hasAt && (typeof def.at !== "string" || parseAt(def.at) === null)) {
          errors.push(`schedules.${name}.at: must be 'HH:MM' (24h)`);
          continue;
        }
        const hasRun = def.run !== undefined;
        const hasSpawn = def.spawn !== undefined;
        if (hasRun === hasSpawn) {
          errors.push(`schedules.${name}: exactly one of 'run' or 'spawn' is required`);
          continue;
        }
        if (hasRun) {
          if (typeof def.run !== "string" || (!(def.run in commands) && !(def.run in runbooks))) {
            errors.push(`schedules.${name}.run: must reference a declared command or runbook`);
            continue;
          }
        }
        if (hasSpawn && (typeof def.spawn !== "string" || !(def.spawn in agents))) {
          errors.push(`schedules.${name}.spawn: must reference a declared agent`);
          continue;
        }
        if (def.instructions !== undefined && (typeof def.instructions !== "string" || !hasSpawn)) {
          errors.push(`schedules.${name}.instructions: only valid with 'spawn' and must be a string`);
          continue;
        }
        if (def.catchUp !== undefined && typeof def.catchUp !== "boolean") {
          errors.push(`schedules.${name}.catchUp: must be a boolean`);
          continue;
        }
        const entry: ScheduleDef = hasEvery ? { every: def.every as string } : { at: def.at as string };
        if (hasRun) entry.run = def.run as string;
        else entry.spawn = def.spawn as string;
        if (def.instructions !== undefined) entry.instructions = def.instructions as string;
        if (def.catchUp !== undefined) entry.catchUp = def.catchUp as boolean;
        schedules[name] = entry;
      }
    }
  }

  const settings: TachyonConfig["settings"] = {};
  if (raw.settings !== undefined) {
    if (!isPlainObject(raw.settings)) {
      errors.push("'settings' must be a mapping");
    } else {
      if (raw.settings.maxAgents !== undefined) {
        const n = raw.settings.maxAgents;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
          errors.push("settings.maxAgents: must be an integer >= 1");
        } else {
          settings.maxAgents = n;
        }
      }
      if (raw.settings.bridgePort !== undefined) {
        const n = raw.settings.bridgePort;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1024 || n > 65535) {
          errors.push("settings.bridgePort: must be an integer between 1024 and 65535");
        } else {
          settings.bridgePort = n;
        }
      }
      // spec 234 — settings.layout is recognized but ignored (layouts feature retired; no error on a legacy value).
      if (raw.settings.auth !== undefined) {
        if (typeof raw.settings.auth !== "boolean") {
          errors.push("settings.auth: must be a boolean");
        } else {
          settings.auth = raw.settings.auth;
        }
      }
      if (raw.settings.tmux !== undefined) {
        // Free-form tmux server options, applied as `set -g <key> <value>` on
        // Tachyon's dedicated socket. Tachyon's defaults (mouse/focus-events/
        // history-limit) apply first, this overlays, and `remain-on-exit` stays
        // reserved (crash detection depends on it). The user's ~/.tmux.conf is
        // never loaded (the -f /dev/null isolation), so this is the only door.
        if (!isPlainObject(raw.settings.tmux)) {
          errors.push("settings.tmux: must be a mapping of tmux option -> value");
        } else {
          const tmux: Record<string, string> = {};
          for (const [k, v] of Object.entries(raw.settings.tmux)) {
            if (!/^[a-z][a-z0-9-]*$/.test(k)) {
              errors.push(`settings.tmux: invalid option name '${k}' (lowercase letters, digits, '-')`);
              continue;
            }
            if (k === "remain-on-exit") {
              errors.push("settings.tmux: 'remain-on-exit' is reserved by Tachyon (crash detection depends on it)");
              continue;
            }
            // YAML on/off/true/false -> tmux on/off; numbers -> string; strings literal.
            const s = typeof v === "boolean" ? (v ? "on" : "off") : typeof v === "number" ? String(v) : v;
            if (typeof s !== "string") {
              errors.push(`settings.tmux.${k}: must be a string, number, or boolean`);
              continue;
            }
            if (/[\n\r]/.test(s)) {
              errors.push(`settings.tmux.${k}: value must not contain newlines`);
              continue;
            }
            tmux[k] = s;
          }
          settings.tmux = tmux;
        }
      }
      if (raw.settings.worktree !== undefined) {
        if (!isPlainObject(raw.settings.worktree)) {
          errors.push("settings.worktree: must be a mapping with 'base' and/or 'branch'");
        } else {
          const wt = raw.settings.worktree;
          const out: { base?: string; branch?: string; verify?: string } = {};
          if (wt.base !== undefined) {
            if (typeof wt.base !== "string" || wt.base.trim().length === 0) errors.push("settings.worktree.base: must be a non-empty path string");
            else out.base = wt.base;
          }
          if (wt.branch !== undefined) {
            if (typeof wt.branch !== "string" || wt.branch.trim().length === 0) {
              errors.push("settings.worktree.branch: must be a non-empty branch template string");
            } else if (!wt.branch.includes("{agent}")) {
              errors.push("settings.worktree.branch: template must contain '{agent}' (else every agent collides on one branch)");
            } else {
              out.branch = wt.branch;
            }
          }
          if (wt.verify !== undefined) {
            if (typeof wt.verify !== "string" || wt.verify.trim().length === 0) {
              errors.push("settings.worktree.verify: must be a non-empty command/runbook name or inline command string");
            } else {
              out.verify = wt.verify.trim();
            }
          }
          for (const key of Object.keys(wt)) {
            if (!["base", "branch", "verify"].includes(key)) errors.push(`settings.worktree: unknown key '${key}'`);
          }
          settings.worktree = out;
        }
      }
      if (raw.settings.anchor !== undefined) {
        if (!isPlainObject(raw.settings.anchor)) {
          errors.push("settings.anchor: must be a mapping with 'auto'");
        } else {
          const an = raw.settings.anchor;
          const out: { auto?: boolean } = {};
          if (an.auto !== undefined) {
            if (typeof an.auto !== "boolean") errors.push("settings.anchor.auto: must be a boolean");
            else out.auto = an.auto;
          }
          for (const key of Object.keys(an)) {
            if (key !== "auto") errors.push(`settings.anchor: unknown key '${key}'`);
          }
          settings.anchor = out;
        }
      }
      if (raw.settings.bridgeGuidance !== undefined) {
        if (typeof raw.settings.bridgeGuidance !== "boolean") errors.push("settings.bridgeGuidance: must be a boolean");
        else settings.bridgeGuidance = raw.settings.bridgeGuidance;
      }
      if (raw.settings.clipboard !== undefined) {
        if (raw.settings.clipboard !== "auto" && raw.settings.clipboard !== "off") errors.push("settings.clipboard: must be 'auto' or 'off'");
        else settings.clipboard = raw.settings.clipboard;
      }
      if (raw.settings.handoff !== undefined) {
        if (!isPlainObject(raw.settings.handoff)) {
          errors.push("settings.handoff: must be a mapping with 'path'");
        } else {
          const ho = raw.settings.handoff;
          const h: { path?: string; nudgeEvery?: string } = {};
          if (ho.path !== undefined) {
            if (typeof ho.path !== "string" || ho.path.trim() === "") errors.push("settings.handoff.path: must be a non-empty string");
            else h.path = ho.path;
          }
          if (ho.nudgeEvery !== undefined) {
            if (ho.nudgeEvery !== "off" && parseEvery(String(ho.nudgeEvery)) === null) errors.push("settings.handoff.nudgeEvery: must be 'off' or an interval like '30m' / '1h'");
            else h.nudgeEvery = String(ho.nudgeEvery);
          }
          if (Object.keys(h).length > 0) settings.handoff = h;
          for (const key of Object.keys(ho)) if (key !== "path" && key !== "nudgeEvery") errors.push(`settings.handoff: unknown key '${key}'`);
        }
      }
      if (raw.settings.persistence !== undefined) {
        if (!isPlainObject(raw.settings.persistence)) {
          errors.push("settings.persistence: must be a mapping with 'silentHooks'");
        } else {
          const pe = raw.settings.persistence;
          const p: { silentHooks?: boolean } = {};
          if (pe.silentHooks !== undefined) {
            if (typeof pe.silentHooks !== "boolean") errors.push("settings.persistence.silentHooks: must be a boolean");
            else p.silentHooks = pe.silentHooks;
          }
          if (Object.keys(p).length > 0) settings.persistence = p;
          for (const key of Object.keys(pe)) if (key !== "silentHooks") errors.push(`settings.persistence: unknown key '${key}'`);
        }
      }
      for (const key of Object.keys(raw.settings)) {
        if (!["maxAgents", "bridgePort", "auth", "layout", "tmux", "worktree", "anchor", "bridgeGuidance", "clipboard", "handoff", "persistence"].includes(key)) errors.push(`settings: unknown key '${key}'`);
      }
    }
  }

  if (errors.length > 0) return { errors };
  return { config: { agents, commands, runbooks, schedules, settings }, errors: [] };
}

export function loadConfigFile(path: string): ParseResult {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (err) {
    return { errors: [`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  return parseConfig(text);
}
