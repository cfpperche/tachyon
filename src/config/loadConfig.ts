import fs from "node:fs";
import { parse as parseYaml } from "yaml";

export interface AttentionDef {
  enabled: boolean;
  silenceSec: number;
  patterns: string[];
}

export const ATTENTION_DEFAULT_SILENCE_SEC = 8;

export interface AgentDef {
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
  autostart: boolean;
  watch: string[];
  attention: AttentionDef;
}

export type GridShape = "2up" | "3up" | "2x2";

export interface LayoutDef {
  grid: GridShape;
  agents: string[];
}

export interface TachyonConfig {
  agents: Record<string, AgentDef>;
  layouts: Record<string, LayoutDef>;
  settings: { maxAgents?: number };
}

export interface ParseResult {
  config?: TachyonConfig;
  errors: string[];
}

export const CONFIG_FILENAMES = ["tachyon.yml", "tachyon.yaml"];

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const GRID_SHAPES: GridShape[] = ["2up", "3up", "2x2"];

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
    if (!["agents", "layouts", "settings"].includes(key)) {
      errors.push(`unknown top-level key '${key}' (expected agents, layouts, settings)`);
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
      };
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
      } else if (agent.watch.length > 0) {
        // Watched services/builds are silent by nature — attention defaults off for them.
        agent.attention.enabled = false;
      }
      for (const key of Object.keys(def)) {
        if (!["cmd", "cwd", "env", "autostart", "watch", "attention"].includes(key)) {
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
          errors.push(`layouts.${name}: must be a mapping with 'grid' and 'agents'`);
          continue;
        }
        if (typeof def.grid !== "string" || !GRID_SHAPES.includes(def.grid as GridShape)) {
          errors.push(`layouts.${name}.grid: must be one of ${GRID_SHAPES.join(", ")}`);
          continue;
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
        layouts[name] = { grid: def.grid as GridShape, agents: def.agents as string[] };
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
      for (const key of Object.keys(raw.settings)) {
        if (key !== "maxAgents") errors.push(`settings: unknown key '${key}'`);
      }
    }
  }

  if (errors.length > 0) return { errors };
  return { config: { agents, layouts, settings }, errors: [] };
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
