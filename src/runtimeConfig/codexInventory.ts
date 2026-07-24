import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "@iarna/toml";
import type { AgentDef } from "../config/loadConfig.js";
import { codexNativeConfigRevision, type CodexEditableSettingKey } from "../config/codexNativeConfigProjection.js";

export type RuntimeConfigScope = "global" | "workspace";

export interface RuntimeConfigKnownSetting {
  key: CodexEditableSettingKey;
  label: string;
  /** Content-free rendering of an editable scalar; omitted means unset in this source. */
  value?: string;
  /** The typed, measured value used by the visual editor; never a credential-bearing field. */
  editValue?: string | boolean | string[];
  editable: boolean;
}

export interface RuntimeConfigSourceInventory {
  scope: RuntimeConfigScope;
  path: string;
  exists: boolean;
  revision?: string;
  modifiedAt?: string;
  knownSettings: RuntimeConfigKnownSetting[];
  mcpServers: RuntimeConfigMcpServer[];
  unknownKeys: string[];
  /** Runtime-maintained records, intentionally summarized rather than listed. */
  internalStateCount: number;
  parseError?: string;
}

export interface RuntimeConfigMcpServer {
  name: string;
  enabled: boolean;
}

export interface CodexRuntimeConfigInventory {
  runtime: "codex";
  global: RuntimeConfigSourceInventory;
  workspace: RuntimeConfigSourceInventory;
  potentialAgents: string[];
  pendingAgents?: string[];
}

const KNOWN_SETTINGS: ReadonlyArray<{ key: CodexEditableSettingKey; label: string }> = [
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

function editableValue(key: CodexEditableSettingKey, value: unknown): string | boolean | string[] | undefined {
  if (value === undefined) return undefined;
  if (key === "tui.status_line") return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
  if (key === "tui.status_line_use_colors" || key === "features.terminal_resize_reflow") return typeof value === "boolean" ? value : undefined;
  return typeof value === "string" ? value : undefined;
}

function sourcePath(scope: RuntimeConfigScope, workspaceRoot: string, homeDir: string): string {
  return scope === "global"
    ? path.join(homeDir, ".codex", "config.toml")
    : path.join(workspaceRoot, ".codex", "config.toml");
}

const DISABLED_MCP_MARKER = /^# tachyon-disabled-mcp:\s*([A-Za-z0-9_-]+)\s*$/;

function inspectSource(scope: RuntimeConfigScope, workspaceRoot: string, homeDir: string): RuntimeConfigSourceInventory {
  const file = sourcePath(scope, workspaceRoot, homeDir);
  let text: string;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { scope, path: file, exists: false, knownSettings: [], mcpServers: [], unknownKeys: [], internalStateCount: 0 };
    }
    return {
      scope,
      path: file,
      exists: false,
      knownSettings: [],
      mcpServers: [],
      unknownKeys: [],
      internalStateCount: 0,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
  const base = {
    scope,
    path: file,
    exists: true,
    revision: codexNativeConfigRevision(text),
    modifiedAt: stat.mtime.toISOString(),
  } as const;
  try {
    const parsed = parse(text);
    if (!isRecord(parsed)) throw new Error("The TOML root must be a table.");
    const knownSettings = KNOWN_SETTINGS.map(({ key, label }) => {
      const value = atPath(parsed, key);
      const typed = editableValue(key, value);
      return value === undefined
        ? { key, label, editable: true }
        : { key, label, value: displayValue(value), ...(typed !== undefined ? { editValue: typed, editable: true } : { editable: false }) };
    });
    const mcp = isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {};
    const disabled = text.split("\n")
      .map((line) => line.match(DISABLED_MCP_MARKER)?.[1])
      .filter((name): name is string => !!name);
    const mcpServers = [...new Set([
      ...Object.keys(mcp).map((name) => ({ name, enabled: true })),
      ...disabled.map((name) => ({ name, enabled: false })),
    ])].sort((left, right) => left.name.localeCompare(right.name));
    const allPaths = leafPaths(parsed);
    const internalStateCount = allPaths.filter((key) => key.startsWith("hooks.state.")).length;
    const unknownKeys = allPaths
      .filter((key) => !KNOWN_SETTINGS.some((known) => known.key === key))
      // MCP details may contain commands or environment references. Their names are
      // shown separately; their body is intentionally not surfaced in Control.
      .filter((key) => !key.startsWith("mcp_servers."))
      .filter((key) => !key.startsWith("hooks.state."));
    return { ...base, knownSettings, mcpServers, unknownKeys: unknownKeys.sort(), internalStateCount };
  } catch (error) {
    return {
      ...base,
      knownSettings: [],
      mcpServers: [],
      unknownKeys: [],
      internalStateCount: 0,
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
  pendingAgents?: string[];
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
    pendingAgents: [...(input.pendingAgents ?? [])].sort(),
  };
}
