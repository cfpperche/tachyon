import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asAgent, type AgentDef } from "@tachyon/engine/config/loadConfig.js";
import { binaryOf } from "@tachyon/shared/resume/adapters.js";
import { withRuntimeConfigSourceLock, type RuntimeConfigSourceLockOptions } from "./sourceLock.js";
import type {
  RuntimeConfigChange,
  RuntimeConfigDocumentInventory,
  RuntimeConfigKnownSetting,
  RuntimeConfigRuntimeInventory,
  RuntimeConfigScope,
} from "./types.js";

export interface ClaudeRuntimeConfigInventory extends RuntimeConfigRuntimeInventory {
  runtime: "claude";
  label: "Anthropic Claude";
}

const SETTINGS = [
  { key: "theme", label: "Theme", inputKind: "text" },
  { key: "prefersReducedMotion", label: "Reduced motion", inputKind: "boolean" },
  { key: "spinnerTipsEnabled", label: "Spinner tips", inputKind: "boolean" },
  { key: "showTurnDuration", label: "Turn duration", inputKind: "boolean" },
  { key: "terminalProgressBarEnabled", label: "Terminal progress bar", inputKind: "boolean" },
  { key: "alwaysThinkingEnabled", label: "Always thinking", inputKind: "boolean" },
] as const;

const OPAQUE_KEYS = new Set(["permissions", "hooks", "statusLine", "tui", "mcpServers"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function readRegularFile(file: string): { text?: string; modifiedAt?: string; mode?: number; error?: string } {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { error: "Source must be a regular file." };
    return {
      text: fs.readFileSync(file, "utf8"),
      modifiedAt: stat.mtime.toISOString(),
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function safeParse(text: string | undefined): { value?: Record<string, unknown>; error?: string } {
  if (text === undefined || text.trim() === "") return { value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? { value } : { error: "The JSON root must be an object." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function displayValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  return value === undefined ? undefined : "Configured";
}

function settingValue(key: string, value: unknown): string | boolean | undefined {
  if (key === "theme") return typeof value === "string" ? value : undefined;
  return typeof value === "boolean" ? value : undefined;
}

function mcpNames(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort() : [];
}

function settingsDocument(input: {
  id: string;
  label: string;
  scope: RuntimeConfigScope;
  file: string;
  shadowFile?: string;
}): RuntimeConfigDocumentInventory {
  const read = readRegularFile(input.file);
  const parsed = safeParse(read.text);
  if (read.error || parsed.error || !parsed.value) {
    return {
      id: input.id,
      label: input.label,
      scope: input.scope,
      kind: "settings",
      path: input.file,
      exists: read.text !== undefined,
      ...(read.text !== undefined ? { revision: digest(read.text) } : {}),
      ...(read.modifiedAt ? { modifiedAt: read.modifiedAt } : {}),
      knownSettings: [],
      mcpServers: [],
      unknownKeys: [],
      internalStateCount: 0,
      parseError: read.error ?? parsed.error,
    };
  }
  const shadowRead = input.shadowFile ? readRegularFile(input.shadowFile) : {};
  const shadowParsed = safeParse(shadowRead.text);
  const shadowKeys = new Set(Object.keys(shadowParsed.value ?? {}));
  const knownSettings: RuntimeConfigKnownSetting[] = SETTINGS.map(({ key, label, inputKind }) => {
    const raw = parsed.value![key];
    const editValue = settingValue(key, raw);
    const shadowedBy = shadowKeys.has(key) ? input.shadowFile : undefined;
    return {
      key,
      label,
      inputKind,
      editable: editValue !== undefined || raw === undefined,
      ...(displayValue(raw) !== undefined ? { value: displayValue(raw) } : {}),
      ...(editValue !== undefined ? { editValue } : {}),
      ...(shadowedBy ? { editable: false, shadowedBy } : {}),
    };
  });
  const keys = Object.keys(parsed.value);
  return {
    id: input.id,
    label: input.label,
    scope: input.scope,
    kind: "settings",
    path: input.file,
    exists: read.text !== undefined,
    ...(read.text !== undefined ? { revision: digest(read.text) } : {}),
    ...(read.modifiedAt ? { modifiedAt: read.modifiedAt } : {}),
    knownSettings,
    mcpServers: mcpNames(parsed.value.mcpServers).map((name) => ({ name, enabled: true, editable: false })),
    unknownKeys: keys.filter((key) => !SETTINGS.some((setting) => setting.key === key) && !OPAQUE_KEYS.has(key)).sort(),
    internalStateCount: 0,
    opaqueKeys: keys.filter((key) => OPAQUE_KEYS.has(key)).sort(),
  };
}

function mcpDocument(file: string): RuntimeConfigDocumentInventory {
  const read = readRegularFile(file);
  const parsed = safeParse(read.text);
  const base = {
    id: "claude-workspace-mcp",
    label: "Workspace MCP",
    scope: "workspace" as const,
    kind: "mcp" as const,
    path: file,
    exists: read.text !== undefined,
    ...(read.text !== undefined ? { revision: digest(read.text) } : {}),
    ...(read.modifiedAt ? { modifiedAt: read.modifiedAt } : {}),
  };
  if (read.error || parsed.error || !parsed.value) {
    return {
      ...base,
      knownSettings: [],
      mcpServers: [],
      unknownKeys: [],
      internalStateCount: 0,
      parseError: read.error ?? parsed.error,
    };
  }
  return {
    ...base,
    knownSettings: [],
    mcpServers: mcpNames(parsed.value.mcpServers).map((name) => ({ name, enabled: true, editable: false })),
    unknownKeys: Object.keys(parsed.value).filter((key) => key !== "mcpServers").sort(),
    internalStateCount: 0,
    opaqueKeys: parsed.value.mcpServers === undefined ? [] : ["mcpServers"],
  };
}

export function inspectClaudeRuntimeConfig(input: {
  workspaceRoot: string;
  agents: Record<string, AgentDef>;
  homeDir?: string;
  pendingAgents?: string[];
}): ClaudeRuntimeConfigInventory {
  const home = input.homeDir ?? os.homedir();
  const potentialAgents = Object.entries(input.agents)
    .filter(([, definition]) => asAgent(definition)?.profileNativeConfig?.adapter === "claude" || binaryOf(definition.cmd) === "claude")
    .map(([name]) => name)
    .sort();
  return {
    runtime: "claude",
    label: "Anthropic Claude",
    documents: [
      settingsDocument({
        id: "claude-global-settings",
        label: "Global settings",
        scope: "global",
        file: path.join(home, ".claude", "settings.json"),
      }),
      settingsDocument({
        id: "claude-workspace-settings",
        label: "Workspace settings",
        scope: "workspace",
        file: path.join(input.workspaceRoot, ".claude", "settings.json"),
        shadowFile: path.join(input.workspaceRoot, ".claude", "settings.local.json"),
      }),
      mcpDocument(path.join(input.workspaceRoot, ".mcp.json")),
    ],
    potentialAgents,
    pendingAgents: [...(input.pendingAgents ?? [])].filter((name) => potentialAgents.includes(name)).sort(),
  };
}

function targetPath(documentId: string, workspaceRoot: string, homeDir: string): string {
  if (documentId === "claude-global-settings") return path.join(homeDir, ".claude", "settings.json");
  if (documentId === "claude-workspace-settings") return path.join(workspaceRoot, ".claude", "settings.json");
  throw new Error("This Claude document is read-only.");
}

function validSetting(key: string, value: unknown): boolean {
  const setting = SETTINGS.find((candidate) => candidate.key === key);
  if (!setting) return false;
  return setting.inputKind === "text" ? typeof value === "string" : typeof value === "boolean";
}

export function applyClaudeRuntimeConfigChange(input: {
  workspaceRoot: string;
  homeDir?: string;
  documentId: string;
  expectedRevision?: string;
  changes: RuntimeConfigChange[];
  lock?: RuntimeConfigSourceLockOptions;
}): { path: string; revision: string } {
  const home = input.homeDir ?? os.homedir();
  const file = targetPath(input.documentId, input.workspaceRoot, home);
  return withRuntimeConfigSourceLock(file, () => {
    const before = readRegularFile(file);
    if (before.error) throw new Error(before.error);
    const actualRevision = before.text === undefined ? undefined : digest(before.text);
    if (actualRevision !== input.expectedRevision) throw new Error("The source changed since it was opened. Reload it before saving.");
    const parsed = safeParse(before.text);
    if (parsed.error || !parsed.value) throw new Error("This source is invalid JSON. Open the file to repair it before using Runtime Config.");
    if (input.changes.length === 0) throw new Error("No runtime configuration changes were supplied.");
    const after = structuredClone(parsed.value);
    for (const change of input.changes) {
      if (change.kind !== "setting" || !validSetting(change.key, change.value)) {
        throw new Error("Unsupported Claude Runtime Config change.");
      }
      after[change.key] = change.value;
    }
    const text = `${JSON.stringify(after, null, 2)}\n`;
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, text, { encoding: "utf8", mode: before.mode ?? 0o600, flush: true });
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
    }
    return { path: file, revision: digest(text) };
  }, input.lock);
}
