import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "@iarna/toml";
import type { AgentDef } from "../config/loadConfig.js";

export type RuntimeConfigScope = "global" | "workspace";

export interface RuntimeConfigKnownSetting {
  key: string;
  label: string;
  value: string;
}

export interface RuntimeConfigSourceInventory {
  scope: RuntimeConfigScope;
  path: string;
  exists: boolean;
  revision?: string;
  modifiedAt?: string;
  knownSettings: RuntimeConfigKnownSetting[];
  mcpServers: string[];
  unknownKeys: string[];
  parseError?: string;
}

export interface CodexRuntimeConfigInventory {
  runtime: "codex";
  global: RuntimeConfigSourceInventory;
  workspace: RuntimeConfigSourceInventory;
  potentialAgents: string[];
}

const KNOWN_SETTINGS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "approval_policy", label: "Approval policy" },
  { key: "sandbox_mode", label: "Sandbox mode" },
  { key: "personality", label: "Personality" },
  { key: "tui.status_line", label: "Status line" },
  { key: "tui.status_line_use_colors", label: "Status line colors" },
  { key: "features.terminal_resize_reflow", label: "Terminal resize reflow" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function atPath(source: Record<string, unknown>, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, source);
}

function leafPaths(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const current = prefix ? `${prefix}.${key}` : key;
    return isRecord(child) ? leafPaths(child, current) : [current];
  });
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value.join(" · ");
  return "Configured";
}

function sourcePath(scope: RuntimeConfigScope, workspaceRoot: string, homeDir: string): string {
  return scope === "global"
    ? path.join(homeDir, ".codex", "config.toml")
    : path.join(workspaceRoot, ".codex", "config.toml");
}

function inspectSource(scope: RuntimeConfigScope, workspaceRoot: string, homeDir: string): RuntimeConfigSourceInventory {
  const file = sourcePath(scope, workspaceRoot, homeDir);
  let text: string;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { scope, path: file, exists: false, knownSettings: [], mcpServers: [], unknownKeys: [] };
    }
    return {
      scope,
      path: file,
      exists: false,
      knownSettings: [],
      mcpServers: [],
      unknownKeys: [],
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
  const base = {
    scope,
    path: file,
    exists: true,
    revision: createHash("sha256").update(text).digest("hex").slice(0, 12),
    modifiedAt: stat.mtime.toISOString(),
  } as const;
  try {
    const parsed = parse(text);
    if (!isRecord(parsed)) throw new Error("The TOML root must be a table.");
    const knownSettings = KNOWN_SETTINGS.flatMap(({ key, label }) => {
      const value = atPath(parsed, key);
      return value === undefined ? [] : [{ key, label, value: displayValue(value) }];
    });
    const mcp = isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {};
    const unknownKeys = leafPaths(parsed)
      .filter((key) => !KNOWN_SETTINGS.some((known) => known.key === key))
      // MCP details may contain commands or environment references. Their names are
      // shown separately; their body is intentionally not surfaced in Control.
      .filter((key) => !key.startsWith("mcp_servers."));
    return { ...base, knownSettings, mcpServers: Object.keys(mcp).sort(), unknownKeys: unknownKeys.sort() };
  } catch (error) {
    return {
      ...base,
      knownSettings: [],
      mcpServers: [],
      unknownKeys: [],
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Safe host-side inventory for Control. It deliberately never returns TOML bytes,
 * MCP command bodies, environment values, or credentials.
 */
export function inspectCodexRuntimeConfig(input: {
  workspaceRoot: string;
  agents: Record<string, AgentDef>;
  homeDir?: string;
}): CodexRuntimeConfigInventory {
  const homeDir = input.homeDir ?? os.homedir();
  return {
    runtime: "codex",
    global: inspectSource("global", input.workspaceRoot, homeDir),
    workspace: inspectSource("workspace", input.workspaceRoot, homeDir),
    potentialAgents: Object.entries(input.agents)
      .filter(([, definition]) => definition.profileNativeConfig?.adapter === "codex" || /^codex(?:\s|$)/.test(definition.cmd.trim()))
      .map(([name]) => name)
      .sort(),
  };
}
