import fs from "node:fs";
import { parse as parseYaml } from "yaml";

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

/** agent = known AI CLI; everything else (servers, shells, builds) = terminal. Explicit `kind:` wins. */
export function inferKind(cmd: string): EntryKind {
  const tokens = cmd.trim().split(/\s+/);
  let bin = tokens[0] ?? "";
  // see through common launchers: `npx claude`, `bunx codex`, `env X=1 claude`
  if (["npx", "bunx", "pnpx", "env"].includes(bin.split("/").pop() ?? "")) {
    bin = tokens.find((t, i) => i > 0 && !t.includes("=") && !t.startsWith("-")) ?? bin;
  }
  const base = bin.split("/").pop() ?? bin;
  return KNOWN_AI_CLIS.includes(base) ? "agent" : "terminal";
}

export interface AgentDef {
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
  /** spec 210 — run this agent in its own git worktree+branch (opt-in, off by default) */
  worktree?: boolean;
  /** per-agent literal branch name (overrides the global template); authoritatively validated via git check-ref-format at worktree-create */
  branch?: string;
  /** commands run ONCE in the fresh worktree before the agent starts (sequential, stop-on-failure); normalized to a list */
  worktreeSetup?: string[];
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

/** The command actually spawned: cmd + instructions arg when the runtime accepts one. */
export function composeCommand(def: Pick<AgentDef, "cmd" | "instructions">): string {
  if (!def.instructions || def.instructions.trim().length === 0) return def.cmd;
  const tokens = def.cmd.trim().split(/\s+/);
  const base = (tokens[0] ?? "").split("/").pop() ?? "";
  const template = INSTRUCTION_ARG[base];
  if (!template) return def.cmd; // unknown CLI — stored but not delivered (documented)
  return `${def.cmd} ${template(shellQuote(def.instructions.trim()))}`;
}

export type GridShape = "2up" | "3up" | "2x2" | "rows-2" | "rows-3" | "main-left" | "main-right";

export interface LayoutDef {
  /** preset shape — exactly one of grid|layout is set */
  grid?: GridShape;
  /** optional proportions for the preset's top-level groups (must sum to 1) */
  sizes?: number[];
  /** captured/custom tree (vscode EditorGroupLayout shape) — wins over grid */
  layout?: { orientation: 0 | 1; groups: Array<{ size?: number; groups?: unknown[] }> };
  agents: string[];
}

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
  agents: Record<string, AgentDef>;
  layouts: Record<string, LayoutDef>;
  commands: Record<string, CommandDef>;
  runbooks: Record<string, RunbookDef>;
  schedules: Record<string, ScheduleDef>;
  settings: {
    maxAgents?: number;
    bridgePort?: number;
    auth?: boolean;
    layout?: string;
    tmux?: Record<string, string>;
    /** spec 210 — global worktree location root + branch-name template ({agent} placeholder) */
    worktree?: { base?: string; branch?: string };
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
const GRID_SHAPES: GridShape[] = ["2up", "3up", "2x2", "rows-2", "rows-3", "main-left", "main-right"];
/** top-level group count per preset — what `sizes` must match */
const PRESET_TOP_GROUPS: Record<GridShape, number> = {
  "2up": 2, "3up": 3, "2x2": 2, "rows-2": 2, "rows-3": 3, "main-left": 2, "main-right": 2,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
    if (!["agents", "layouts", "commands", "runbooks", "schedules", "settings"].includes(key)) {
      errors.push(`unknown top-level key '${key}' (expected agents, layouts, commands, runbooks, schedules, settings)`);
    }
  }

  const agents: Record<string, AgentDef> = {};
  if (!isPlainObject(raw.agents) || Object.keys(raw.agents).length === 0) {
    errors.push("'agents' must be a non-empty mapping of agent name -> definition");
  } else {
    for (const [name, def] of Object.entries(raw.agents)) {
      if (!NAME_RE.test(name)) {
        errors.push(`agents.${name}: invalid name (must match ${NAME_RE})`);
        continue;
      }
      if (!isPlainObject(def)) {
        errors.push(`agents.${name}: must be a mapping with at least 'cmd'`);
        continue;
      }
      if (typeof def.cmd !== "string" || def.cmd.trim().length === 0) {
        errors.push(`agents.${name}.cmd: required non-empty string`);
        continue;
      }
      const agent: AgentDef = {
        cmd: def.cmd,
        autostart: false,
        watch: [],
        attention: { enabled: true, silenceSec: ATTENTION_DEFAULT_SILENCE_SEC, patterns: [] },
        restart: "never",
        kind: inferKind(def.cmd),
      };
      if (def.kind !== undefined) {
        if (def.kind !== "agent" && def.kind !== "terminal") {
          errors.push(`agents.${name}.kind: must be 'agent' or 'terminal'`);
        } else {
          agent.kind = def.kind;
        }
      }
      if (def.cwd !== undefined) {
        if (typeof def.cwd !== "string") errors.push(`agents.${name}.cwd: must be a string`);
        else agent.cwd = def.cwd;
      }
      if (def.env !== undefined) {
        if (!isPlainObject(def.env) || Object.values(def.env).some((v) => typeof v !== "string")) {
          errors.push(`agents.${name}.env: must be a mapping of string -> string`);
        } else {
          agent.env = def.env as Record<string, string>;
        }
      }
      if (def.autostart !== undefined) {
        if (typeof def.autostart !== "boolean") errors.push(`agents.${name}.autostart: must be a boolean`);
        else agent.autostart = def.autostart;
      }
      if (def.watch !== undefined) {
        const globs = typeof def.watch === "string" ? [def.watch] : def.watch;
        if (!Array.isArray(globs) || globs.length === 0 || globs.some((g) => typeof g !== "string" || g.length === 0)) {
          errors.push(`agents.${name}.watch: must be a non-empty glob string or list of globs`);
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
            if (typeof att.enabled !== "boolean") errors.push(`agents.${name}.attention.enabled: must be a boolean`);
            else agent.attention.enabled = att.enabled;
          }
          if (att.silenceSec !== undefined) {
            if (typeof att.silenceSec !== "number" || !Number.isInteger(att.silenceSec) || att.silenceSec < 1) {
              errors.push(`agents.${name}.attention.silenceSec: must be an integer >= 1`);
            } else {
              agent.attention.silenceSec = att.silenceSec;
            }
          }
          if (att.patterns !== undefined) {
            if (!Array.isArray(att.patterns) || att.patterns.some((p) => typeof p !== "string" || p.length === 0)) {
              errors.push(`agents.${name}.attention.patterns: must be a list of non-empty regex strings`);
            } else {
              agent.attention.patterns = att.patterns as string[];
            }
          }
          for (const key of Object.keys(att)) {
            if (!["enabled", "silenceSec", "patterns"].includes(key)) {
              errors.push(`agents.${name}.attention: unknown key '${key}'`);
            }
          }
        } else {
          errors.push(`agents.${name}.attention: must be a boolean or a mapping`);
        }
      } else if (agent.kind === "terminal") {
        // Terminals (servers, shells, builds) are silent by nature — attention defaults off.
        agent.attention.enabled = false;
      }
      if (def.instructions !== undefined) {
        if (typeof def.instructions !== "string") {
          errors.push(`agents.${name}.instructions: must be a string`);
        } else if (def.instructions.trim().length > 0) {
          agent.instructions = def.instructions;
        }
      }
      if (def.restart !== undefined) {
        if (def.restart !== "never" && def.restart !== "on-crash") {
          errors.push(`agents.${name}.restart: must be 'never' or 'on-crash'`);
        } else {
          agent.restart = def.restart;
        }
      }
      if (def.worktree !== undefined) {
        if (typeof def.worktree !== "boolean") errors.push(`agents.${name}.worktree: must be a boolean`);
        else agent.worktree = def.worktree;
      }
      if (def.branch !== undefined) {
        if (typeof def.branch !== "string") {
          errors.push(`agents.${name}.branch: must be a string`);
        } else {
          const bad = validateBranchLiteral(def.branch);
          if (bad) errors.push(`agents.${name}.branch: ${bad}`);
          else agent.branch = def.branch;
        }
      }
      if (def.worktreeSetup !== undefined) {
        const list = typeof def.worktreeSetup === "string" ? [def.worktreeSetup] : def.worktreeSetup;
        if (!Array.isArray(list) || list.length === 0 || list.some((c) => typeof c !== "string" || c.trim().length === 0)) {
          errors.push(`agents.${name}.worktreeSetup: must be a non-empty command string or list of non-empty command strings`);
        } else {
          agent.worktreeSetup = list as string[];
        }
      }
      for (const key of Object.keys(def)) {
        if (!["cmd", "cwd", "env", "autostart", "watch", "attention", "restart", "kind", "instructions", "worktree", "branch", "worktreeSetup"].includes(key)) {
          errors.push(`agents.${name}: unknown key '${key}'`);
        }
      }
      agents[name] = agent;
    }
  }

  const layouts: Record<string, LayoutDef> = {};
  if (raw.layouts !== undefined) {
    if (!isPlainObject(raw.layouts)) {
      errors.push("'layouts' must be a mapping of layout name -> definition");
    } else {
      for (const [name, def] of Object.entries(raw.layouts)) {
        if (!NAME_RE.test(name)) {
          errors.push(`layouts.${name}: invalid name (must match ${NAME_RE})`);
          continue;
        }
        if (!isPlainObject(def)) {
          errors.push(`layouts.${name}: must be a mapping with 'grid' (or 'layout') and 'agents'`);
          continue;
        }
        const hasGrid = def.grid !== undefined;
        const hasTree = def.layout !== undefined;
        if (hasGrid === hasTree) {
          errors.push(`layouts.${name}: exactly one of 'grid' or 'layout' is required`);
          continue;
        }
        if (hasGrid && (typeof def.grid !== "string" || !GRID_SHAPES.includes(def.grid as GridShape))) {
          errors.push(`layouts.${name}.grid: must be one of ${GRID_SHAPES.join(", ")}`);
          continue;
        }
        let sizes: number[] | undefined;
        if (def.sizes !== undefined) {
          if (!hasGrid) {
            errors.push(`layouts.${name}.sizes: only applies to preset grids (the custom 'layout' tree carries its own sizes)`);
            continue;
          }
          const want = PRESET_TOP_GROUPS[def.grid as GridShape];
          const list = def.sizes;
          if (!Array.isArray(list) || list.length !== want || list.some((v) => typeof v !== "number" || v <= 0.04)) {
            errors.push(`layouts.${name}.sizes: must be ${want} numbers > 0.04 (one per top-level group of '${def.grid}')`);
            continue;
          }
          const sum = (list as number[]).reduce((a, b) => a + b, 0);
          if (Math.abs(sum - 1) > 0.01) {
            errors.push(`layouts.${name}.sizes: must sum to 1 (got ${sum.toFixed(2)})`);
            continue;
          }
          sizes = list as number[];
        }
        let tree: LayoutDef["layout"];
        if (hasTree) {
          const t = def.layout as { orientation?: unknown; groups?: unknown };
          if (!isPlainObject(t) || (t.orientation !== 0 && t.orientation !== 1) || !Array.isArray(t.groups)) {
            errors.push(`layouts.${name}.layout: must be {orientation: 0|1, groups: [...]} (the captured editor layout)`);
            continue;
          }
          tree = t as LayoutDef["layout"];
        }
        if (
          !Array.isArray(def.agents) ||
          def.agents.length === 0 ||
          def.agents.some((a) => typeof a !== "string")
        ) {
          errors.push(`layouts.${name}.agents: must be a non-empty list of agent names`);
          continue;
        }
        for (const agentName of def.agents as string[]) {
          if (!(agentName in agents)) {
            errors.push(`layouts.${name}.agents: unknown agent '${agentName}'`);
          }
        }
        layouts[name] = {
          ...(hasGrid ? { grid: def.grid as GridShape } : {}),
          ...(sizes ? { sizes } : {}),
          ...(tree ? { layout: tree } : {}),
          agents: def.agents as string[],
        };
      }
    }
  }

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
      if (raw.settings.layout !== undefined) {
        if (typeof raw.settings.layout !== "string") {
          errors.push("settings.layout: must be a layout name (string)");
        } else if (!(raw.settings.layout in layouts)) {
          errors.push(`settings.layout: unknown layout '${raw.settings.layout}'`);
        } else {
          settings.layout = raw.settings.layout;
        }
      }
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
          const out: { base?: string; branch?: string } = {};
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
          for (const key of Object.keys(wt)) {
            if (!["base", "branch"].includes(key)) errors.push(`settings.worktree: unknown key '${key}'`);
          }
          settings.worktree = out;
        }
      }
      for (const key of Object.keys(raw.settings)) {
        if (!["maxAgents", "bridgePort", "auth", "layout", "tmux", "worktree"].includes(key)) errors.push(`settings: unknown key '${key}'`);
      }
    }
  }

  if (errors.length > 0) return { errors };
  return { config: { agents, layouts, commands, runbooks, schedules, settings }, errors: [] };
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
