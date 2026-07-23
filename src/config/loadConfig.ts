import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { parseAgentMemoryMax } from "../agents/agentMemoryScope.js";
import { type Role, isRole, ROLES } from "../roles/templates.js";
import { binaryOf, binaryIndex } from "../resume/adapters.js";
import { TASK_NOTIFICATION_EVENT_IDS, type TaskNotificationSettingsInput } from "../tasks/taskNotificationPolicy.js";
import {
  PROJECT_GUIDANCE_MAX_FILES,
  projectGuidancePathError,
  type ProjectGuidanceSettings,
} from "./projectGuidance.js";
import { openingPromptCapability, resolveBinary } from "../agents/openingPromptCapability.js";
import { AGENT_NAME_PATTERN, asciiFoldAgentName } from "./nameValidation.js";
import { runtimePromptAdapter } from "../agents/runtimePromptAdapters.js";
import { parseLaunchCommand } from "../runtime/launchPreflight.js";
export { openingPromptCapability, resolveBinary } from "../agents/openingPromptCapability.js";
import {
  behaviorStubPathError,
  behaviorStubPathTemplateError,
  type BehaviorVerificationSettings,
} from "./behaviorVerification.js";
import { parseArgvCommand } from "./argvCommand.js";
import { containsUnsafeFramingCharacter } from "./framingSafety.js";
import type { ResolvedAgentCapabilityProjection } from "./agentProfileResolver.js";

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
  "agy",
  "opencode",
  "gemini",
  "aider",
  "goose",
  "amp",
  "cursor-agent",
  "copilot",
  "grok",
  "qwen",
  "pi",
  "hermes",
  "verboo",
];


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

/** spec 226/228/298/311/406 — an agent's isolated harness: its OWN runtime resources,
 *  materialized into a private config home so they never leak to sibling agents.
 *  `inherit` decides whether the workspace base config is seeded first (`global` is a follow pass —
 *  rejected). At least one accepted capability must be present. Pi accepts only its explicit local
 *  resource lists (skills plus extensions/prompts/themes/packages). */
export interface HarnessDef {
  inherit: "none" | "workspace";
  mcp?: Record<string, HarnessMcpServer>;
  /** spec 228/311 — claude settings.json `hooks` object; codex `hooks.<Event>` config.toml object. */
  hooks?: Record<string, unknown>;
  /** spec 228 — rule files (paths), concatenated into `<home>/CLAUDE.md`. */
  rules?: string[];
  /** spec 311 — codex instruction files (paths), concatenated into `<CODEX_HOME>/AGENTS.md`. */
  instructions?: string[];
  /** spec 228/311/406 — skill dirs (paths, each with a SKILL.md), copied into the private home. */
  skills?: string[];
  /** spec 406 — Pi-only extension file or directory paths. */
  extensions?: string[];
  /** spec 406 — Pi-only prompt-template `.md` file paths. */
  prompts?: string[];
  /** spec 406 — Pi-only theme `.json` file paths. */
  themes?: string[];
  /** spec 406 — Pi-only workspace-local package directory paths; never npm/git specs. */
  packages?: string[];
}

/** Exactly a `${VAR}` reference — no literal value, no `${VAR:-default}` (a default could smuggle a
 *  literal secret onto disk). v1 strict; non-secret literals are a documented follow-pass gap. */
const ENV_REF_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
/** Flags Tachyon OWNS for a harness agent — a user-supplied one makes merge order security-significant (H4). */
const HARNESS_RESERVED_FLAGS = ["--mcp-config", "--strict-mcp-config", "--settings"];

/** spec t-e2ebe3 — opencode honors this env var pointing at a config file (verified on 1.17.15). Tachyon
 *  owns it for a non-harness opencode spawn (the per-agent Bridge-only file) and rejects an opencode
 *  harness agent that re-declares it (the harness uses XDG_CONFIG_HOME instead). */
const OPENCODE_CONFIG_ENV_VAR = "OPENCODE_CONFIG";

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
  /** spec 377 — enable the canonical, Tachyon-owned per-agent SOUL.md profile. */
  soul?: boolean;
  /** spec 421 — opt in to Tachyon-owned, human-reviewed agent evolution. */
  selfEvolution?: SelfEvolutionDef;
  /** Internal canonical selector. Active bytes still require the host-custodied Evolution head. */
  profileEvolution?: { profileId: string; selectorSha256: string };
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
  /** Internal canonical-profile launch snapshot. It is attached after YAML parsing and is not an accepted config key. */
  profileCapabilities?: ResolvedAgentCapabilityProjection;
  /** Internal canonical-profile lifecycle snapshot. It cannot be authored in tachyon.yml. */
  profileLifecycle?: {
    enabled: boolean;
    agentId: string;
    canonicalSha256: string;
    authorityRevision: string;
  };
  /** Shell-only syntax marker: the stanza is a canonical profile pointer resolved by the engine. */
  profilePointer?: true;
  /** spec 240 — lightweight per-agent isolation of the claude config HOME (its own transcript namespace) WITHOUT
   *  the harness MCP/skills isolation. Lets agents that share a cwd each get an attributable session + activity
   *  log while still loading the workspace project config. Claude/Codex; "transcript" is the only mode in v1. */
  isolate?: "transcript";
  /** spec 352 — config-level ownership edge. Names top-level agent entries owned by this agent;
   *  parsed for display/YAML round-trip only. Runtime lineage keeps using spawn parent. */
  subagents?: string[];
}

/** Closed v1 opt-in. Absence and enabled:false are equivalent disabled states. */
export interface SelfEvolutionDef {
  enabled: boolean;
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

/** POSIX single-quote escaping — safe inside the shell command tmux runs. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function instructionsDeliverable(cmd: string): boolean {
  const capability = openingPromptCapability(cmd);
  return capability.status === "prompt" || capability.status === "native-external";
}

/**
 * spec 232 — register the Tachyon Bridge MCP on a codex command so a codex pipeline node can call the
 * `complete_node` tool. Inserts a `-c` config override right after the codex binary token (seeing through
 * `env X=1` / `npx` launchers), under a COLLISION-SAFE server name (`tachyon_bridge`) so a user's existing
 * `mcp_servers.tachyon` — even an stdio-shaped one — is untouched (a same-name `-c` errors with "url is
 * not supported for stdio"). The bearer token stays in env (spec 351: `TACHYON_AGENT_BRIDGE_TOKEN`, this
 * agent's own minted per-agent token, referenced indirectly via `bearer_token_env_var`) — it is NEVER
 * placed on the command line. No-op for a non-codex command.
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
  const table = `mcp_servers.tachyon_bridge={url="${url}", bearer_token_env_var="TACHYON_AGENT_BRIDGE_TOKEN"}`;
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

/** Additively load Tachyon's immutable Bridge adapter into Pi without touching `.pi` or argv secrets. */
export function piBridgeCmd(cmd: string, extensionPath: string): string {
  const tokens = cmd.trim().split(/\s+/);
  const i = binaryIndex(tokens);
  const base = (tokens[i] ?? "").split("/").pop() ?? "";
  if (base !== "pi") return cmd;
  const re = /\S+/g;
  let count = 0;
  let endOfBinary = cmd.length;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cmd)) !== null) {
    if (count === i) {
      endOfBinary = match.index + match[0].length;
      break;
    }
    count++;
  }
  const injection = ` --extension ${shellQuote(extensionPath)}`;
  if (cmd.slice(endOfBinary).startsWith(injection)) return cmd;
  return `${cmd.slice(0, endOfBinary)}${injection}${cmd.slice(endOfBinary)}`;
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

function shellArgvTokens(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;
  for (const ch of cmd.trim()) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += "\\";
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export function codexFlagCmd(cmd: string, flag: string): string {
  const tokens = shellArgvTokens(cmd);
  const i = binaryIndex(tokens);
  const base = (tokens[i] ?? "").split("/").pop() ?? "";
  if (base !== "codex" || tokens.includes(flag)) return cmd;
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
  return `${cmd.slice(0, endOfBinary)} ${flag}${cmd.slice(endOfBinary)}`;
}

/** The command actually spawned: cmd + instructions arg when the runtime accepts one. */
export function composeCommand(def: Pick<AgentDef, "cmd" | "instructions">): string {
  if (!def.instructions || def.instructions.trim().length === 0) return def.cmd;
  const adapter = runtimePromptAdapter(def.cmd);
  if (!adapter) return def.cmd; // unknown CLI — stored but not delivered (documented)
  // Hermes: brief rides in HERMES_TUI_QUERY (AgentManager), not argv — empty template must not
  // append a trailing space that would look like a malformed subcommand token.
  if (!adapter.compose) return def.cmd;
  const arg = adapter.compose(shellQuote(def.instructions.trim()));
  if (!arg) return def.cmd;
  return `${def.cmd} ${arg}`;
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
  /** spec 352 — derived child-side ownership map from agents.<owner>.subagents. */
  declaredOwner: Record<string, string>;
  settings: {
    maxAgents?: number;
    /**
     * t-0d0152 — opt-in systemd --user scope MemoryMax for each agent spawn tree
     * (e.g. "2G", "512M"). Omitted/off = no wrap. Linux only; fail-open elsewhere.
     */
    agentMemoryMax?: string;
    bridgePort?: number;
    auth?: boolean;
    /** spec 351 — accept the shared/legacy Bridge token as a caller identity (kind "legacy", bypass-
     *  verbatim except claiming a LIVE agent's identity). Default ON for existing workspaces (migration
     *  window); new workspaces should set this OFF once every runtime they use has per-agent tokens. */
    legacyBridgeAuth?: boolean;
    tmux?: Record<string, string>;
    /** spec 210 — global worktree location root + branch-name template ({agent} placeholder); spec 214 — global default verify-gate */
    worktree?: { base?: string; branch?: string; verify?: string };
    /** spec 362/385 — project-owned commands and named-behavior adapter for verify_task. */
    verify?: {
      full?: string;
      typecheck?: string;
      /** Optional argv command that materializes dependencies independently in every BASE/HEAD clone. */
      prepare?: string;
      /** Argv prefix; existing changed paths are appended as option-safe relative args. Omitted means no affected-test tier. */
      affected?: string;
      /** Opt-in adapter for plain behavior identifiers. `cmd:` verifiers do not use this. */
      behavior?: BehaviorVerificationSettings;
    };
    /** spec 383 — explicit project-owned onboarding documents, transported verbatim by Tachyon. */
    projectGuidance?: ProjectGuidanceSettings;
    /** spec 216 — auto re-anchor an agent's role after a detected compaction (OFF by default; risky live injection) */
    anchor?: { auto?: boolean };
    /** spec 216 — append Bridge-coordination guidance to agents spawned via the Bridge (default true) */
    bridgeGuidance?: boolean;
    /** spec 219 — clean clipboard copy: "auto" (default) wires a UTF-8 copy-mode helper; "off" leaves OSC 52 */
    clipboard?: "auto" | "off";
    /** spec 245 — project handoff: canonical file path (RELATIVE to workspace root, default .tachyon/HANDOFF.md)
     *  + the append-note nudge cadence (`off` | an interval like `30m`/`1h`; default `30m`, throttled per-workspace). */
    handoff?: { path?: string; nudgeEvery?: string };
    // t-7bcba6 — settings.persistence (silentHooks kill switch) removed. Silent hooks are always
    // the supported path for eligible agents; obsolete keys are rejected at parse time.
    /**
     * spec 364 — Bridge-client rebind after extension-host reload (MCP half-open recovery).
     * Defaults when absent: auto, graceMs 0, stopTimeoutMs 15000, maxConcurrentRebinds 1, circuitFailCount 3.
     */
    bridgeClientRebind?: {
      onHostGenerationBump?: "auto" | "notify" | "off";
      graceMs?: number;
      stopTimeoutMs?: number;
      maxConcurrentRebinds?: number;
      circuitFailCount?: number;
    };
    /** spec 365 — local GitDelivery lifecycle/hygiene settings. Profiles supply defaults; explicit keys override. */
    /** Linked GitDelivery projection authority. Lifecycle selection is not configurable. */
    gitDelivery?: {
      prunePrincipals?: string[];
      integratePrincipals?: string[];
    };
    /** Shared defaults for human-facing task mutation toasts; explicit VS Code settings override these. */
    taskNotifications?: TaskNotificationSettingsInput;
    /**
     * SDD 414/422 — Companion shells (browser tab tools + mobile via Tailscale).
     * Human opt-in: when tabTools is true, tools are always listed on the Bridge;
     * calls still require a paired Companion device (clear not_paired error otherwise).
     * lanAccess (SDD 422): when true, mobile Companion via Tailscale — Bridge binds 0.0.0.0 so mesh
     * clients can reach /companion/*; pair QR uses Tailscale IP only (not multi-NIC Wi‑Fi).
     * Default false = loopback-only (browser Companion). MCP still requires agent tokens.
     */
    companion?: { tabTools?: boolean; allowedHosts?: string[]; lanAccess?: boolean };
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
  warnings: string[];
}

export const CONFIG_FILENAMES = ["tachyon.yml", "tachyon.yaml"];

const NAME_RE = AGENT_NAME_PATTERN;
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every recognized entry key. `isolate` remains recognized only as a deprecated read-compat key. `kind`/
 *  `instructions` are recognized everywhere (so they're never "unknown"); under `terminals:` they're rejected
 *  explicitly with a clearer message instead. */
const AGENT_KEYS = ["cmd", "cwd", "env", "autostart", "watch", "attention", "restart", "kind", "instructions", "role", "soul", "selfEvolution", "worktree", "branch", "worktreeSetup", "verify", "harness", "isolate", "subagents"];

/** Recognized harness keys (spec 226/228 plus spec 406 Pi resources). */
const HARNESS_KEYS = ["inherit", "mcp", "hooks", "rules", "instructions", "skills", "extensions", "prompts", "themes", "packages"];

/**
 * spec 226/228 — parse + validate an `agents.<name>.harness` block (H4/H7/H9). Fail-closed: only on a
 * claude/codex agent, only `inherit: none|workspace`, MCP env values must be exact `${VAR}` references;
 * rejects a `cmd`/`env` that already owns the harness plumbing. Claude accepts `harness: {}` as the explicit
 * replacement for deprecated `isolate: transcript`: private config home, no custom rules/skills/hooks/MCP.
 * Codex already has a private home by default, so its harness still needs at least one capability.
 * Returns the def or undefined (errors pushed). `cmd`/`env` are the agent's, for the H4 ownership checks.
 */
function parseHarness(name: string, raw: unknown, cmd: string, env: Record<string, string> | undefined, isTerminal: boolean, errors: string[]): HarnessDef | undefined {
  if (isTerminal) {
    errors.push(`agents.${name}: 'harness' applies only to agents (this entry is a terminal — it has no runtime harness)`);
    return undefined;
  }
  const binary = binaryOf(cmd);
  // Harnessable CLIs with a private-home materializer. Pi uses its dedicated resource materializer
  // rather than the generic MCP-oriented ResumeAdapter harness shape (spec 406).
  // Others fail closed (gemini/agy/… have no private-home materializer yet).
  const HARNESS_BINS = new Set(["claude", "codex", "opencode", "grok", "hermes", "pi"]);
  if (!HARNESS_BINS.has(binary)) {
    errors.push(
      `agents.${name}.harness: only supported for claude/codex/opencode/grok/hermes/pi agents (got '${binary || cmd}')`,
    );
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
  // spec 406 — the harness declaration is the sole authority for Pi resources. User-supplied native
  // include or discovery-disable flags could add, remove, or replace part of that exact catalog.
  if (binary === "pi") {
    const parsed = parseLaunchCommand(cmd);
    if (!parsed || !parsed.allWordsLiteral) {
      errors.push(`agents.${name}.harness: Pi resource harness commands must have a structurally literal argv (no shell composition, substitution, expansion, or globbing)`);
      return undefined;
    }
    const tokens = parsed.argv;
    const resourceFlags = [
      "--extension", "-e", "--no-extensions", "-ne",
      "--skill", "--no-skills", "-ns",
      "--prompt-template", "--no-prompt-templates", "-np",
      "--theme", "--no-themes",
    ];
    const conflict = resourceFlags.find((flag) => tokens.some((token) => token === flag || token.startsWith(`${flag}=`)));
    if (conflict) {
      errors.push(`agents.${name}.harness: remove '${conflict}' from cmd — Tachyon manages Pi resource flags for a harness agent`);
      return undefined;
    }
  }
  const ownedEnv =
    binary === "codex"
      ? "CODEX_HOME"
      : binary === "grok"
        ? "GROK_HOME"
        : binary === "hermes"
          ? "HERMES_HOME"
          : binary === "opencode"
            ? undefined
            : "CLAUDE_CONFIG_DIR";
  // spec t-e2ebe3 — opencode's harness redirects XDG_CONFIG/DATA/STATE_HOME and (for a non-harness opencode
  // agent) sets OPENCODE_CONFIG; ALL are Tachyon-owned, so reject a user-declared any of them (H4).
  if (binary === "opencode") {
    const opencodeOwned = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", OPENCODE_CONFIG_ENV_VAR];
    if (env) {
      for (const k of opencodeOwned) {
        if (k in env) {
          errors.push(`agents.${name}.harness: remove 'env.${k}' — Tachyon owns the XDG config/data/state dirs for an opencode harness agent`);
          return undefined;
        }
      }
    }
  } else if (ownedEnv && env && ownedEnv in env) {
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
  const piOnly = ["extensions", "prompts", "themes", "packages"].filter((key) => raw[key] !== undefined);
  if (binary !== "pi" && piOnly.length > 0) {
    errors.push(`agents.${name}.harness: ${piOnly.join(", ")} ${piOnly.length === 1 ? "is a Pi-only resource key" : "are Pi-only resource keys"}`);
  }
  if (binary === "codex") {
    const unsupported = ["rules"].filter((key) => raw[key] !== undefined);
    if (unsupported.length > 0) {
      errors.push(`agents.${name}.harness: codex does not support 'rules'; use 'instructions' for AGENTS.md guidance`);
    }
  } else if (binary === "opencode" || binary === "grok" || binary === "hermes") {
    // opencode/grok/hermes v1 harness: mcp/skills only (no CLAUDE.md `rules` or codex AGENTS.md `instructions`).
    const unsupported = ["rules", "instructions"].filter((key) => raw[key] !== undefined);
    if (unsupported.length > 0) {
      errors.push(
        `agents.${name}.harness: ${binary} does not support 'rules'/'instructions' in v1 (use 'mcp'/'skills')`,
      );
    }
  } else if (binary === "pi") {
    const unsupported = ["mcp", "hooks", "rules", "instructions"].filter((key) => raw[key] !== undefined);
    if (unsupported.length > 0) {
      errors.push(`agents.${name}.harness: pi does not support ${unsupported.join(", ")} (use extensions/skills/prompts/themes/packages)`);
    }
  } else if (raw.instructions !== undefined) {
    errors.push(`agents.${name}.harness.instructions: only supported for codex agents; use 'rules' for claude`);
  }
  let inherit: HarnessDef["inherit"] = "workspace";
  if (raw.inherit !== undefined) {
    if (raw.inherit === "none" || raw.inherit === "workspace") {
      inherit = raw.inherit;
      if (binary === "pi" && raw.inherit === "none") {
        errors.push(`agents.${name}.harness.inherit: pi resource harnesses do not support 'none' (omit inherit or use 'workspace')`);
      }
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
    if (binary === "opencode" || binary === "grok" || binary === "hermes") {
      errors.push(`agents.${name}.harness: ${binary} does not support 'hooks' until a native user-hook materializer exists`);
    } else if (!isPlainObject(raw.hooks) || Object.keys(raw.hooks).length === 0) {
      errors.push(`agents.${name}.harness.hooks: must be a non-empty mapping (the claude settings.json 'hooks' shape)`);
    } else {
      harness.hooks = raw.hooks;
    }
  }

  // spec 228/311/406 — resource paths are a non-empty string or list of non-empty strings. Paths must
  // be workspace-relative (reject absolute / `..` traversal early; materialization also re-checks the
  // resolved real path against the workspace as the fail-closed backstop). Pi additionally rejects URI
  // and SCP-like remote sources: its harness is a local snapshot allowlist, never a package acquisition API.
  type HarnessPathKey = "rules" | "instructions" | "skills" | "extensions" | "prompts" | "themes" | "packages";
  const isContained = (p: string): boolean => !p.startsWith("/") && !p.startsWith("~") && !/(^|[\\/])\.\.([\\/]|$)/.test(p) && !/^[A-Za-z]:[\\/]/.test(p);
  const isRemoteSource = (p: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(p) || /^[^/\\\s]+@[^/\\\s]+:/.test(p);
  const parsePathList = (key: HarnessPathKey): string[] | undefined => {
    const rawVal = raw[key];
    if (rawVal === undefined) return undefined;
    const list = typeof rawVal === "string" ? [rawVal] : rawVal;
    if (!Array.isArray(list) || list.length === 0 || list.some((p) => typeof p !== "string" || p.trim().length === 0)) {
      errors.push(`agents.${name}.harness.${key}: must be a non-empty path or list of non-empty paths`);
      return undefined;
    }
    if ((list as string[]).some((p) => !isContained(p.trim()) || (binary === "pi" && isRemoteSource(p.trim())))) {
      errors.push(`agents.${name}.harness.${key}: paths must be workspace-relative local paths (no absolute paths, '..', URLs, or package specs)`);
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
  if (binary === "pi") {
    const extensions = parsePathList("extensions");
    if (extensions) harness.extensions = extensions;
    const prompts = parsePathList("prompts");
    if (prompts) harness.prompts = prompts;
    const themes = parsePathList("themes");
    if (themes) harness.themes = themes;
    const packages = parsePathList("packages");
    if (packages) harness.packages = packages;
  }

  // At least one capability must actually be ACCEPTED, except for explicit `harness: {}` private-home
  // opt-in (claude isolate-transcript replacement; opencode/grok/hermes private home + Bridge only).
  // Codex and Pi require at least one capability (Codex is already private-home by default; a Pi harness
  // means an exact non-empty resource catalog).
  if (!harness.mcp && !harness.hooks && !harness.rules && !harness.instructions && !harness.skills &&
      !harness.extensions && !harness.prompts && !harness.themes && !harness.packages) {
    if (
      (binary === "claude" || binary === "opencode" || binary === "grok" || binary === "hermes") &&
      Object.keys(raw).length === 0
    ) {
      return harness;
    }
    errors.push(binary === "pi"
      ? `agents.${name}.harness: declare at least one of extensions, skills, prompts, themes, packages`
      : `agents.${name}.harness: declare at least one of mcp, skills, rules, instructions, hooks`);
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
const ISOLATE_TRANSCRIPT_DEPRECATION = "isolate: transcript is deprecated — codex is private-home by default; use harness:{} for a private claude config home";

function parseAgentEntry(section: "agents" | "terminals", name: string, def: Record<string, unknown>, errors: string[], warnings: string[]): AgentDef | null {
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
    if (def.soul !== undefined) errors.push(`terminals.${name}: 'soul' applies only to agents (declare it under agents: with kind: agent)`);
    if (def.selfEvolution !== undefined) errors.push(`terminals.${name}: 'selfEvolution' applies only to agents (declare it under agents: with kind: agent)`);
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
      if (binaryOf(agent.cmd) === "pi") {
        for (const owned of ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]) {
          if (owned in agent.env) {
            errors.push(`${section}.${name}.env: remove '${owned}' — Tachyon owns Pi's private runtime and session homes`);
          }
        }
      }
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
  if (def.soul !== undefined) {
    if (forceTerminal || agent.kind === "terminal") {
      if (!forceTerminal) errors.push(`${section}.${name}: 'soul' applies only to agents (this entry is a terminal — it has no AI identity)`);
    } else if (typeof def.soul !== "boolean") {
      errors.push(`agents.${name}.soul: must be a boolean`);
    } else {
      agent.soul = def.soul;
    }
  }
  if (def.selfEvolution !== undefined) {
    if (forceTerminal || agent.kind === "terminal") {
      if (!forceTerminal) errors.push(`${section}.${name}: 'selfEvolution' applies only to agents (this entry is a terminal — it has no AI to evolve)`);
    } else if (!isPlainObject(def.selfEvolution)) {
      errors.push(`agents.${name}.selfEvolution: must be a mapping with enabled: boolean`);
    } else {
      const evolution = def.selfEvolution;
      if (typeof evolution.enabled !== "boolean") {
        errors.push(`agents.${name}.selfEvolution.enabled: must be a boolean`);
      } else {
        agent.selfEvolution = { enabled: evolution.enabled };
      }
      for (const key of Object.keys(evolution)) {
        if (key !== "enabled") errors.push(`agents.${name}.selfEvolution: unknown key '${key}'`);
      }
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
    // spec 358 phase 2 — read-compat only. New configs should use the two-axis model:
    // transcript isolation is default/private-home where needed, while `harness:` remains the opt-in stronger
    // config/MCP/rules/skills/hooks boundary. Existing `isolate: transcript` must keep loading until maintainers
    // migrate their local secondaries.
    if (def.isolate !== "transcript") {
      errors.push(`${section}.${name}.isolate: deprecated; the only legacy-compatible value is 'transcript'`);
    } else if (forceTerminal || agent.kind === "terminal") {
      errors.push(`${section}.${name}: 'isolate' applies only to agents (this entry is a terminal — it has no transcript)`);
    } else if (binaryOf(agent.cmd) !== "claude" && binaryOf(agent.cmd) !== "codex") {
      errors.push(`agents.${name}.isolate: deprecated legacy mode is only compatible with claude/codex agents (got '${binaryOf(agent.cmd) || agent.cmd}')`);
    } else if (agent.env?.[binaryOf(agent.cmd) === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] !== undefined) {
      const ownedEnv = binaryOf(agent.cmd) === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
      errors.push(`agents.${name}.isolate: remove 'env.${ownedEnv}' — Tachyon owns the config home for this deprecated legacy mode`);
    } else {
      warnings.push(`agents.${name}: ${ISOLATE_TRANSCRIPT_DEPRECATION}`);
      agent.isolate = "transcript";
    }
  }
  if (def.subagents !== undefined) {
    if (forceTerminal || agent.kind === "terminal") {
      errors.push(`${section}.${name}: 'subagents' applies only to agents (this entry is a terminal — ownership can only target agents)`);
    } else if (!Array.isArray(def.subagents) || def.subagents.length === 0 || def.subagents.some((s) => typeof s !== "string" || s.trim().length === 0)) {
      errors.push(`agents.${name}.subagents: must be a non-empty list of agent names`);
    } else {
      agent.subagents = (def.subagents as string[]).map((s) => s.trim());
    }
  }
  // kind/instructions are recognized keys (rejected above for terminals:) so they don't also trip
  // the generic "unknown key" error — only genuinely-unrecognized keys do.
  for (const key of Object.keys(def)) {
    if (!AGENT_KEYS.includes(key)) errors.push(`${section}.${name}: unknown key '${key}'`);
  }
  return agent;
}

/**
 * Build the child→owner map from `agents.*.subagents`.
 *
 * t-099be8 — a *dangling* subagents name (referenced but not declared) is a **warning**, not a fatal
 * error: drop the unknown name, keep the rest of the roster. Hard errors remain for self-ref, terminal
 * targets, multi-owner, cycles, and nested trees (those make ownership unloadable, not merely stale).
 */
function buildDeclaredOwner(
  agents: Record<string, ManagedEntryDef>,
  errors: string[],
  warnings: string[],
): Record<string, string> {
  const declaredOwner: Record<string, string> = {};
  for (const [owner, def] of Object.entries(agents)) {
    if (!def.subagents) continue;
    const kept: string[] = [];
    for (const child of def.subagents) {
      const target = agents[child];
      if (child === owner) {
        errors.push(`agents.${owner}.subagents: '${child}' cannot reference itself`);
        continue;
      }
      if (!target) {
        // Dangling ownership metadata — roster/sidebar only (spec 352). Do not nuke the whole config.
        warnings.push(
          `agents.${owner}.subagents: '${child}' is not declared in agents/terminals — dropped (dangling subagent reference)`,
        );
        continue;
      }
      if (target.kind !== "agent") {
        errors.push(`agents.${owner}.subagents: '${child}' resolves to a terminal; subagents must reference kind: agent entries`);
        continue;
      }
      const existing = declaredOwner[child];
      if (existing && existing !== owner) {
        errors.push(`agents.${owner}.subagents: '${child}' is already declared as a subagent of '${existing}'`);
        continue;
      }
      if (target.subagents?.includes(owner)) {
        errors.push(`agents.${owner}.subagents: '${child}' creates a direct ownership cycle with '${owner}'`);
        continue;
      }
      declaredOwner[child] = owner;
      kept.push(child);
    }
    if (kept.length === 0) delete def.subagents;
    else def.subagents = kept;
  }
  for (const [child, owner] of Object.entries(declaredOwner)) {
    if (agents[child]?.subagents && agents[child].subagents!.length > 0) {
      errors.push(`agents.${owner}.subagents: '${child}' declares its own subagents; nested subagent trees are not supported in v1`);
      delete declaredOwner[child];
    }
  }
  return declaredOwner;
}

/** Validates the parsed YAML by hand — keeps the extension dependency-light; the JSON Schema covers editor-time validation. */
function normalizedArgvCommand(value: unknown, field: string, errors: string[]): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field}: must be a non-empty argv command string`);
    return undefined;
  }
  const normalized = value.trim();
  try {
    parseArgvCommand(normalized);
  } catch (error) {
    errors.push(`${field}: invalid argv command (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
  return normalized;
}

export function parseConfig(yamlText: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    return { errors: [`invalid YAML: ${err instanceof Error ? err.message : String(err)}`], warnings };
  }

  if (!isPlainObject(raw)) {
    return { errors: ["tachyon.yml must be a YAML mapping with at least an 'agents' section"], warnings };
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
      const agent = parseAgentEntry("agents", name, def, errors, warnings);
      if (agent) agents[name] = agent;
    }
    const enabledByFold = new Map<string, string>();
    const evolutionEnabledByFold = new Map<string, string>();
    for (const [name, agent] of Object.entries(agents)) {
      const folded = asciiFoldAgentName(name);
      if (agent.soul === true) {
        const prior = enabledByFold.get(folded);
        if (prior !== undefined) {
          errors.push(`agents.${name}.soul: conflicts with soul-enabled agent '${prior}' after ASCII case folding`);
        } else {
          enabledByFold.set(folded, name);
        }
      }
      if (agent.selfEvolution?.enabled === true) {
        const prior = evolutionEnabledByFold.get(folded);
        if (prior !== undefined) {
          errors.push(`agents.${name}.selfEvolution: conflicts with evolution-enabled agent '${prior}' after ASCII case folding`);
        } else {
          evolutionEnabledByFold.set(folded, name);
        }
      }
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
        const terminal = parseAgentEntry("terminals", name, def, errors, warnings);
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
      if (raw.settings.agentMemoryMax !== undefined) {
        const rawMax = raw.settings.agentMemoryMax;
        if (rawMax === false || rawMax === null || rawMax === "off" || rawMax === "none") {
          // explicit off — leave unset
        } else {
          const parsed = parseAgentMemoryMax(rawMax);
          if (!parsed && rawMax !== "" && rawMax !== 0 && rawMax !== "0") {
            errors.push('settings.agentMemoryMax: must be systemd MemoryMax like "2G", "512M", "50%", or "off"');
          } else if (parsed) {
            settings.agentMemoryMax = parsed;
          }
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
      if (raw.settings.legacyBridgeAuth !== undefined) {
        if (typeof raw.settings.legacyBridgeAuth !== "boolean") {
          errors.push("settings.legacyBridgeAuth: must be a boolean");
        } else {
          settings.legacyBridgeAuth = raw.settings.legacyBridgeAuth;
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
      if (raw.settings.verify !== undefined) {
        if (!isPlainObject(raw.settings.verify)) {
          errors.push("settings.verify: must be a mapping with project-owned verification commands");
        } else {
          const vf = raw.settings.verify;
          const out: NonNullable<TachyonConfig["settings"]["verify"]> = {};
          if (vf.full !== undefined) {
            const command = normalizedArgvCommand(vf.full, "settings.verify.full", errors);
            if (command) out.full = command;
          }
          if (vf.typecheck !== undefined) {
            const command = normalizedArgvCommand(vf.typecheck, "settings.verify.typecheck", errors);
            if (command) out.typecheck = command;
          }
          if (vf.prepare !== undefined) {
            const command = normalizedArgvCommand(vf.prepare, "settings.verify.prepare", errors);
            if (command) out.prepare = command;
          }
          if (vf.affected !== undefined) {
            const command = normalizedArgvCommand(vf.affected, "settings.verify.affected", errors);
            if (command) out.affected = command;
          }
          if (vf.behavior !== undefined) {
            if (!isPlainObject(vf.behavior)) {
              errors.push("settings.verify.behavior: must be a mapping with adapter, command, stubPath, and executorPaths");
            } else {
              const behavior = vf.behavior;
              const errorCountBefore = errors.length;
              for (const key of Object.keys(behavior)) {
                if (!["adapter", "command", "stubPath", "executorPaths"].includes(key)) {
                  errors.push(`settings.verify.behavior: unknown key '${key}'`);
                }
              }
              if (behavior.adapter !== "vitest-name") {
                errors.push("settings.verify.behavior.adapter: must be 'vitest-name'");
              }
              const behaviorCommand = normalizedArgvCommand(
                behavior.command,
                "settings.verify.behavior.command",
                errors,
              );
              if (typeof behavior.stubPath !== "string") {
                errors.push("settings.verify.behavior.stubPath: must be a workspace-relative template containing {agent}");
              } else {
                const pathError = behaviorStubPathTemplateError(behavior.stubPath);
                if (pathError) errors.push(`settings.verify.behavior.stubPath: ${pathError}`);
              }
              const executorPaths: string[] = [];
              if (!Array.isArray(behavior.executorPaths) || behavior.executorPaths.length === 0) {
                errors.push("settings.verify.behavior.executorPaths: must be a non-empty list of tracked workspace-relative paths");
              } else {
                const seen = new Set<string>();
                for (const [index, candidate] of behavior.executorPaths.entries()) {
                  if (typeof candidate !== "string") {
                    errors.push(`settings.verify.behavior.executorPaths[${index}]: must be a workspace-relative path string`);
                    continue;
                  }
                  const pathError = behaviorStubPathError(candidate);
                  if (pathError) {
                    errors.push(`settings.verify.behavior.executorPaths[${index}]: ${pathError}`);
                    continue;
                  }
                  if (seen.has(candidate)) {
                    errors.push(`settings.verify.behavior.executorPaths[${index}]: duplicate path '${candidate}'`);
                    continue;
                  }
                  seen.add(candidate);
                  executorPaths.push(candidate);
                }
              }
              if (errors.length === errorCountBefore) {
                out.behavior = {
                  adapter: "vitest-name",
                  command: behaviorCommand!,
                  stubPath: behavior.stubPath as string,
                  executorPaths,
                };
              }
              if (!out.prepare) {
                errors.push("settings.verify.behavior requires settings.verify.prepare to provision independent BASE/HEAD verifier environments");
              }
            }
          }
          for (const key of Object.keys(vf)) {
            if (!["full", "typecheck", "prepare", "affected", "behavior"].includes(key)) {
              errors.push(`settings.verify: unknown key '${key}'`);
            }
          }
          settings.verify = out;
        }
      }
      if (raw.settings.projectGuidance !== undefined) {
        if (!isPlainObject(raw.settings.projectGuidance)) {
          errors.push("settings.projectGuidance: must be a mapping with a non-empty 'files' list");
        } else {
          const projectGuidance = raw.settings.projectGuidance;
          const errorCountBefore = errors.length;
          for (const key of Object.keys(projectGuidance)) {
            if (key !== "files") errors.push(`settings.projectGuidance: unknown key '${key}'`);
          }

          if (!Array.isArray(projectGuidance.files) || projectGuidance.files.length === 0) {
            errors.push("settings.projectGuidance.files: must be a non-empty list of workspace-relative path strings");
          } else {
            if (projectGuidance.files.length > PROJECT_GUIDANCE_MAX_FILES) {
              errors.push(`settings.projectGuidance.files: must contain at most ${PROJECT_GUIDANCE_MAX_FILES} paths`);
            }
            const files: string[] = [];
            const seen = new Set<string>();
            for (let index = 0; index < projectGuidance.files.length; index++) {
              const rawPath = projectGuidance.files[index];
              if (typeof rawPath !== "string") {
                errors.push(`settings.projectGuidance.files[${index}]: must be a path string`);
                continue;
              }
              if (containsUnsafeFramingCharacter(rawPath)) {
                errors.push(`settings.projectGuidance.files[${index}]: must not contain control characters`);
                continue;
              }
              const sourcePath = rawPath.trim();
              const reason = projectGuidancePathError(sourcePath);
              if (reason) {
                errors.push(`settings.projectGuidance.files[${index}] (${JSON.stringify(sourcePath)}): ${reason}`);
                continue;
              }
              if (seen.has(sourcePath)) {
                errors.push(`settings.projectGuidance.files[${index}]: duplicate path ${JSON.stringify(sourcePath)}`);
                continue;
              }
              seen.add(sourcePath);
              files.push(sourcePath);
            }
            if (errors.length === errorCountBefore) settings.projectGuidance = { files };
          }
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
      if (raw.settings.companion !== undefined) {
        if (!isPlainObject(raw.settings.companion)) {
          errors.push("settings.companion: must be a mapping with 'tabTools'");
        } else {
          const c = raw.settings.companion;
          const out: { tabTools?: boolean; allowedHosts?: string[]; lanAccess?: boolean } = {};
          if (c.tabTools !== undefined) {
            if (typeof c.tabTools !== "boolean") errors.push("settings.companion.tabTools: must be a boolean");
            else out.tabTools = c.tabTools;
          }
          if (c.allowedHosts !== undefined) {
            if (!Array.isArray(c.allowedHosts) || !c.allowedHosts.every((x: unknown) => typeof x === "string")) {
              errors.push("settings.companion.allowedHosts: must be a string array of host globs");
            } else {
              (out as { allowedHosts?: string[] }).allowedHosts = c.allowedHosts as string[];
            }
          }
          if (c.lanAccess !== undefined) {
            if (typeof c.lanAccess !== "boolean") errors.push("settings.companion.lanAccess: must be a boolean");
            else out.lanAccess = c.lanAccess;
          }
          for (const key of Object.keys(c)) {
            if (key !== "tabTools" && key !== "allowedHosts" && key !== "lanAccess") {
              errors.push(`settings.companion: unknown key '${key}'`);
            }
          }
          if (Object.keys(out).length > 0) settings.companion = out;
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
      // t-7bcba6 — reject obsolete persistence kill switch so a false override cannot silently disable hooks.
      if (raw.settings.persistence !== undefined) {
        errors.push(
          "settings.persistence is obsolete: silent hooks are always enabled for eligible declared Claude/Codex agents. Remove settings.persistence (including silentHooks) from tachyon.yml — there is no visible-legacy fallback.",
        );
      }
      // spec 364 — Bridge-client rebind policy (host generation bump after reload).
      if (raw.settings.bridgeClientRebind !== undefined) {
        if (!isPlainObject(raw.settings.bridgeClientRebind)) {
          errors.push("settings.bridgeClientRebind: must be a mapping");
        } else {
          const br = raw.settings.bridgeClientRebind;
          const out: NonNullable<TachyonConfig["settings"]["bridgeClientRebind"]> = {};
          if (br.onHostGenerationBump !== undefined) {
            if (br.onHostGenerationBump !== "auto" && br.onHostGenerationBump !== "notify" && br.onHostGenerationBump !== "off") {
              errors.push("settings.bridgeClientRebind.onHostGenerationBump: must be 'auto', 'notify', or 'off'");
            } else {
              out.onHostGenerationBump = br.onHostGenerationBump;
            }
          }
          if (br.graceMs !== undefined) {
            if (typeof br.graceMs !== "number" || !Number.isFinite(br.graceMs) || br.graceMs < 0 || !Number.isInteger(br.graceMs)) {
              errors.push("settings.bridgeClientRebind.graceMs: must be an integer >= 0");
            } else {
              out.graceMs = br.graceMs;
            }
          }
          if (br.stopTimeoutMs !== undefined) {
            if (typeof br.stopTimeoutMs !== "number" || !Number.isFinite(br.stopTimeoutMs) || br.stopTimeoutMs < 0 || !Number.isInteger(br.stopTimeoutMs)) {
              errors.push("settings.bridgeClientRebind.stopTimeoutMs: must be an integer >= 0");
            } else {
              out.stopTimeoutMs = br.stopTimeoutMs;
            }
          }
          if (br.maxConcurrentRebinds !== undefined) {
            if (typeof br.maxConcurrentRebinds !== "number" || !Number.isInteger(br.maxConcurrentRebinds) || br.maxConcurrentRebinds < 1) {
              errors.push("settings.bridgeClientRebind.maxConcurrentRebinds: must be an integer >= 1");
            } else {
              out.maxConcurrentRebinds = br.maxConcurrentRebinds;
            }
          }
          if (br.circuitFailCount !== undefined) {
            if (typeof br.circuitFailCount !== "number" || !Number.isInteger(br.circuitFailCount) || br.circuitFailCount < 1) {
              errors.push("settings.bridgeClientRebind.circuitFailCount: must be an integer >= 1");
            } else {
              out.circuitFailCount = br.circuitFailCount;
            }
          }
          for (const key of Object.keys(br)) {
            if (!["onHostGenerationBump", "graceMs", "stopTimeoutMs", "maxConcurrentRebinds", "circuitFailCount"].includes(key)) {
              errors.push(`settings.bridgeClientRebind: unknown key '${key}'`);
            }
          }
          if (Object.keys(out).length > 0) settings.bridgeClientRebind = out;
        }
      }
      if (raw.settings.gitDelivery !== undefined) {
        if (!isPlainObject(raw.settings.gitDelivery)) {
          errors.push("settings.gitDelivery: must be a mapping");
        } else {
          const gd = raw.settings.gitDelivery;
          const out: NonNullable<TachyonConfig["settings"]["gitDelivery"]> = {};
          for (const key of ["prunePrincipals", "integratePrincipals"] as const) {
            if (gd[key] !== undefined) {
              if (!Array.isArray(gd[key]) || gd[key].some((v: unknown) => typeof v !== "string" || v.trim().length === 0)) {
                errors.push(`settings.gitDelivery.${key}: must be a list of non-empty agent names`);
              } else {
                out[key] = (gd[key] as string[]).map((v) => v.trim());
              }
            }
          }
          for (const key of Object.keys(gd)) {
            if (!["prunePrincipals", "integratePrincipals"].includes(key)) errors.push(`settings.gitDelivery: unknown key '${key}'`);
          }
          if (Object.keys(out).length > 0) settings.gitDelivery = out;
        }
      }
      if (raw.settings.delivery !== undefined) {
        warnings.push(
          "settings.delivery was ignored because canonical Delivery with mechanism-only handoff is always active; remove settings.delivery from tachyon.yml",
        );
      }
      if (raw.settings.taskNotifications !== undefined) {
        if (!isPlainObject(raw.settings.taskNotifications)) {
          errors.push("settings.taskNotifications: must be a mapping");
        } else {
          const tn = raw.settings.taskNotifications;
          const out: TaskNotificationSettingsInput = {};
          for (const key of ["enabled", "suppressOwnChanges"] as const) {
            if (tn[key] !== undefined) {
              if (typeof tn[key] !== "boolean") errors.push(`settings.taskNotifications.${key}: must be a boolean`);
              else out[key] = tn[key];
            }
          }
          if (tn.events !== undefined) {
            if (!Array.isArray(tn.events) || tn.events.some((event) => typeof event !== "string" || !(TASK_NOTIFICATION_EVENT_IDS as readonly string[]).includes(event))) {
              errors.push(`settings.taskNotifications.events: must be a list containing only ${TASK_NOTIFICATION_EVENT_IDS.join(", ")}`);
            } else {
              out.events = tn.events as TaskNotificationSettingsInput["events"];
            }
          }
          if (tn.dedupeWindowMs !== undefined) {
            if (typeof tn.dedupeWindowMs !== "number" || !Number.isInteger(tn.dedupeWindowMs) || tn.dedupeWindowMs < 0) {
              errors.push("settings.taskNotifications.dedupeWindowMs: must be an integer >= 0");
            } else {
              out.dedupeWindowMs = tn.dedupeWindowMs;
            }
          }
          for (const key of Object.keys(tn)) {
            if (!["enabled", "events", "suppressOwnChanges", "dedupeWindowMs"].includes(key)) errors.push(`settings.taskNotifications: unknown key '${key}'`);
          }
          if (Object.keys(out).length > 0) settings.taskNotifications = out;
        }
      }
      for (const key of Object.keys(raw.settings)) {
        if (!["maxAgents", "agentMemoryMax", "bridgePort", "auth", "legacyBridgeAuth", "layout", "tmux", "worktree", "verify", "projectGuidance", "anchor", "companion", "bridgeGuidance", "clipboard", "handoff", "persistence", "bridgeClientRebind", "gitDelivery", "delivery", "taskNotifications"].includes(key)) errors.push(`settings: unknown key '${key}'`);
      }
    }
  }

  const declaredOwner = buildDeclaredOwner(agents, errors, warnings);
  if (errors.length > 0) return { errors, warnings };
  return { config: { agents, commands, runbooks, schedules, declaredOwner, settings }, errors: [], warnings };
}

export function loadConfigFile(path: string): ParseResult {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (err) {
    return { errors: [`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`], warnings: [] };
  }
  return parseConfig(text);
}

/**
 * t-099be8 — pure validate-before-save gate for proposed tachyon.yml text (Bridge tool / Studio / mutateConfig).
 * Same rules as loadConfigFile; does not touch the filesystem.
 */
export function validateTachyonConfigText(yamlText: string): ParseResult {
  return parseConfig(yamlText);
}
