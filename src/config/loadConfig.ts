import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { parseAgentMemoryMax } from "../agents/agentMemoryScope.js";
import { binaryOf, binaryIndex } from "../resume/adapters.js";
import { TASK_NOTIFICATION_EVENT_IDS, type TaskNotificationSettingsInput } from "../tasks/taskNotificationPolicy.js";
import {
  PROJECT_GUIDANCE_MAX_FILES,
  projectGuidancePathError,
  type ProjectGuidanceSettings,
} from "./projectGuidance.js";
import { openingPromptCapability, resolveBinary } from "../agents/openingPromptCapability.js";
import { AGENT_NAME_PATTERN } from "./nameValidation.js";
import { runtimePromptAdapter } from "../agents/runtimePromptAdapters.js";
import { ATTESTED_RUNTIMES } from "../runtime/attestedRuntimes.js";
import { parseLaunchCommand } from "../runtime/launchPreflight.js";
export { openingPromptCapability, resolveBinary } from "../agents/openingPromptCapability.js";
import { parseCardTemplate, type CardTemplateConfig } from "../sidebar/cardTemplate.js";
import { containsUnsafeFramingCharacter } from "./framingSafety.js";
import { PROJECTED_HOOK_CLASSES as AGENT_HOOK_PROJECTION_CLASSES, type ProjectedHookClass } from "../plugins/agentHookProjection.js";
import type { ResolvedAgentCapabilityProjection } from "./agentProfileResolver.js";
import type { WithheldCapability } from "./withheldCapability.js";
import type { ResolvedAgentNativeConfigProjection } from "./agentNativeConfigPolicy.js";

export interface AttentionDef {
  enabled: boolean;
  silenceSec: number;
  patterns: string[];
}

export const ATTENTION_DEFAULT_SILENCE_SEC = 8;

export type RestartPolicy = "never" | "on-crash";

export type EntryKind = "agent" | "terminal";

/**
 * Attention is on for an agent and off for a terminal (servers, shells and builds are silent by
 * nature). Stated ONCE because three layers depend on the same answer and disagreeing about it is
 * silent: the parser applies it to an entry with no `attention:` key, the Studio form omits the key
 * when the human's choice equals it, and `upsertAgent` must know which boolean an OMITTED key means
 * before it can merge a preserved `silenceSec`/`patterns` back onto it (t-26ba8f).
 */
export function defaultAttentionEnabled(kind: EntryKind): boolean {
  return kind === "agent";
}

/**
 * Binaries that are AI CLIs but that Tachyon does NOT attest — it cannot vouch for their native
 * inputs, so none of them may back a canonical agent. They exist for authoring convenience: the
 * quick-add catalog and the kind suggestion a human sees and can override.
 */
const UNATTESTED_AI_CLIS = [
  "agy",
  "opencode",
  "gemini",
  "aider",
  "goose",
  "amp",
  "cursor-agent",
  "copilot",
  "qwen",
  "hermes",
  "verboo",
];

/**
 * CLIs the authoring surfaces recognize as AI CLIs — attention defaults, quick-add chips and the
 * suggested kind. SDD 478 M1: composed from `ATTESTED_RUNTIMES` rather than restating it, so this
 * list can neither omit an attested runtime nor contradict the attested set. It is a *suggestion*
 * list and never the answer to "is this an Agent" — that answer is an attested runtime
 * (`AttestedRuntime`); see docs/architecture/agent-vs-terminal.md.
 */
export const KNOWN_AI_CLIS: string[] = [...ATTESTED_RUNTIMES, ...UNATTESTED_AI_CLIS];


/**
 * The kind an AUTHORING surface should pre-select for a command a human is typing: a known AI CLI
 * suggests `agent`, everything else (servers, shells, builds) suggests `terminal`.
 *
 * SDD 478 M4 — this is a SUGGESTION and the name now says so. It is not an answer to "what is this
 * entity": that answer is declared and stored, and the persistence boundary reads it back rather
 * than re-deriving it (a change to `KNOWN_AI_CLIS` used to silently reclassify rows already on
 * disk). Never call it where the result is persisted or where an entity is created without a human
 * seeing and being able to override the choice; the remaining such call sites are the Temporary spawn
 * door (M9) and the inline `agents:` kind default (M6), and they are meant to be visible.
 */
export function suggestKindForCommand(cmd: string): EntryKind {
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

/**
 * The process facts an Agent and a Terminal genuinely share: both are supervised processes with a
 * command, a working dir, an environment, a start policy, a watch set and a restart policy.
 * Attention is shared too — pane-watching is runtime-agnostic (SDD 478 § Invariant matrix).
 */
export interface ManagedEntryBase {
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
  autostart: boolean;
  watch: string[];
  attention: AttentionDef;
  restart: RestartPolicy;
}

/**
 * SDD 478 M2 — the Agent arm. Every agent-only capability lives HERE and nowhere else, which is the
 * whole point: `terminal.harness` is a compile error rather than a validator someone must remember
 * to add. Before this split all seventeen fields below were structurally present on every terminal
 * and only five were actually refused; the other twelve (`worktree`, `branch`, `worktreeSetup`,
 * `harness`, `subagents`, and the profile projections) were declarable and silently never
 * read — validation drifting per field, which is why the boundary is a type and not a validator.
 */
export interface AgentEntry extends ManagedEntryBase {
  kind: "agent";
  /** role prompt, delivered as a positional arg on spawn for CLIs that accept one */
  instructions?: string;
  /** spec 210 — run this agent in its own git worktree+branch (opt-in, off by default) */
  worktree?: boolean;
  /** per-agent literal branch name (overrides the global template); authoritatively validated via git check-ref-format at worktree-create */
  branch?: string;
  /** commands run ONCE in the fresh worktree before the agent starts (sequential, stop-on-failure); normalized to a list */
  worktreeSetup?: string[];
  /** spec 226 — isolated harness: agent-scoped MCP/config materialized into a private config home. */
  harness?: HarnessDef;
  /** Internal canonical-profile launch snapshot. It is attached after YAML parsing and is not an accepted config key. */
  profileCapabilities?: ResolvedAgentCapabilityProjection;
  /**
   * t-b0cfd4 — capabilities this agent SELECTED and did not get, by name, with why and the repair.
   *
   * A pin whose bytes changed withholds that one capability and leaves the agent valid; this is what
   * the agent lost, kept next to the agent so the delegated toolkit withholds the same thing and a
   * human surface can name it. Absent when nothing was withheld — the common case is no key at all.
   * Internal, like the other `profile*` projections: it is attached after parsing and is not an
   * accepted config key.
   */
  profileWithheldCapabilities?: WithheldCapability[];
  /** Internal typed native-config projection. Raw runtime config bytes are never carried here. */
  profileNativeConfig?: ResolvedAgentNativeConfigProjection;
  /** Internal canonical-profile lifecycle snapshot. It cannot be authored in tachyon.yml. */
  profileLifecycle?: {
    enabled: boolean;
    agentId: string;
    canonicalSha256: string;
    authorityRevision: string;
  };
  /** Internal marker for a Temporary fork rematerialized from a canonical profile snapshot. */
  profileFork?: true;
  /**
   * Shell-only syntax marker: this name is a canonical profile the engine resolves, not a terminal.
   * t-ae221c moved the fact it reports from a `profile:` pointer in `tachyon.yml` to the presence of
   * `.tachyon/agents/<name>/agent.yml`; the field keeps its name because it means the same thing to
   * every reader of it.
   */
  profilePointer?: true;
  /** spec 240 — lightweight per-agent isolation of the claude config HOME (its own transcript namespace) WITHOUT
   *  the harness MCP/skills isolation. Lets agents that share a cwd each get an attributable session + activity
   *  log while still loading the workspace project config. Claude/Codex; "transcript" is the only mode in v1. */
  isolate?: "transcript";
  /** spec 352 — config-level ownership edge. Names top-level agent entries owned by this agent;
   *  parsed for display/YAML round-trip only. Runtime lineage keeps using spawn parent. */
  subagents?: string[];
}

/**
 * SDD 478 M2 — the Terminal arm: a generic process and deliberately nothing else. There is no
 * `harness`, no `worktree` — not optional, ABSENT. A terminal has no
 * identity, task, memory, model, provider authentication or agent lifecycle, and the type is now
 * what says so.
 */
export interface TerminalEntry extends ManagedEntryBase {
  kind: "terminal";
}

/**
 * A managed entry is an Agent or a Terminal — never one struct with a discriminator and sixteen
 * optional properties. The discriminant is the STORED `kind` literal; no layer may re-derive it
 * from a command string (removing the remaining inference at the persistence and Temporary doors is
 * SDD 478 M4/M9).
 */
export type ManagedEntryDef = AgentEntry | TerminalEntry;

/** Compatibility name for the managed-entry union. Prefer `ManagedEntryDef` in new code;
 *  `AgentDef` remains exported for existing imports and public surfaces. */
export type AgentDef = ManagedEntryDef;

/**
 * SDD 478 — the single narrowing. A caller that wants an agent-only capability asks for the Agent
 * arm and gets `undefined` for a terminal; a caller that forgets does not compile. This replaces
 * asking `kind === "agent"` and then reaching for a field that the answer did not actually grant.
 */
export function asAgent(entry: ManagedEntryDef | null | undefined): AgentEntry | undefined {
  return entry?.kind === "agent" ? entry : undefined;
}

/** Typed views over the compatibility managed-entry map. */
export function agentsOf(config: TachyonConfig | null | undefined): Record<string, AgentEntry> {
  return Object.fromEntries(
    Object.entries(config?.agents ?? {}).filter((entry): entry is [string, AgentEntry] => entry[1].kind === "agent"),
  );
}

export function terminalsOf(config: TachyonConfig | null | undefined): Record<string, TerminalEntry> {
  return Object.fromEntries(
    Object.entries(config?.agents ?? {}).filter((entry): entry is [string, TerminalEntry] => entry[1].kind === "terminal"),
  );
}

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
export function composeCommand(def: Pick<AgentEntry, "cmd" | "instructions">): string {
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

/** t-84f0eb — Grok reads one `--permission-mode` word, so its authored entry stays one word. */
export const GROK_PERMISSION_MODES = ["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"] as const;
/**
 * t-aaa2c6 — measured on `codex-cli 0.146.0` by feeding an invalid value and reading the config
 * parser's own "expected one of" list. These are the CONFIG enums (wider than the CLI flag enums:
 * `-a/--ask-for-approval` offers only untrusted/on-request/never, and `--full-auto` no longer parses
 * at all). `granular` is omitted deliberately: it is a newtype variant that must arrive as a TOML
 * table, so it can never be projected from this scalar key.
 */
export const CODEX_APPROVAL_POLICIES = ["untrusted", "on-failure", "on-request", "never"] as const;
export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
/** t-aaa2c6 — `mcp_servers.<server>.default_tools_approval_mode`, a door of its own (see below). */
export const CODEX_MCP_TOOL_APPROVAL_MODES = ["auto", "prompt", "writes", "approve"] as const;

export type AgentPermissionProjectionEntry =
  | { runtime: "grok"; mode: typeof GROK_PERMISSION_MODES[number] }
  | {
      runtime: "codex";
      approvalPolicy?: typeof CODEX_APPROVAL_POLICIES[number];
      sandboxMode?: typeof CODEX_SANDBOX_MODES[number];
      bridgeToolApproval?: typeof CODEX_MCP_TOOL_APPROVAL_MODES[number];
    };

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
    /**
     * spec 210 — global worktree location root + branch-name template ({agent} placeholder);
     * t-aaad95 — `revealInWorkspace` (default true), migrated
     * from the retired `tachyon.worktrees.revealInWorkspace` VS Code setting.
     */
    worktree?: {
      base?: string;
      branch?: string;
      revealInWorkspace?: boolean;
      shareDependencies?: boolean;
      /** Gitignored directories in the primary checkout to symlink into every isolated worktree. */
      sharedDirectories?: string[];
    };
    /** spec 383 — explicit project-owned onboarding documents, transported verbatim by Tachyon. */
    projectGuidance?: ProjectGuidanceSettings;
    /** spec 216 — append Bridge-coordination guidance to agents spawned via the Bridge (default true) */
    bridgeGuidance?: boolean;
    /**
     * t-09edf2 — the workspace's explicit statement about installed-plugin hooks reaching an agent's own
     * session: plugin name → the class the human assigns it. ONLY `enforcement` is projected, and only on
     * gate events (`PreToolUse`); every other class and every unclassified plugin projects nothing.
     *
     * This key exists because the standing ruling is that an agent in its own worktree inherits workspace
     * configuration only when the human says so. Naming the plugin here IS that statement — which is why
     * absence means "not projected" rather than "projected by default".
     */
    agentHookProjection?: Record<string, ProjectedHookClass>;
    /**
     * t-84f0eb — opt-in permission posture for one named managed agent. Absence projects nothing.
     *
     * t-aaa2c6 — Codex joins with its OWN key set rather than Grok's single `mode`, because its
     * posture is measurably three independent doors (command approval, the write sandbox, and MCP
     * tool approval), not one scalar. Collapsing them into one word is the derivation by analogy
     * this repository keeps paying for.
     */
    agentPermissionProjection?: Record<string, AgentPermissionProjectionEntry>;
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
    /** t-aaad95 — the single authority for human-facing task mutation toasts (the four VS Code keys are gone). */
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
    /**
     * Integrated Browser (Design Mode / ide_browser_*).
     * enabled — GA opt-in for the human surface and call-time execution (default absent = off).
     * Tools always register when the engine wires ideBrowserRequest; disabled/offline fail at call time.
     * homeUrl — workspace default for the globe control.
     */
    ideBrowser?: { enabled?: boolean; homeUrl?: string };
    /**
     * SDD 479 — the sidebar agent card's layout, owned by the project (it travels with the repo).
     *
     * A malformed template is refused WHOLE and recorded in `cardTemplateRefusal` rather than being
     * half-applied: the sidebar renders the DEFAULT card and says why, instead of a layout built from
     * the lines that happened to parse.
     *
     * t-48dd8d — this key used to be the ONE exception to a loader that refused the whole file over
     * any complaint, because bricking a workspace over a cosmetic layout typo was a worse failure
     * than the one being prevented. Every key is treated that way now, so what was an exception is
     * simply the rule; the reason it was carved out first is still worth reading. What stays specific
     * to this key is the refusal TRAVELLING to the sidebar so the fallback can explain itself.
     */
    sidebar?: { cardTemplate?: CardTemplateConfig; cardTemplateRefusal?: string[] };
    /**
     * t-e4f662 — how long something may wait in the Human Inbox before it is MARKED stale.
     *
     * Display only, as ratified: nothing here auto-approves, auto-denies or auto-closes, and an
     * auto-denied approval is a security decision no timer should make (the approvals/validations
     * report, § 5). ONE threshold covers both kinds in v1 — an approval blocks an agent and a
     * validation does not, so they could plausibly differ, but nobody has asked for that and a
     * display-only mark does not earn a doubled config surface. The scalar spelling leaves room: a
     * later mapping can be accepted beside it without changing what a number means.
     */
    humanInbox?: { staleAfterHours?: import("../humanInbox/model.js").StaleAfter };
    /**
     * t-585d5c — how long a parented agent may sit idle before Tachyon nudges its parent.
     *
     * MINUTES, because that is the unit the report speaks in ("10 minutes is too slow for a release
     * cut"). The monitor's own unit is milliseconds; the conversion happens once, at this edge.
     *
     * `"never"` turns the nudge off. Spelled as a word rather than `0` for the reason the sibling
     * `staleAfterHours` already records: `0` reads literally as "nudge immediately", the opposite of
     * the off an author would mean by it, so `0` is refused and pointed at this spelling.
     */
    agentNotifications?: { idleAfterMinutes?: IdleNotifyAfter };
  };
}

/**
 * t-585d5c — minutes of idleness before the parent is nudged, or `"never"` to stop nudging.
 *
 * Deliberately the same shape as `StaleAfter`: one off-vocabulary across the product means someone
 * who has configured either of these already knows how to turn the other off.
 */
export type IdleNotifyAfter = number | "never";

/**
 * Widest idle window accepted, in minutes (7 days).
 *
 * A bound exists because an unbounded number is indistinguishable from a typo: `6000` for `60`
 * silently means the nudge never arrives, which looks like a broken feature rather than a mistyped
 * setting. Past this, `"never"` is what the author actually means, and the refusal says so.
 */
export const MAX_IDLE_NOTIFY_MINUTES = 7 * 24 * 60;

/**
 * t-fe772a — the keys this parser KNOWS, exported because a second door publishes the same list.
 *
 * `package.json` binds `dist/tachyon.schema.json` to `tachyon.yml` through `contributes.yamlValidation`,
 * and that schema closes both levels with `additionalProperties: false`. So every key added here has
 * to be added there too, or the editor marks a file the product accepts — measured 2026-08-10 on the
 * tracked onboarding template itself, where `humanInbox` (t-e4f662) and `agentNotifications`
 * (t-585d5c) both loaded clean and both drew "must NOT have additional properties" on first open.
 *
 * Two literals in two files could not be kept in step by discipline, so the parser reads THIS list
 * and `configSchema.test.ts` compares it to the schema's published properties.
 */
export const KNOWN_TOP_LEVEL_KEYS = ["agents", "terminals", "layouts", "commands", "runbooks", "schedules", "settings"] as const;

/** The `settings:` keys this parser knows, retired-but-still-named ones included. See KNOWN_TOP_LEVEL_KEYS. */
export const KNOWN_SETTINGS_KEYS = [
  "maxAgents", "agentMemoryMax", "bridgePort", "auth", "legacyBridgeAuth", "layout", "tmux", "worktree",
  "projectGuidance", "companion", "ideBrowser", "bridgeGuidance", "agentHookProjection",
  "agentPermissionProjection", "clipboard", "handoff", "persistence", "bridgeClientRebind",
  "gitDelivery", "delivery", "taskNotifications", "sidebar", "humanInbox", "agentNotifications",
] as const;

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
  /**
   * The file could not be loaded AT ALL. t-48dd8d left exactly two: bytes that are not YAML, and a
   * root that is not a mapping. Anything else degrades — `config` is defined whenever this is empty.
   */
  errors: string[];
  /** everything a human should be told about the file: advisory notices AND every discard below. */
  warnings: string[];
  /**
   * t-48dd8d — the subset of `warnings` that names something the parser DROPPED.
   *
   * Reading and writing are different doors and this is what separates them. READING a file a human
   * already wrote must forgive: the key that cannot be read is discarded, its default runs, and the
   * workspace keeps going. WRITING text a program proposed must not — persisting bytes we have just
   * been told are partly unreadable is the delayed detonation the self-edit gate exists to stop
   * (t-099be8), and the decision here was about how the file is READ.
   *
   * Advisory warnings (a deprecation, a retired key accepted and ignored) are NOT here, so they keep
   * travelling with a successful write instead of blocking it.
   */
  discarded: string[];
}

export const CONFIG_FILENAMES = ["tachyon.yml", "tachyon.yaml"];

const NAME_RE = AGENT_NAME_PATTERN;
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every recognized entry key. `isolate` remains recognized only as a deprecated read-compat key. `kind`/
 *  `instructions` are recognized everywhere (so they're never "unknown"); under `terminals:` they're rejected
 *  explicitly with a clearer message instead. */
const AGENT_KEYS = ["cmd", "cwd", "env", "autostart", "watch", "attention", "restart", "kind", "instructions", "worktree", "branch", "worktreeSetup", "harness", "isolate", "subagents"];

/** Recognized harness keys (spec 226/228 plus spec 406 Pi resources). */
const HARNESS_KEYS = ["inherit", "mcp", "hooks", "rules", "instructions", "skills", "extensions", "prompts", "themes", "packages"];

/**
 * spec 226/228 — parse + validate an `agents.<name>.harness` block (H4/H7/H9). Fail-closed: only on a
 * claude/codex agent, only `inherit: none|workspace`, MCP env values must be exact `${VAR}` references;
 * rejects a `cmd`/`env` that already owns the harness plumbing. Claude accepts `harness: {}` as the explicit
 * replacement for deprecated `isolate: transcript`: private config home, no custom rules/skills/hooks/MCP.
 * Codex already has a private home by default, so its harness still needs at least one capability.
 * Returns the def or undefined, with what it dropped pushed onto `discarded`. An agent whose harness
 * comes back undefined is dropped WHOLE by the caller (t-48dd8d): running it without the private
 * config home it asked for would hand it the workspace's own MCP servers and credentials.
 * `cmd`/`env` are the agent's, for the H4 ownership checks.
 */
function parseHarness(section: "agents" | "terminals", name: string, raw: unknown, cmd: string, env: Record<string, string> | undefined, isTerminal: boolean, discarded: string[]): HarnessDef | undefined {
  if (isTerminal) {
    // Prefixed with the REAL section — this used to say `agents.<name>` even for a terminals: entry.
    discarded.push(agentOnlyKeyRefusal(section, name, "harness", "this entry is a terminal — it has no runtime harness"));
    return undefined;
  }
  const binary = binaryOf(cmd);
  // Harnessable CLIs with a private-home materializer. Pi uses its dedicated resource materializer
  // rather than the generic MCP-oriented ResumeAdapter harness shape (spec 406).
  // Others fail closed (gemini/agy/… have no private-home materializer yet).
  const HARNESS_BINS = new Set(["claude", "codex", "opencode", "grok", "hermes", "pi"]);
  if (!HARNESS_BINS.has(binary)) {
    discarded.push(
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
        discarded.push(`agents.${name}.harness: remove '${flag}' from cmd — Tachyon manages MCP config for a harness agent`);
        return undefined;
      }
    }
  }
  // spec 406 — the harness declaration is the sole authority for Pi resources. User-supplied native
  // include or discovery-disable flags could add, remove, or replace part of that exact catalog.
  if (binary === "pi") {
    const parsed = parseLaunchCommand(cmd);
    if (!parsed || !parsed.allWordsLiteral) {
      discarded.push(`agents.${name}.harness: Pi resource harness commands must have a structurally literal argv (no shell composition, substitution, expansion, or globbing)`);
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
      discarded.push(`agents.${name}.harness: remove '${conflict}' from cmd — Tachyon manages Pi resource flags for a harness agent`);
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
          discarded.push(`agents.${name}.harness: remove 'env.${k}' — Tachyon owns the XDG config/data/state dirs for an opencode harness agent`);
          return undefined;
        }
      }
    }
  } else if (ownedEnv && env && ownedEnv in env) {
    discarded.push(`agents.${name}.harness: remove 'env.${ownedEnv}' — Tachyon owns the config home for a harness agent`);
    return undefined;
  }
  if (!isPlainObject(raw)) {
    discarded.push(`agents.${name}.harness: must be a mapping with 'mcp' (and optional 'inherit')`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!HARNESS_KEYS.includes(key)) discarded.push(`agents.${name}.harness: unknown key '${key}'`);
  }
  const piOnly = ["extensions", "prompts", "themes", "packages"].filter((key) => raw[key] !== undefined);
  if (binary !== "pi" && piOnly.length > 0) {
    discarded.push(`agents.${name}.harness: ${piOnly.join(", ")} ${piOnly.length === 1 ? "is a Pi-only resource key" : "are Pi-only resource keys"}`);
  }
  /**
   * t-48dd8d — the keys this runtime cannot honor. They used to be recorded and then stored ANYWAY;
   * while any error refused the whole file that was unobservable, but once a refusal becomes a
   * discard it would materialize a harness carrying a capability the runtime does not support. An
   * unsupported key is dropped, not merely reported.
   */
  const unsupportedKeys = new Set<string>();
  if (binary === "codex") {
    const unsupported = ["rules"].filter((key) => raw[key] !== undefined);
    if (unsupported.length > 0) {
      for (const key of unsupported) unsupportedKeys.add(key);
      discarded.push(`agents.${name}.harness: codex does not support 'rules'; use 'instructions' for AGENTS.md guidance`);
    }
  } else if (binary === "opencode" || binary === "grok" || binary === "hermes") {
    // opencode/grok/hermes v1 harness: mcp/skills only (no CLAUDE.md `rules` or codex AGENTS.md `instructions`).
    const unsupported = ["rules", "instructions"].filter((key) => raw[key] !== undefined);
    if (unsupported.length > 0) {
      for (const key of unsupported) unsupportedKeys.add(key);
      discarded.push(
        `agents.${name}.harness: ${binary} does not support 'rules'/'instructions' in v1 (use 'mcp'/'skills')`,
      );
    }
  } else if (binary === "pi") {
    const unsupported = ["mcp", "hooks", "rules", "instructions"].filter((key) => raw[key] !== undefined);
    if (unsupported.length > 0) {
      for (const key of unsupported) unsupportedKeys.add(key);
      discarded.push(`agents.${name}.harness: pi does not support ${unsupported.join(", ")} (use extensions/skills/prompts/themes/packages)`);
    }
  } else if (raw.instructions !== undefined) {
    unsupportedKeys.add("instructions");
    discarded.push(`agents.${name}.harness.instructions: only supported for codex agents; use 'rules' for claude`);
  }
  let inherit: HarnessDef["inherit"] = "workspace";
  if (raw.inherit !== undefined) {
    if (raw.inherit === "none" || raw.inherit === "workspace") {
      if (binary === "pi" && raw.inherit === "none") {
        discarded.push(`agents.${name}.harness.inherit: pi resource harnesses do not support 'none' (omit inherit or use 'workspace')`);
        inherit = "workspace";
      } else {
        inherit = raw.inherit;
      }
    } else if (raw.inherit === "global") {
      discarded.push(`agents.${name}.harness.inherit: 'global' is not supported yet (use 'none' or 'workspace')`);
    } else {
      discarded.push(`agents.${name}.harness.inherit: must be 'none' or 'workspace'`);
    }
  }
  const harness: HarnessDef = { inherit };

  // mcp (optional) — stdio servers; each env value must be an exact ${VAR} reference (H7).
  if (raw.mcp !== undefined && !unsupportedKeys.has("mcp")) {
    if (!isPlainObject(raw.mcp) || Object.keys(raw.mcp).length === 0) {
      discarded.push(`agents.${name}.harness.mcp: must be a non-empty mapping of server name -> definition`);
    } else {
      const mcp: Record<string, HarnessMcpServer> = {};
      for (const [server, sdef] of Object.entries(raw.mcp)) {
        if (!NAME_RE.test(server)) {
          discarded.push(`agents.${name}.harness.mcp.${server}: invalid server name (must match ${NAME_RE})`);
          continue;
        }
        if (server === "tachyon" || server === "tachyon_bridge") {
          discarded.push(`agents.${name}.harness.mcp.${server}: '${server}' is reserved for the Tachyon Bridge (injected automatically); use a different name`);
          continue;
        }
        if (!isPlainObject(sdef) || typeof sdef.command !== "string" || sdef.command.trim().length === 0) {
          discarded.push(`agents.${name}.harness.mcp.${server}: must be a mapping with a non-empty 'command' (stdio servers only)`);
          continue;
        }
        const server_def: HarnessMcpServer = { command: sdef.command };
        if (sdef.args !== undefined) {
          if (!Array.isArray(sdef.args) || sdef.args.some((a) => typeof a !== "string")) {
            discarded.push(`agents.${name}.harness.mcp.${server}.args: must be a list of strings`);
            continue;
          }
          server_def.args = sdef.args as string[];
        }
        if (sdef.env !== undefined) {
          if (!isPlainObject(sdef.env) || Object.values(sdef.env).some((v) => typeof v !== "string")) {
            discarded.push(`agents.${name}.harness.mcp.${server}.env: must be a mapping of string -> string`);
            continue;
          }
          const senv: Record<string, string> = {};
          let bad = false;
          for (const [k, v] of Object.entries(sdef.env as Record<string, string>)) {
            if (!ENV_REF_RE.test(v)) {
              discarded.push(`agents.${name}.harness.mcp.${server}.env.${k}: must be an exact \${VAR} reference (a literal value would write a secret to disk)`);
              bad = true;
              continue;
            }
            if (binary === "codex" && v !== `\${${k}}`) {
              discarded.push(`agents.${name}.harness.mcp.${server}.env.${k}: codex requires the env key to match its reference ('\${${k}}')`);
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
            discarded.push(`agents.${name}.harness.mcp.${server}: unknown key '${key}' (stdio command/args/env; url/headers is a follow pass)`);
          }
        }
        mcp[server] = server_def;
      }
      if (Object.keys(mcp).length > 0) harness.mcp = mcp;
    }
  }

  // spec 228 — hooks (a claude settings.json `hooks` object; shape pass-through, claude validates contents)
  if (raw.hooks !== undefined && !unsupportedKeys.has("hooks")) {
    if (binary === "opencode" || binary === "grok" || binary === "hermes") {
      discarded.push(`agents.${name}.harness: ${binary} does not support 'hooks' until a native user-hook materializer exists`);
    } else if (!isPlainObject(raw.hooks) || Object.keys(raw.hooks).length === 0) {
      discarded.push(`agents.${name}.harness.hooks: must be a non-empty mapping (the claude settings.json 'hooks' shape)`);
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
    if (rawVal === undefined || unsupportedKeys.has(key)) return undefined;
    const list = typeof rawVal === "string" ? [rawVal] : rawVal;
    if (!Array.isArray(list) || list.length === 0 || list.some((p) => typeof p !== "string" || p.trim().length === 0)) {
      discarded.push(`agents.${name}.harness.${key}: must be a non-empty path or list of non-empty paths`);
      return undefined;
    }
    if ((list as string[]).some((p) => !isContained(p.trim()) || (binary === "pi" && isRemoteSource(p.trim())))) {
      discarded.push(`agents.${name}.harness.${key}: paths must be workspace-relative local paths (no absolute paths, '..', URLs, or package specs)`);
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
    discarded.push(binary === "pi"
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

/**
 * SDD 478 M6 — the refusal text is part of the contract. Every agent-only key declared on a terminal
 * is refused with the SAME ending, and that ending names where the entry belongs: the entire cost of
 * the `t-9418ac` incident was three increments spent discovering WHICH block an entry belonged in.
 *
 * The old ending — "declare it under agents: with kind: agent" — was worse than silence, because it
 * pointed at a shape the product refuses: an `agents:` entry is a canonical profile pointer, and an
 * inline definition there is rejected outright.
 */
const MOVE_TO_AN_AGENT = "create it as an agent in Agent Studio (an agents: entry is a canonical profile pointer), or drop the key to keep this a terminal";

function agentOnlyKeyRefusal(section: "agents" | "terminals", name: string, key: string, why: string): string {
  return `${section}.${name}: '${key}' applies only to agents (${why}) — ${MOVE_TO_AN_AGENT}`;
}

function parseAgentEntry(section: "agents" | "terminals", name: string, def: Record<string, unknown>, discarded: string[], warnings: string[]): AgentDef | null {
  const forceTerminal = section === "terminals";
  if (typeof def.cmd !== "string" || def.cmd.trim().length === 0) {
    discarded.push(`${section}.${name}.cmd: required non-empty string`);
    return null;
  }
  const agent: AgentDef = {
    cmd: def.cmd,
    autostart: false,
    watch: [],
    attention: { enabled: true, silenceSec: ATTENTION_DEFAULT_SILENCE_SEC, patterns: [] },
    restart: "never",
    kind: forceTerminal ? "terminal" : suggestKindForCommand(def.cmd),
  };
  if (forceTerminal) {
    if (def.kind !== undefined) discarded.push(`terminals.${name}: remove 'kind' — entries under terminals: are always terminals`);
    if (def.instructions !== undefined) discarded.push(agentOnlyKeyRefusal(section, name, "instructions", "a terminal receives no brief"));
  } else if (def.kind !== undefined) {
    if (def.kind !== "agent" && def.kind !== "terminal") discarded.push(`agents.${name}.kind: must be 'agent' or 'terminal'`);
    else agent.kind = def.kind;
  }
  // SDD 478 M2 — the kind is settled above and does not change below, so this is the entry's single
  // narrowing: every agent-only key is written through it, and a terminal has nowhere to put one.
  // Where the parser already REFUSES a key for a terminal it keeps doing so; the twelve keys that
  // were merely unread on a terminal are now dropped instead of stored. Turning those drops into
  // refusals that name the block to move to is M6.
  const agentEntry = asAgent(agent);
  if (def.cwd !== undefined) {
    if (typeof def.cwd !== "string") discarded.push(`${section}.${name}.cwd: must be a string`);
    else agent.cwd = def.cwd;
  }
  if (def.env !== undefined) {
    if (!isPlainObject(def.env) || Object.values(def.env).some((v) => typeof v !== "string")) {
      discarded.push(`${section}.${name}.env: must be a mapping of string -> string`);
    } else {
      agent.env = def.env as Record<string, string>;
      if (binaryOf(agent.cmd) === "pi") {
        for (const owned of ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]) {
          if (owned in agent.env) {
            discarded.push(`${section}.${name}.env: remove '${owned}' — Tachyon owns Pi's private runtime and session homes`);
          }
        }
      }
    }
  }
  if (def.autostart !== undefined) {
    if (typeof def.autostart !== "boolean") discarded.push(`${section}.${name}.autostart: must be a boolean`);
    else agent.autostart = def.autostart;
  }
  if (def.watch !== undefined) {
    const globs = typeof def.watch === "string" ? [def.watch] : def.watch;
    if (!Array.isArray(globs) || globs.length === 0 || globs.some((g) => typeof g !== "string" || g.length === 0)) {
      discarded.push(`${section}.${name}.watch: must be a non-empty glob string or list of globs`);
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
        if (typeof att.enabled !== "boolean") discarded.push(`${section}.${name}.attention.enabled: must be a boolean`);
        else agent.attention.enabled = att.enabled;
      }
      if (att.silenceSec !== undefined) {
        if (typeof att.silenceSec !== "number" || !Number.isInteger(att.silenceSec) || att.silenceSec < 1) {
          discarded.push(`${section}.${name}.attention.silenceSec: must be an integer >= 1`);
        } else {
          agent.attention.silenceSec = att.silenceSec;
        }
      }
      if (att.patterns !== undefined) {
        if (!Array.isArray(att.patterns) || att.patterns.some((p) => typeof p !== "string" || p.length === 0)) {
          discarded.push(`${section}.${name}.attention.patterns: must be a list of non-empty regex strings`);
        } else {
          agent.attention.patterns = att.patterns as string[];
        }
      }
      for (const key of Object.keys(att)) {
        if (!["enabled", "silenceSec", "patterns"].includes(key)) {
          discarded.push(`${section}.${name}.attention: unknown key '${key}'`);
        }
      }
    } else {
      discarded.push(`${section}.${name}.attention: must be a boolean or a mapping`);
    }
  } else {
    // No `attention:` key — the entry's kind decides, through the one statement of that rule.
    agent.attention.enabled = defaultAttentionEnabled(agent.kind);
  }
  if (!forceTerminal && def.instructions !== undefined) {
    if (typeof def.instructions !== "string") {
      discarded.push(`agents.${name}.instructions: must be a string`);
    } else if (agentEntry && def.instructions.trim().length > 0) {
      agentEntry.instructions = def.instructions;
    }
  }
  if (def.restart !== undefined) {
    if (def.restart !== "never" && def.restart !== "on-crash") {
      discarded.push(`${section}.${name}.restart: must be 'never' or 'on-crash'`);
    } else {
      agent.restart = def.restart;
    }
  }
  if (def.worktree !== undefined) {
    if (typeof def.worktree !== "boolean") discarded.push(`${section}.${name}.worktree: must be a boolean`);
    else if (agentEntry) agentEntry.worktree = def.worktree;
    else discarded.push(agentOnlyKeyRefusal(section, name, "worktree", "this entry is a terminal — it gets no git worktree"));
  }
  if (def.branch !== undefined) {
    if (typeof def.branch !== "string") {
      discarded.push(`${section}.${name}.branch: must be a string`);
    } else {
      const bad = validateBranchLiteral(def.branch);
      if (bad) discarded.push(`${section}.${name}.branch: ${bad}`);
      else if (agentEntry) agentEntry.branch = def.branch;
      else discarded.push(agentOnlyKeyRefusal(section, name, "branch", "this entry is a terminal — it gets no worktree branch"));
    }
  }
  if (def.worktreeSetup !== undefined) {
    const list = typeof def.worktreeSetup === "string" ? [def.worktreeSetup] : def.worktreeSetup;
    if (!Array.isArray(list) || list.length === 0 || list.some((c) => typeof c !== "string" || c.trim().length === 0)) {
      discarded.push(`${section}.${name}.worktreeSetup: must be a non-empty command string or list of non-empty command strings`);
    } else if (agentEntry) {
      agentEntry.worktreeSetup = list as string[];
    } else {
      discarded.push(agentOnlyKeyRefusal(section, name, "worktreeSetup", "this entry is a terminal — it gets no worktree to set up"));
    }
  }
  if (def.harness !== undefined) {
    const harness = parseHarness(section, name, def.harness, agent.cmd, agent.env, forceTerminal || agent.kind === "terminal", discarded);
    if (harness && agentEntry) agentEntry.harness = harness;
  }
  if (def.isolate !== undefined) {
    // spec 358 phase 2 — read-compat only. New configs should use the two-axis model:
    // transcript isolation is default/private-home where needed, while `harness:` remains the opt-in stronger
    // config/MCP/rules/skills/hooks boundary. Existing `isolate: transcript` must keep loading until maintainers
    // migrate their local secondaries.
    if (def.isolate !== "transcript") {
      discarded.push(`${section}.${name}.isolate: deprecated; the only legacy-compatible value is 'transcript'`);
    } else if (forceTerminal || agent.kind === "terminal") {
      discarded.push(agentOnlyKeyRefusal(section, name, "isolate", "this entry is a terminal — it has no transcript"));
    } else if (binaryOf(agent.cmd) !== "claude" && binaryOf(agent.cmd) !== "codex") {
      discarded.push(`agents.${name}.isolate: deprecated legacy mode is only compatible with claude/codex agents (got '${binaryOf(agent.cmd) || agent.cmd}')`);
    } else if (agent.env?.[binaryOf(agent.cmd) === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] !== undefined) {
      const ownedEnv = binaryOf(agent.cmd) === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
      discarded.push(`agents.${name}.isolate: remove 'env.${ownedEnv}' — Tachyon owns the config home for this deprecated legacy mode`);
    } else {
      warnings.push(`agents.${name}: ${ISOLATE_TRANSCRIPT_DEPRECATION}`);
      agent.isolate = "transcript";
    }
  }
  if (def.subagents !== undefined) {
    if (forceTerminal || agent.kind === "terminal") {
      discarded.push(agentOnlyKeyRefusal(section, name, "subagents", "this entry is a terminal — ownership can only target agents"));
    } else if (!Array.isArray(def.subagents) || def.subagents.length === 0 || def.subagents.some((s) => typeof s !== "string" || s.trim().length === 0)) {
      discarded.push(`agents.${name}.subagents: must be a non-empty list of agent names`);
    } else {
      agent.subagents = (def.subagents as string[]).map((s) => s.trim());
    }
  }
  // kind/instructions are recognized keys (rejected above for terminals:) so they don't also trip
  // the generic "unknown key" error — only genuinely-unrecognized keys do.
  for (const key of Object.keys(def)) {
    if (!AGENT_KEYS.includes(key)) discarded.push(`${section}.${name}: unknown key '${key}'`);
  }
  return agent;
}

/**
 * Build the child→owner map from `agents.*.subagents`.
 *
 * t-099be8 — a *dangling* subagents name (referenced but not declared) is a warning, not a fatal
 * error: drop the unknown name, keep the rest of the roster.
 *
 * t-48dd8d — the remaining cases (self-ref, terminal targets, multi-owner, cycles, nested trees) now
 * behave the same way, because that is the file-wide rule. They already dropped only the offending
 * EDGE; what changed is that they no longer take the file with them. Ownership metadata is display
 * and lineage only, so a dropped edge leaves a roster that is stale in one direction and never one
 * that grants an agent authority the file did not give it.
 */
function buildDeclaredOwner(
  agents: Record<string, ManagedEntryDef>,
  discarded: string[],
  warnings: string[],
): Record<string, string> {
  const declaredOwner: Record<string, string> = {};
  for (const [owner, entry] of Object.entries(agents)) {
    // Ownership is an Agent capability on both ends: only an agent can declare subagents, and the
    // terminal case below is a refusal rather than a lookup miss.
    const def = asAgent(entry);
    if (!def?.subagents) continue;
    const kept: string[] = [];
    for (const child of def.subagents) {
      const target = agents[child];
      if (child === owner) {
        discarded.push(`agents.${owner}.subagents: '${child}' cannot reference itself`);
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
        discarded.push(`agents.${owner}.subagents: '${child}' resolves to a terminal; subagents must reference kind: agent entries`);
        continue;
      }
      const existing = declaredOwner[child];
      if (existing && existing !== owner) {
        discarded.push(`agents.${owner}.subagents: '${child}' is already declared as a subagent of '${existing}'`);
        continue;
      }
      if (asAgent(target)?.subagents?.includes(owner)) {
        discarded.push(`agents.${owner}.subagents: '${child}' creates a direct ownership cycle with '${owner}'`);
        continue;
      }
      declaredOwner[child] = owner;
      kept.push(child);
    }
    if (kept.length === 0) delete def.subagents;
    else def.subagents = kept;
  }
  for (const [child, owner] of Object.entries(declaredOwner)) {
    if ((asAgent(agents[child])?.subagents?.length ?? 0) > 0) {
      discarded.push(`agents.${owner}.subagents: '${child}' declares its own subagents; nested subagent trees are not supported in v1`);
      delete declaredOwner[child];
    }
  }
  return declaredOwner;
}

export function parseConfig(yamlText: string): ParseResult {
  /**
   * t-48dd8d — every message collected here names something the parser DROPPED, not a reason to
   * refuse the file. It used to be `errors`, and a non-empty `errors` meant no `config` at all: one
   * mistyped letter anywhere took the whole workspace down to its degraded roster. The owner's
   * decision on 2026-08-07 is that the file warns instead — the wrong or unrecognized part goes, the
   * rest loads.
   *
   * Nothing about HOW the body validates had to change for that, which is the point: every push here
   * already sits next to an `else` that does not store the value, or a `continue` that skips the
   * entry. The sanitized config was always being built alongside the complaints; the only thing that
   * threw it away was the return at the bottom.
   *
   * The rule has NO exception. A discarded key whose default exists simply gets its default; one
   * without a default is only reported. Nothing here changes the state of a door because something
   * else in the file was unreadable — not even the agent permission line, and the owner chose that
   * with the measurement in front of him: a mistyped `sandboxMode` on a delegated codex agent falls
   * to the class default, which is `danger-full-access`. The warning names it and the human fixes it.
   * A rule with one special case is a rule that rots. The full survey of which way every `settings:`
   * key falls when discarded is measured and kept in the t-48dd8d journal.
   */
  const discarded: string[] = [];
  const warnings: string[] = [];

  // The two failures that survive as failures, because neither leaves anything to salvage: bytes that
  // are not YAML, and a document that is not a mapping. There is no "rest of the file" to keep.
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    return { errors: [`invalid YAML: ${err instanceof Error ? err.message : String(err)}`], warnings, discarded: [] };
  }

  if (!isPlainObject(raw)) {
    return { errors: ["tachyon.yml must be a YAML mapping"], warnings, discarded: [] };
  }


  for (const key of Object.keys(raw)) {
    if (!(KNOWN_TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      discarded.push(`unknown top-level key '${key}' (expected ${KNOWN_TOP_LEVEL_KEYS.join(", ")})`);
    }
  }

  // spec 215 — agents: and terminals: merge into ONE kind-tagged record (the engine's single
  // source of truth). t-f67185 — an empty roster is valid: Board, pins, plugins, and commands-only
  // workspaces do not need a declared agent or terminal. Malformed blocks still refuse.
  const agents: Record<string, ManagedEntryDef> = {};
  if (raw.agents !== undefined && !isPlainObject(raw.agents)) {
    discarded.push("'agents' must be a mapping of agent name -> definition");
  }
  if (isPlainObject(raw.agents)) {
    for (const [name, def] of Object.entries(raw.agents)) {
      if (!NAME_RE.test(name)) {
        discarded.push(`agents.${name}: invalid name (must match ${NAME_RE})`);
        continue;
      }
      if (!isPlainObject(def)) {
        discarded.push(`agents.${name}: must be a mapping with at least 'cmd'`);
        continue;
      }
      const agent = parseAgentEntry("agents", name, def, discarded, warnings);
      if (agent) agents[name] = agent;
    }
  }

  if (raw.terminals !== undefined) {
    if (!isPlainObject(raw.terminals)) {
      discarded.push("'terminals' must be a mapping of terminal name -> definition");
    } else {
      for (const [name, def] of Object.entries(raw.terminals)) {
        if (!NAME_RE.test(name)) {
          discarded.push(`terminals.${name}: invalid name (must match ${NAME_RE})`);
          continue;
        }
        if (!isPlainObject(def)) {
          discarded.push(`terminals.${name}: must be a mapping with at least 'cmd'`);
          continue;
        }
        if (name in agents) {
          // t-48dd8d — BOTH entries go. Keeping the `agents:` one would resolve the ambiguity toward
          // the more capable entity: someone who meant a plain process would silently get an agent,
          // with a worktree, a harness and an AI. One name cannot name two things, so it names none.
          delete agents[name];
          discarded.push(
            `terminals.${name}: name already declared under agents: — agents and terminals share one namespace, ` +
            `so BOTH entries were dropped rather than guessing which one was meant`,
          );
          continue;
        }
        const terminal = parseAgentEntry("terminals", name, def, discarded, warnings);
        if (terminal) agents[name] = terminal;
      }
    }
  }

  // spec 234 — layouts: is recognized (allowed-keys list) but no longer parsed/validated (feature retired).

  const commands: Record<string, CommandDef> = {};
  if (raw.commands !== undefined) {
    if (!isPlainObject(raw.commands)) {
      discarded.push("'commands' must be a mapping of command name -> definition");
    } else {
      for (const [name, def] of Object.entries(raw.commands)) {
        if (!NAME_RE.test(name)) {
          discarded.push(`commands.${name}: invalid name (must match ${NAME_RE})`);
          continue;
        }
        if (!isPlainObject(def) || typeof def.cmd !== "string" || def.cmd.trim().length === 0) {
          discarded.push(`commands.${name}: must be a mapping with a non-empty 'cmd'`);
          continue;
        }
        const command: CommandDef = { cmd: def.cmd };
        if (def.cwd !== undefined) {
          if (typeof def.cwd !== "string") discarded.push(`commands.${name}.cwd: must be a string`);
          else command.cwd = def.cwd;
        }
        if (def.env !== undefined) {
          if (!isPlainObject(def.env) || Object.values(def.env).some((v) => typeof v !== "string")) {
            discarded.push(`commands.${name}.env: must be a mapping of string -> string`);
          } else {
            command.env = def.env as Record<string, string>;
          }
        }
        for (const key of Object.keys(def)) {
          if (!["cmd", "cwd", "env"].includes(key)) discarded.push(`commands.${name}: unknown key '${key}'`);
        }
        commands[name] = command;
      }
    }
  }

  const runbooks: Record<string, RunbookDef> = {};
  if (raw.runbooks !== undefined) {
    if (!isPlainObject(raw.runbooks)) {
      discarded.push("'runbooks' must be a mapping of runbook name -> definition");
    } else {
      for (const [name, def] of Object.entries(raw.runbooks)) {
        if (!NAME_RE.test(name)) {
          discarded.push(`runbooks.${name}: invalid name (must match ${NAME_RE})`);
          continue;
        }
        if (
          !isPlainObject(def) ||
          !Array.isArray(def.steps) ||
          def.steps.length === 0 ||
          def.steps.some((st) => typeof st !== "string" || st.trim().length === 0)
        ) {
          discarded.push(`runbooks.${name}: must declare a non-empty 'steps' list of strings`);
          continue;
        }
        for (const key of Object.keys(def)) {
          if (key !== "steps") discarded.push(`runbooks.${name}: unknown key '${key}'`);
        }
        runbooks[name] = { steps: def.steps as string[] };
      }
    }
  }

  const schedules: Record<string, ScheduleDef> = {};
  if (raw.schedules !== undefined) {
    if (!isPlainObject(raw.schedules)) {
      discarded.push("'schedules' must be a mapping of schedule name -> definition");
    } else {
      for (const [name, def] of Object.entries(raw.schedules)) {
        if (!NAME_RE.test(name)) {
          discarded.push(`schedules.${name}: invalid name (must match ${NAME_RE})`);
          continue;
        }
        if (!isPlainObject(def)) {
          discarded.push(`schedules.${name}: must be a mapping`);
          continue;
        }
        for (const key of Object.keys(def)) {
          if (!["every", "at", "run", "spawn", "instructions", "catchUp"].includes(key)) {
            discarded.push(`schedules.${name}: unknown key '${key}'`);
          }
        }
        const hasEvery = def.every !== undefined;
        const hasAt = def.at !== undefined;
        if (hasEvery === hasAt) {
          discarded.push(`schedules.${name}: exactly one of 'every' or 'at' is required`);
          continue;
        }
        if (hasEvery && (typeof def.every !== "string" || parseEvery(def.every) === null)) {
          discarded.push(`schedules.${name}.every: must be like '30m', '1h', '2h'`);
          continue;
        }
        if (hasAt && (typeof def.at !== "string" || parseAt(def.at) === null)) {
          discarded.push(`schedules.${name}.at: must be 'HH:MM' (24h)`);
          continue;
        }
        const hasRun = def.run !== undefined;
        const hasSpawn = def.spawn !== undefined;
        if (hasRun === hasSpawn) {
          discarded.push(`schedules.${name}: exactly one of 'run' or 'spawn' is required`);
          continue;
        }
        if (hasRun) {
          if (typeof def.run !== "string" || (!(def.run in commands) && !(def.run in runbooks))) {
            discarded.push(`schedules.${name}.run: must reference a declared command or runbook`);
            continue;
          }
        }
        if (hasSpawn && (typeof def.spawn !== "string" || !(def.spawn in agents))) {
          discarded.push(`schedules.${name}.spawn: must reference a declared agent`);
          continue;
        }
        if (def.instructions !== undefined && (typeof def.instructions !== "string" || !hasSpawn)) {
          discarded.push(`schedules.${name}.instructions: only valid with 'spawn' and must be a string`);
          continue;
        }
        if (def.catchUp !== undefined && typeof def.catchUp !== "boolean") {
          discarded.push(`schedules.${name}.catchUp: must be a boolean`);
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
      discarded.push("'settings' must be a mapping");
    } else {
      if (raw.settings.maxAgents !== undefined) {
        const n = raw.settings.maxAgents;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
          discarded.push("settings.maxAgents: must be an integer >= 1");
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
            discarded.push('settings.agentMemoryMax: must be systemd MemoryMax like "2G", "512M", "50%", or "off"');
          } else if (parsed) {
            settings.agentMemoryMax = parsed;
          }
        }
      }
      if (raw.settings.bridgePort !== undefined) {
        const n = raw.settings.bridgePort;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1024 || n > 65535) {
          discarded.push("settings.bridgePort: must be an integer between 1024 and 65535");
        } else {
          settings.bridgePort = n;
        }
      }
      // spec 234 — settings.layout is recognized but ignored (layouts feature retired; no error on a legacy value).
      if (raw.settings.auth !== undefined) {
        if (typeof raw.settings.auth !== "boolean") {
          discarded.push("settings.auth: must be a boolean");
        } else {
          settings.auth = raw.settings.auth;
        }
      }
      if (raw.settings.legacyBridgeAuth !== undefined) {
        if (typeof raw.settings.legacyBridgeAuth !== "boolean") {
          discarded.push("settings.legacyBridgeAuth: must be a boolean");
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
          discarded.push("settings.tmux: must be a mapping of tmux option -> value");
        } else {
          const tmux: Record<string, string> = {};
          for (const [k, v] of Object.entries(raw.settings.tmux)) {
            if (!/^[a-z][a-z0-9-]*$/.test(k)) {
              discarded.push(`settings.tmux: invalid option name '${k}' (lowercase letters, digits, '-')`);
              continue;
            }
            if (k === "remain-on-exit") {
              discarded.push("settings.tmux: 'remain-on-exit' is reserved by Tachyon (crash detection depends on it)");
              continue;
            }
            // t-9713ff — tmux defaults `exit-empty` to `on`, which lets a server end itself the moment
            // it holds no sessions. One server hosts the whole fleet here, so that arithmetic must not
            // be reachable from a workspace file. Reserved for the same reason as the line above: the
            // option is not a preference, it is a promise other code depends on.
            if (k === "exit-empty") {
              discarded.push("settings.tmux: 'exit-empty' is reserved by Tachyon (the fleet server must not end itself when idle)");
              continue;
            }
            // YAML on/off/true/false -> tmux on/off; numbers -> string; strings literal.
            const s = typeof v === "boolean" ? (v ? "on" : "off") : typeof v === "number" ? String(v) : v;
            if (typeof s !== "string") {
              discarded.push(`settings.tmux.${k}: must be a string, number, or boolean`);
              continue;
            }
            if (/[\n\r]/.test(s)) {
              discarded.push(`settings.tmux.${k}: value must not contain newlines`);
              continue;
            }
            tmux[k] = s;
          }
          settings.tmux = tmux;
        }
      }
      if (raw.settings.worktree !== undefined) {
        if (!isPlainObject(raw.settings.worktree)) {
          discarded.push("settings.worktree: must be a mapping with 'base' and/or 'branch'");
        } else {
          const wt = raw.settings.worktree;
          const out: NonNullable<TachyonConfig["settings"]["worktree"]> = {};
          if (wt.base !== undefined) {
            if (typeof wt.base !== "string" || wt.base.trim().length === 0) discarded.push("settings.worktree.base: must be a non-empty path string");
            else out.base = wt.base;
          }
          if (wt.branch !== undefined) {
            if (typeof wt.branch !== "string" || wt.branch.trim().length === 0) {
              discarded.push("settings.worktree.branch: must be a non-empty branch template string");
            } else if (!wt.branch.includes("{agent}")) {
              discarded.push("settings.worktree.branch: template must contain '{agent}' (else every agent collides on one branch)");
            } else {
              out.branch = wt.branch;
            }
          }
          // t-aaad95 — migrated from the `tachyon.worktrees.revealInWorkspace` VS Code key. Per-folder
          // here, which is strictly better than the window-scoped key it replaces: in a multi-root
          // window two projects can legitimately disagree about revealing their worktrees.
          if (wt.revealInWorkspace !== undefined) {
            if (typeof wt.revealInWorkspace !== "boolean") discarded.push("settings.worktree.revealInWorkspace: must be a boolean");
            else out.revealInWorkspace = wt.revealInWorkspace;
          }
          // Compatibility kill switch for directory sharing. There is deliberately no product
          // default: a project opts in path-by-path with `sharedDirectories`.
          if (wt.shareDependencies !== undefined) {
            if (typeof wt.shareDependencies !== "boolean") discarded.push("settings.worktree.shareDependencies: must be a boolean");
            else out.shareDependencies = wt.shareDependencies;
          }
          if (wt.sharedDirectories !== undefined) {
            if (!Array.isArray(wt.sharedDirectories)) {
              discarded.push("settings.worktree.sharedDirectories: must be a list of literal path strings");
            } else {
              const directories: string[] = [];
              for (const [index, value] of wt.sharedDirectories.entries()) {
                if (typeof value !== "string" || value.trim().length === 0) {
                  discarded.push(`settings.worktree.sharedDirectories[${index}]: must be a non-empty literal path string`);
                  continue;
                }
                directories.push(value.trim());
              }
              out.sharedDirectories = directories;
            }
          }
          for (const key of Object.keys(wt)) {
            if (!["base", "branch", "revealInWorkspace", "shareDependencies", "sharedDirectories"].includes(key)) discarded.push(`settings.worktree: unknown key '${key}'`);
          }
          settings.worktree = out;
        }
      }
      if (raw.settings.projectGuidance !== undefined) {
        if (!isPlainObject(raw.settings.projectGuidance)) {
          discarded.push("settings.projectGuidance: must be a mapping with a non-empty 'files' list");
        } else {
          const projectGuidance = raw.settings.projectGuidance;
          const errorCountBefore = discarded.length;
          for (const key of Object.keys(projectGuidance)) {
            if (key !== "files") discarded.push(`settings.projectGuidance: unknown key '${key}'`);
          }

          if (!Array.isArray(projectGuidance.files) || projectGuidance.files.length === 0) {
            discarded.push("settings.projectGuidance.files: must be a non-empty list of workspace-relative path strings");
          } else {
            if (projectGuidance.files.length > PROJECT_GUIDANCE_MAX_FILES) {
              discarded.push(`settings.projectGuidance.files: must contain at most ${PROJECT_GUIDANCE_MAX_FILES} paths`);
            }
            const files: string[] = [];
            const seen = new Set<string>();
            for (let index = 0; index < projectGuidance.files.length; index++) {
              const rawPath = projectGuidance.files[index];
              if (typeof rawPath !== "string") {
                discarded.push(`settings.projectGuidance.files[${index}]: must be a path string`);
                continue;
              }
              if (containsUnsafeFramingCharacter(rawPath)) {
                discarded.push(`settings.projectGuidance.files[${index}]: must not contain control characters`);
                continue;
              }
              const sourcePath = rawPath.trim();
              const reason = projectGuidancePathError(sourcePath);
              if (reason) {
                discarded.push(`settings.projectGuidance.files[${index}] (${JSON.stringify(sourcePath)}): ${reason}`);
                continue;
              }
              if (seen.has(sourcePath)) {
                discarded.push(`settings.projectGuidance.files[${index}]: duplicate path ${JSON.stringify(sourcePath)}`);
                continue;
              }
              seen.add(sourcePath);
              files.push(sourcePath);
            }
            /**
             * t-48dd8d — accepted PATH BY PATH, where it used to be dropped whole on any complaint.
             * Discarding the whole list over one bad entry would drop paths that are perfectly
             * readable, which is not what "discard what is wrong" means. `errorCountBefore` stays,
             * but only to decide whether an over-long list was truncated rather than accepted.
             */
            const kept = files.slice(0, PROJECT_GUIDANCE_MAX_FILES);
            if (kept.length > 0) settings.projectGuidance = { files: kept };
            else if (discarded.length > errorCountBefore) {
              discarded.push("settings.projectGuidance: no usable path remained, so no project guidance is transported");
            }
          }
        }
      }
      if (raw.settings.companion !== undefined) {
        if (!isPlainObject(raw.settings.companion)) {
          discarded.push("settings.companion: must be a mapping with 'tabTools'");
        } else {
          const c = raw.settings.companion;
          const out: { tabTools?: boolean; allowedHosts?: string[]; lanAccess?: boolean } = {};
          if (c.tabTools !== undefined) {
            if (typeof c.tabTools !== "boolean") discarded.push("settings.companion.tabTools: must be a boolean");
            else out.tabTools = c.tabTools;
          }
          if (c.allowedHosts !== undefined) {
            if (!Array.isArray(c.allowedHosts) || !c.allowedHosts.every((x: unknown) => typeof x === "string")) {
              discarded.push("settings.companion.allowedHosts: must be a string array of host globs");
            } else {
              (out as { allowedHosts?: string[] }).allowedHosts = c.allowedHosts as string[];
            }
          }
          if (c.lanAccess !== undefined) {
            if (typeof c.lanAccess !== "boolean") discarded.push("settings.companion.lanAccess: must be a boolean");
            else out.lanAccess = c.lanAccess;
          }
          for (const key of Object.keys(c)) {
            if (key !== "tabTools" && key !== "allowedHosts" && key !== "lanAccess") {
              discarded.push(`settings.companion: unknown key '${key}'`);
            }
          }
          if (Object.keys(out).length > 0) settings.companion = out;
        }
      }
      if (raw.settings.ideBrowser !== undefined) {
        if (!isPlainObject(raw.settings.ideBrowser)) {
          discarded.push("settings.ideBrowser: must be a mapping with optional 'enabled' and 'homeUrl'");
        } else {
          const ib = raw.settings.ideBrowser;
          const out: { enabled?: boolean; homeUrl?: string } = {};
          if (ib.enabled !== undefined) {
            if (typeof ib.enabled !== "boolean") {
              discarded.push("settings.ideBrowser.enabled: must be a boolean");
            } else {
              out.enabled = ib.enabled;
            }
          }
          if (ib.homeUrl !== undefined) {
            if (typeof ib.homeUrl !== "string" || !ib.homeUrl.trim()) {
              discarded.push("settings.ideBrowser.homeUrl: must be a non-empty string (http(s) URL or host)");
            } else {
              out.homeUrl = ib.homeUrl.trim();
            }
          }
          for (const key of Object.keys(ib)) {
            if (key !== "enabled" && key !== "homeUrl") {
              discarded.push(`settings.ideBrowser: unknown key '${key}'`);
            }
          }
          if (Object.keys(out).length > 0) settings.ideBrowser = out;
        }
      }
      // SDD 479 phase 2 — the project's agent-card layout. Same SHAPE of validation as `companion`
      // above (unknown key refused by name, block dropped whole, discards accumulated); a DIFFERENT
      // severity, for the reason recorded on `settings.sidebar` in the type above.
      if (raw.settings.sidebar !== undefined) {
        if (!isPlainObject(raw.settings.sidebar)) {
          discarded.push("settings.sidebar: must be a mapping with 'cardTemplate'");
        } else {
          const sb = raw.settings.sidebar;
          for (const key of Object.keys(sb)) {
            // `options:` is NOT accepted yet: per-component options are named in the ratified schema
            // but no component implements one, and accepting a key we cannot honor would be a promise
            // the card does not keep. Refused by name, with where it went.
            if (key !== "cardTemplate") discarded.push(`settings.sidebar: unknown key '${key}' (allowed: cardTemplate)`);
          }
          if (sb.cardTemplate !== undefined) {
            const parsed = parseCardTemplate(sb.cardTemplate);
            if (parsed.config) {
              settings.sidebar = { cardTemplate: parsed.config };
            } else {
              // Refused whole: the sidebar renders the DEFAULT card and says why, rather than showing
              // a layout half-built from the lines that happened to parse.
              settings.sidebar = { cardTemplateRefusal: parsed.errors };
              for (const error of parsed.errors) warnings.push(`${error} — the sidebar is using the default card layout`);
            }
          }
        }
      }
      // t-e4f662 — the Human Inbox's staleness threshold. Same validation SHAPE as the blocks above
      // (unknown key refused by name, value checked, discards accumulated) and the same off-vocabulary
      // `agentMemoryMax` already established, so a person who knows one knows the other.
      if (raw.settings.humanInbox !== undefined) {
        if (!isPlainObject(raw.settings.humanInbox)) {
          discarded.push("settings.humanInbox: must be a mapping with 'staleAfterHours'");
        } else {
          const inbox = raw.settings.humanInbox;
          for (const key of Object.keys(inbox)) {
            if (key !== "staleAfterHours") {
              discarded.push(`settings.humanInbox: unknown key '${key}' (allowed: staleAfterHours)`);
            }
          }
          const value = inbox.staleAfterHours;
          if (value !== undefined) {
            if (value === false || value === null || value === "off" || value === "none" || value === "never") {
              settings.humanInbox = { staleAfterHours: "never" };
            } else if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
              // `0` lands here on purpose: it reads literally as "stale the moment it arrives", which
              // is the opposite of the "off" some author would mean by it. Refused by name, with the
              // spelling that does mean off.
              discarded.push(
                "settings.humanInbox.staleAfterHours: must be a positive number of hours, or \"never\" to stop marking",
              );
            } else {
              settings.humanInbox = { staleAfterHours: value };
            }
          }
        }
      }
      // t-585d5c — the idle-nudge threshold. Same validation SHAPE as `humanInbox` directly above
      // (unknown key refused by name, value checked, discards accumulated) and the same off-vocabulary,
      // so the two read as one idea rather than two conventions.
      if (raw.settings.agentNotifications !== undefined) {
        if (!isPlainObject(raw.settings.agentNotifications)) {
          discarded.push("settings.agentNotifications: must be a mapping with 'idleAfterMinutes'");
        } else {
          const notifications = raw.settings.agentNotifications;
          for (const key of Object.keys(notifications)) {
            if (key !== "idleAfterMinutes") {
              discarded.push(`settings.agentNotifications: unknown key '${key}' (allowed: idleAfterMinutes)`);
            }
          }
          const value = notifications.idleAfterMinutes;
          if (value !== undefined) {
            if (value === false || value === null || value === "off" || value === "none" || value === "never") {
              settings.agentNotifications = { idleAfterMinutes: "never" };
            } else if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
              // `0`, negatives and NaN land here together: none of them names a waiting period, and
              // `0` in particular would mean "nudge instantly", which is not the off it looks like.
              discarded.push(
                "settings.agentNotifications.idleAfterMinutes: must be a positive number of minutes, or \"never\" to stop notifying",
              );
            } else if (value > MAX_IDLE_NOTIFY_MINUTES) {
              // Refused rather than clamped: a clamp would leave the file asking for one thing while
              // the product does another, with nothing on screen to say which won.
              discarded.push(
                `settings.agentNotifications.idleAfterMinutes: ${value} is longer than the ${MAX_IDLE_NOTIFY_MINUTES}-minute maximum — use "never" to stop notifying`,
              );
            } else {
              settings.agentNotifications = { idleAfterMinutes: value };
            }
          }
        }
      }
      if (raw.settings.bridgeGuidance !== undefined) {
        if (typeof raw.settings.bridgeGuidance !== "boolean") discarded.push("settings.bridgeGuidance: must be a boolean");
        else settings.bridgeGuidance = raw.settings.bridgeGuidance;
      }
      if (raw.settings.clipboard !== undefined) {
        if (raw.settings.clipboard !== "auto" && raw.settings.clipboard !== "off") discarded.push("settings.clipboard: must be 'auto' or 'off'");
        else settings.clipboard = raw.settings.clipboard;
      }
      if (raw.settings.agentHookProjection !== undefined) {
        // t-09edf2 — refused, never partially accepted: this key decides whether a gate reaches an agent
        // session, and a half-parsed policy would silently drop the plugin the human named.
        if (!isPlainObject(raw.settings.agentHookProjection)) {
          discarded.push("settings.agentHookProjection: must be a mapping of plugin name → hook class");
        } else {
          const out: Record<string, ProjectedHookClass> = {};
          let sound = true;
          for (const [plugin, value] of Object.entries(raw.settings.agentHookProjection)) {
            if (!AGENT_HOOK_PROJECTION_CLASSES.includes(value as ProjectedHookClass)) {
              discarded.push(`settings.agentHookProjection.${plugin}: must be one of ${AGENT_HOOK_PROJECTION_CLASSES.join(", ")}`);
              sound = false;
              continue;
            }
            out[plugin] = value as ProjectedHookClass;
          }
          if (sound && Object.keys(out).length > 0) settings.agentHookProjection = out;
        }
      }
      if (raw.settings.agentPermissionProjection !== undefined) {
        const root = raw.settings.agentPermissionProjection;
        if (!isPlainObject(root)) {
          discarded.push("settings.agentPermissionProjection: must be a mapping of agent name → { runtime, … }");
        } else {
          const modes = GROK_PERMISSION_MODES;
          const out: NonNullable<TachyonConfig["settings"]["agentPermissionProjection"]> = {};
          /**
           * t-48dd8d — acceptance is per AGENT. The block used to be stored only if EVERY entry
           * parsed, so one agent's typo also discarded the postures its neighbours had written
           * correctly; discarding a line that is not wrong is not what "discard the invalid" means.
           * Each entry below is already gated on its own validity before it reaches `out`.
           *
           * A discarded entry projects NOTHING, and the owner chose that with the number in hand: for
           * a delegated codex agent, nothing projected means the class default, which is
           * `approval_policy="never"` + `sandbox_mode="danger-full-access"` (AgentManager.ts:385-386).
           * The warning names the key and the human fixes it. One rule with one special case is a rule
           * that rots — see the measurement in the t-48dd8d journal for the full survey.
           */
          for (const [agent, value] of Object.entries(root)) {
            const prefix = `settings.agentPermissionProjection.${agent}`;
            if (!isPlainObject(value)) {
              discarded.push(`${prefix}: must be a mapping with a runtime`);
              continue;
            }
            if (value.runtime === "codex") {
              // t-aaa2c6 — one authored entry per DOOR. Every key is optional and an omitted key
              // leaves that door exactly as the class/runtime default left it, so an author can
              // tighten one door (say, restore the sandbox) without restating the other two.
              const codexKeys = ["runtime", "approvalPolicy", "sandboxMode", "bridgeToolApproval"];
              const unknown = Object.keys(value).filter((key) => !codexKeys.includes(key));
              if (unknown.length > 0) {
                discarded.push(`${prefix}: unknown ${unknown.length === 1 ? "key" : "keys"} ${unknown.map((key) => `'${key}'`).join(", ")}`);
              }
              const doors: Array<[string, readonly string[]]> = [
                ["approvalPolicy", CODEX_APPROVAL_POLICIES],
                ["sandboxMode", CODEX_SANDBOX_MODES],
                ["bridgeToolApproval", CODEX_MCP_TOOL_APPROVAL_MODES],
              ];
              const entry: Record<string, string> = {};
              let ok = unknown.length === 0;
              for (const [key, allowed] of doors) {
                const raw = (value as Record<string, unknown>)[key];
                if (raw === undefined) continue;
                if (typeof raw !== "string" || !allowed.includes(raw)) {
                  discarded.push(`${prefix}.${key}: must be one of ${allowed.join(", ")}`);
                  ok = false;
                  continue;
                }
                entry[key] = raw;
              }
              if (Object.keys(entry).length === 0) {
                discarded.push(`${prefix}: a codex entry must set at least one of approvalPolicy, sandboxMode, bridgeToolApproval`);
                ok = false;
              }
              if (ok) out[agent] = { runtime: "codex", ...entry } as AgentPermissionProjectionEntry;
              continue;
            }
            const unknown = Object.keys(value).filter((key) => key !== "runtime" && key !== "mode");
            if (unknown.length > 0) {
              discarded.push(`${prefix}: unknown ${unknown.length === 1 ? "key" : "keys"} ${unknown.map((key) => `'${key}'`).join(", ")}`);
            }
            if (value.runtime !== "grok") {
              discarded.push(`${prefix}.runtime: must be 'grok' or 'codex'`);
            }
            if (!modes.includes(value.mode as typeof modes[number])) {
              discarded.push(`${prefix}.mode: must be one of ${modes.join(", ")}`);
            }
            if (value.runtime === "grok" && modes.includes(value.mode as typeof modes[number]) && unknown.length === 0) {
              out[agent] = { runtime: "grok", mode: value.mode as typeof modes[number] };
            }
          }
          if (Object.keys(out).length > 0) settings.agentPermissionProjection = out;
        }
      }
      if (raw.settings.handoff !== undefined) {
        if (!isPlainObject(raw.settings.handoff)) {
          discarded.push("settings.handoff: must be a mapping with 'path'");
        } else {
          const ho = raw.settings.handoff;
          const h: { path?: string; nudgeEvery?: string } = {};
          if (ho.path !== undefined) {
            if (typeof ho.path !== "string" || ho.path.trim() === "") discarded.push("settings.handoff.path: must be a non-empty string");
            else h.path = ho.path;
          }
          if (ho.nudgeEvery !== undefined) {
            if (ho.nudgeEvery !== "off" && parseEvery(String(ho.nudgeEvery)) === null) discarded.push("settings.handoff.nudgeEvery: must be 'off' or an interval like '30m' / '1h'");
            else h.nudgeEvery = String(ho.nudgeEvery);
          }
          if (Object.keys(h).length > 0) settings.handoff = h;
          for (const key of Object.keys(ho)) if (key !== "path" && key !== "nudgeEvery") discarded.push(`settings.handoff: unknown key '${key}'`);
        }
      }
      // t-7bcba6 — reject obsolete persistence kill switch so a false override cannot silently disable hooks.
      if (raw.settings.persistence !== undefined) {
        discarded.push(
          "settings.persistence is obsolete: silent hooks are always enabled for eligible declared Claude/Codex agents. Remove settings.persistence (including silentHooks) from tachyon.yml — there is no visible-legacy fallback.",
        );
      }
      // spec 364 — Bridge-client rebind policy (host generation bump after reload).
      if (raw.settings.bridgeClientRebind !== undefined) {
        if (!isPlainObject(raw.settings.bridgeClientRebind)) {
          discarded.push("settings.bridgeClientRebind: must be a mapping");
        } else {
          const br = raw.settings.bridgeClientRebind;
          const out: NonNullable<TachyonConfig["settings"]["bridgeClientRebind"]> = {};
          if (br.onHostGenerationBump !== undefined) {
            if (br.onHostGenerationBump !== "auto" && br.onHostGenerationBump !== "notify" && br.onHostGenerationBump !== "off") {
              discarded.push("settings.bridgeClientRebind.onHostGenerationBump: must be 'auto', 'notify', or 'off'");
            } else {
              out.onHostGenerationBump = br.onHostGenerationBump;
            }
          }
          if (br.graceMs !== undefined) {
            if (typeof br.graceMs !== "number" || !Number.isFinite(br.graceMs) || br.graceMs < 0 || !Number.isInteger(br.graceMs)) {
              discarded.push("settings.bridgeClientRebind.graceMs: must be an integer >= 0");
            } else {
              out.graceMs = br.graceMs;
            }
          }
          if (br.stopTimeoutMs !== undefined) {
            if (typeof br.stopTimeoutMs !== "number" || !Number.isFinite(br.stopTimeoutMs) || br.stopTimeoutMs < 0 || !Number.isInteger(br.stopTimeoutMs)) {
              discarded.push("settings.bridgeClientRebind.stopTimeoutMs: must be an integer >= 0");
            } else {
              out.stopTimeoutMs = br.stopTimeoutMs;
            }
          }
          if (br.maxConcurrentRebinds !== undefined) {
            if (typeof br.maxConcurrentRebinds !== "number" || !Number.isInteger(br.maxConcurrentRebinds) || br.maxConcurrentRebinds < 1) {
              discarded.push("settings.bridgeClientRebind.maxConcurrentRebinds: must be an integer >= 1");
            } else {
              out.maxConcurrentRebinds = br.maxConcurrentRebinds;
            }
          }
          if (br.circuitFailCount !== undefined) {
            if (typeof br.circuitFailCount !== "number" || !Number.isInteger(br.circuitFailCount) || br.circuitFailCount < 1) {
              discarded.push("settings.bridgeClientRebind.circuitFailCount: must be an integer >= 1");
            } else {
              out.circuitFailCount = br.circuitFailCount;
            }
          }
          for (const key of Object.keys(br)) {
            if (!["onHostGenerationBump", "graceMs", "stopTimeoutMs", "maxConcurrentRebinds", "circuitFailCount"].includes(key)) {
              discarded.push(`settings.bridgeClientRebind: unknown key '${key}'`);
            }
          }
          if (Object.keys(out).length > 0) settings.bridgeClientRebind = out;
        }
      }
      /**
       * t-e88c8a — the key is still KNOWN so a workspace that declares it is told, by name, that it
       * no longer does anything. Dropping it from the known list instead would produce
       * `settings: unknown key 'gitDelivery'`, which reads as a typo and sends the human looking for
       * the correct spelling of a setting that has been retired.
       *
       * It named the agents authorized to integrate and prune linked GitDeliveries. Both actions
       * were reached only through `git_delivery_integrate` / `git_delivery_prune` / `delivery_salvage`,
       * and those tools are gone — so the authority it granted has nothing left to grant.
       */
      if (raw.settings.gitDelivery !== undefined) {
        warnings.push(
          "settings.gitDelivery was ignored because the Delivery tools it authorized (git_delivery_integrate, git_delivery_prune, delivery_salvage) were retired; remove settings.gitDelivery from tachyon.yml",
        );
      }
      // t-8b8315 — this message used to say Delivery "is always active", which was true when the
      // key was neutralized and false once t-e88c8a removed the machinery. A retirement notice that
      // outlives the thing it describes tells the reader their setting is redundant when it is in
      // fact meaningless, so they leave it in place.
      if (raw.settings.delivery !== undefined) {
        warnings.push(
          "settings.delivery was ignored because the Delivery subsystem was retired; remove settings.delivery from tachyon.yml",
        );
      }
      if (raw.settings.taskNotifications !== undefined) {
        if (!isPlainObject(raw.settings.taskNotifications)) {
          discarded.push("settings.taskNotifications: must be a mapping");
        } else {
          const tn = raw.settings.taskNotifications;
          const out: TaskNotificationSettingsInput = {};
          for (const key of ["enabled", "suppressOwnChanges"] as const) {
            if (tn[key] !== undefined) {
              if (typeof tn[key] !== "boolean") discarded.push(`settings.taskNotifications.${key}: must be a boolean`);
              else out[key] = tn[key];
            }
          }
          if (tn.events !== undefined) {
            if (!Array.isArray(tn.events) || tn.events.some((event) => typeof event !== "string" || !(TASK_NOTIFICATION_EVENT_IDS as readonly string[]).includes(event))) {
              discarded.push(`settings.taskNotifications.events: must be a list containing only ${TASK_NOTIFICATION_EVENT_IDS.join(", ")}`);
            } else {
              out.events = tn.events as TaskNotificationSettingsInput["events"];
            }
          }
          if (tn.dedupeWindowMs !== undefined) {
            if (typeof tn.dedupeWindowMs !== "number" || !Number.isInteger(tn.dedupeWindowMs) || tn.dedupeWindowMs < 0) {
              discarded.push("settings.taskNotifications.dedupeWindowMs: must be an integer >= 0");
            } else {
              out.dedupeWindowMs = tn.dedupeWindowMs;
            }
          }
          for (const key of Object.keys(tn)) {
            if (!["enabled", "events", "suppressOwnChanges", "dedupeWindowMs"].includes(key)) discarded.push(`settings.taskNotifications: unknown key '${key}'`);
          }
          if (Object.keys(out).length > 0) settings.taskNotifications = out;
        }
      }
      for (const key of Object.keys(raw.settings)) {
        if (!(KNOWN_SETTINGS_KEYS as readonly string[]).includes(key)) discarded.push(`settings: unknown key '${key}'`);
      }
    }
  }

  const declaredOwner = buildDeclaredOwner(agents, discarded, warnings);
  warnings.push(...discarded);
  return { config: { agents, commands, runbooks, schedules, declaredOwner, settings }, errors: [], warnings, discarded };
}

export function loadConfigFile(path: string): ParseResult {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (err) {
    return { errors: [`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`], warnings: [], discarded: [] };
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
