import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "@iarna/toml";
import type { AgentDef } from "../config/loadConfig.js";
import { isTachyonManagedGrokHome } from "../harness/HarnessManager.js";
import { binaryOf } from "../resume/adapters.js";
import type {
  RuntimeConfigChange,
  RuntimeConfigDocumentInventory,
  RuntimeConfigKnownSetting,
  RuntimeConfigMcpServer,
  RuntimeConfigRuntimeInventory,
} from "./types.js";

/**
 * SDD 481 — measured against `grok 0.2.112` on 2026-07-28 (isolated `GROK_HOME`, synthetic git
 * repository, plus the version-matched guide the release ships at `$GROK_HOME/README.md` and the
 * config keys present in the installed binary). Nothing here is inferred from Codex: Grok's global
 * document is TOML with a different schema, its project document honors only `[mcp_servers]`, and
 * its MCP enable/disable is a native field rather than the commented block Codex needs.
 */
export const GROK_MEASURED_CLI_VERSION = "grok 0.2.112";

export interface GrokRuntimeConfigInventory extends RuntimeConfigRuntimeInventory {
  runtime: "grok";
  label: "xAI Grok";
}

export const GROK_GLOBAL_CONFIG_DOCUMENT = "grok-global-config";
export const GROK_WORKSPACE_CONFIG_DOCUMENT = "grok-workspace-config";
export const GROK_TRUST_DOCUMENT = "grok-folder-trust";

type NumericBounds = { min: number; max: number };

/**
 * The scalars Control owns. Every one is documented by the installed release's own guide AND
 * present in the installed binary; none of them grants authority, names a credential, or carries an
 * executable payload. Grok honors them only in the user-scope document (§Project-Scoped MCP Servers:
 * "Only `[mcp_servers]` is supported in project-scoped `.grok/config.toml`").
 */
const GLOBAL_SETTINGS: ReadonlyArray<{
  key: string;
  label: string;
  inputKind: "text" | "boolean" | "number";
  bounds?: NumericBounds;
}> = [
  { key: "models.default", label: "Default model", inputKind: "text" },
  { key: "cli.auto_update", label: "Check for updates on launch", inputKind: "boolean" },
  { key: "features.telemetry", label: "Telemetry", inputKind: "boolean" },
  { key: "features.codebase_indexing", label: "Codebase indexing", inputKind: "boolean" },
  { key: "session.auto_compact_threshold_percent", label: "Auto-compact threshold (%)", inputKind: "number", bounds: { min: 1, max: 100 } },
  { key: "session.load_envrc", label: "Load .envrc into bash commands", inputKind: "boolean" },
  { key: "tools.respect_gitignore", label: "Respect .gitignore", inputKind: "boolean" },
  { key: "ui.max_thoughts_width", label: "Reasoning display width", inputKind: "number", bounds: { min: 20, max: 500 } },
  { key: "ui.compact_mode", label: "Compact mode", inputKind: "boolean" },
];

/**
 * Keys that decide whether Grok asks before it acts. They are shown when the person has already
 * configured them — hiding a live `permission_mode = "always-approve"` would make Control less
 * honest than the file — but Control never writes them: granting execution authority belongs to the
 * runtime's own consent flow, not to a settings editor.
 */
const AUTHORITY_SETTINGS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "features.support_permission", label: "Prompt before tool execution" },
  { key: "ui.permission_mode", label: "Permission mode" },
  { key: "ui.approval_mode", label: "Approval mode" },
  { key: "ui.default_selected_permission", label: "Default selected permission" },
  { key: "ui.remember_tool_approvals", label: "Remember tool approvals" },
  { key: "ui.yolo", label: "Approve every tool call" },
];

const AUTHORITY_READ_ONLY_REASON =
  "Grants tool-execution authority. Change it in Grok itself so the decision is the runtime's, not Control's.";

/**
 * Sections whose bodies are executable, credential-bearing or owned by another track. Only their
 * top-level name is ever reported; no leaf key, and never a value.
 *
 * - `mcp_servers` — command/args/env/headers (names are listed separately)
 * - `hooks` — shell commands
 * - `telemetry` — `events_api_key`, `mixpanel_token`
 * - `endpoints`, `models.<provider>` — `base_url`, `api_key`, `env_key`, provider `command`
 * - `marketplace`, `plugins`, `skills`, `agent(s)`, `personas`, `roles` — installable capability
 * - `sandbox` — the filesystem/network profile
 * - `memory` — runtime-managed native memory (`t-8c7431`), deliberately not configuration here
 */
const OPAQUE_SECTIONS = new Set([
  "mcp_servers",
  "hooks",
  "telemetry",
  "endpoints",
  "marketplace",
  "sandbox",
  "memory",
  "skills",
  "plugins",
  "agent",
  "agents",
  "personas",
  "roles",
  "shortcuts",
  "lsp",
  "auth",
  "requirements",
]);

/** Bookkeeping Grok writes for itself. Hidden from the inventory and counted instead. */
const RUNTIME_OWNED_KEYS = new Set(["cli.installer"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function atPath(source: Record<string, unknown>, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), source);
}

function leafPaths(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const current = prefix ? `${prefix}.${key}` : key;
    return isRecord(child) ? leafPaths(child, current) : [current];
  });
}

/**
 * `models` is mixed: `models.default` is an owned scalar, while `[models.<name>]` carries provider
 * credentials. Anything deeper than one level under `models` is treated as provider material.
 */
function opaqueSectionOf(leaf: string): string | undefined {
  const segments = leaf.split(".");
  const head = segments[0]!;
  if (OPAQUE_SECTIONS.has(head)) return head;
  if (head === "models" && segments.length > 2) return "models";
  return undefined;
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
    const value = parse(text) as unknown;
    return isRecord(value) ? { value } : { error: "The TOML root must be a table." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function displayValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value.join(" · ");
  return value === undefined ? undefined : "Configured";
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function typedSettingValue(
  setting: (typeof GLOBAL_SETTINGS)[number],
  value: unknown,
): string | boolean | number | undefined {
  if (setting.inputKind === "boolean") return typeof value === "boolean" ? value : undefined;
  if (setting.inputKind === "number") {
    if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
    return setting.bounds && (value < setting.bounds.min || value > setting.bounds.max) ? undefined : value;
  }
  return typeof value === "string" && MODEL_ID.test(value) ? value : undefined;
}

/** Bare TOML table header `[a.b]`, the only form this patcher edits. */
function tableHeaderRange(lines: string[], table: string): { start: number; end: number } | undefined {
  const header = new RegExp(`^\\s*\\[${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^\s*\[/.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function mcpServers(parsed: Record<string, unknown>, text: string | undefined): RuntimeConfigMcpServer[] {
  const table = parsed.mcp_servers;
  if (!isRecord(table)) return [];
  const lines = (text ?? "").split("\n");
  return Object.entries(table)
    .map(([name, entry]) => {
      const enabled = !(isRecord(entry) && entry.enabled === false);
      // Only a bare `[mcp_servers.<name>]` header can be patched safely; an inline table or a
      // quoted/dotted spelling stays read-only rather than being rewritten into a shape the
      // person did not choose.
      const patchable = /^[A-Za-z0-9_-]+$/.test(name) && !!tableHeaderRange(lines, `mcp_servers.${name}`);
      return { name, enabled, editable: patchable };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function documentBase(id: string, label: string, scope: "global" | "workspace", kind: "config" | "trust", file: string) {
  const read = readRegularFile(file);
  return {
    read,
    base: {
      id,
      label,
      scope,
      kind,
      path: file,
      exists: read.text !== undefined,
      ...(read.text !== undefined ? { revision: digest(read.text) } : {}),
      ...(read.modifiedAt ? { modifiedAt: read.modifiedAt } : {}),
    },
  };
}

function emptyBody(parseError?: string) {
  return {
    knownSettings: [] as RuntimeConfigKnownSetting[],
    mcpServers: [] as RuntimeConfigMcpServer[],
    unknownKeys: [] as string[],
    internalStateCount: 0,
    ...(parseError ? { parseError } : {}),
  };
}

/**
 * t-26f508 changed this answer while SDD 481 was in flight, and the correction is the point. Before
 * it, every Grok agent launched with a Bridge-only private `config.toml`, so this file reached none
 * of them. Now a canonical Grok profile projects measured families FROM this file into the private
 * home at every launch — `grok` is the only source those families have. So the reach of this
 * document depends on the agent: a canonical Grok profile inherits it, a Bridge-only one still does
 * not, and the person's own `grok` always did.
 */
const GLOBAL_IMPACT =
  "A canonical Grok agent projects measured families from this file into its private GROK_HOME at"
  + " every launch, so it applies to those agents at their next Start, Restart or Resume. A Grok agent"
  + " without that profile launches Bridge-only and does not inherit it; Grok started outside Tachyon"
  + " always reads it.";
const WORKSPACE_IMPACT =
  "Grok discovers this file from the working directory, so it reaches agents in this workspace even"
  + " under a private GROK_HOME, at their next launch. Only [mcp_servers] is read in project scope;"
  + " other sections here are ignored by Grok.";
const TRUST_IMPACT =
  "Folder trust decides whether Grok runs this workspace's .grok/hooks/. Tachyon-managed agents are"
  + " pre-trusted in their own private home, so this file governs Grok started outside Tachyon.";

function globalConfigDocument(file: string): RuntimeConfigDocumentInventory {
  const { read, base } = documentBase(GROK_GLOBAL_CONFIG_DOCUMENT, "Global config", "global", "config", file);
  const parsed = safeParse(read.text);
  if (read.error || parsed.error || !parsed.value) {
    return { ...base, ...emptyBody(read.error ?? parsed.error), impact: GLOBAL_IMPACT };
  }
  const knownSettings: RuntimeConfigKnownSetting[] = GLOBAL_SETTINGS.map((setting) => {
    const raw = atPath(parsed.value!, setting.key);
    const editValue = typedSettingValue(setting, raw);
    const shown = displayValue(raw);
    return {
      key: setting.key,
      label: setting.label,
      inputKind: setting.inputKind,
      editable: editValue !== undefined || raw === undefined,
      ...(shown !== undefined ? { value: shown } : {}),
      ...(editValue !== undefined ? { editValue } : {}),
      ...(raw !== undefined && editValue === undefined
        ? { readOnlyReason: `Control edits only a measured ${setting.inputKind} value for this key.` }
        : {}),
    };
  });
  for (const authority of AUTHORITY_SETTINGS) {
    const raw = atPath(parsed.value, authority.key);
    if (raw === undefined) continue;
    knownSettings.push({
      key: authority.key,
      label: authority.label,
      editable: false,
      ...(displayValue(raw) !== undefined ? { value: displayValue(raw) } : {}),
      readOnlyReason: AUTHORITY_READ_ONLY_REASON,
    });
  }
  const leaves = leafPaths(parsed.value);
  const opaque = [...new Set(leaves.map(opaqueSectionOf).filter((section): section is string => !!section))].sort();
  const owned = new Set([
    ...GLOBAL_SETTINGS.map((setting) => setting.key),
    ...AUTHORITY_SETTINGS.map((setting) => setting.key),
  ]);
  return {
    ...base,
    knownSettings,
    mcpServers: mcpServers(parsed.value, read.text),
    unknownKeys: leaves
      .filter((leaf) => !owned.has(leaf))
      .filter((leaf) => !opaqueSectionOf(leaf))
      .filter((leaf) => !RUNTIME_OWNED_KEYS.has(leaf))
      .sort(),
    internalStateCount: leaves.filter((leaf) => RUNTIME_OWNED_KEYS.has(leaf)).length,
    opaqueKeys: opaque,
    impact: GLOBAL_IMPACT,
  };
}

function workspaceConfigDocument(file: string): RuntimeConfigDocumentInventory {
  const { read, base } = documentBase(GROK_WORKSPACE_CONFIG_DOCUMENT, "Workspace config", "workspace", "config", file);
  const parsed = safeParse(read.text);
  if (read.error || parsed.error || !parsed.value) {
    return { ...base, ...emptyBody(read.error ?? parsed.error), impact: WORKSPACE_IMPACT };
  }
  const leaves = leafPaths(parsed.value);
  return {
    ...base,
    // Grok reads no scalar from a project config, so Control offers none: an editor that writes a
    // key the runtime ignores would be worse than no editor at all.
    knownSettings: [],
    mcpServers: mcpServers(parsed.value, read.text),
    unknownKeys: [...new Set(leaves.filter((leaf) => !leaf.startsWith("mcp_servers.")).map((leaf) => leaf.split(".")[0]!))].sort(),
    internalStateCount: 0,
    opaqueKeys: leaves.some((leaf) => leaf.startsWith("mcp_servers.")) ? ["mcp_servers"] : [],
    impact: WORKSPACE_IMPACT,
  };
}

/**
 * Read-only view of `$GROK_HOME/trusted_folders.toml` for this workspace. Measured 2026-07-28:
 * with the folder untrusted, `grok inspect` reported no project hooks; after the entry was added,
 * the `.grok/hooks/` hook appeared. Control reports that state and never changes it.
 */
function trustDocument(file: string, workspaceRoot: string): RuntimeConfigDocumentInventory {
  const { read, base } = documentBase(GROK_TRUST_DOCUMENT, "Folder trust", "global", "trust", file);
  const parsed = safeParse(read.text);
  if (read.error || parsed.error || !parsed.value) {
    return { ...base, ...emptyBody(read.error ?? parsed.error), readOnly: true, impact: TRUST_IMPACT };
  }
  const folders = isRecord(parsed.value.folders) ? parsed.value.folders : {};
  const entry = Object.entries(folders).find(([folder]) => path.resolve(folder) === path.resolve(workspaceRoot));
  const trusted = entry && isRecord(entry[1]) ? entry[1].trusted === true : undefined;
  const decidedAt = entry && isRecord(entry[1]) && typeof entry[1].decided_at === "number"
    ? new Date(entry[1].decided_at * 1000).toISOString()
    : undefined;
  return {
    ...base,
    knownSettings: [
      {
        key: "trusted",
        label: "This workspace is trusted",
        editable: false,
        value: trusted === undefined ? "Not decided" : String(trusted),
        readOnlyReason: "Trust is granted through Grok's own folder-trust prompt, never by Control.",
      },
      ...(decidedAt ? [{
        key: "decided_at",
        label: "Decided at",
        editable: false,
        value: decidedAt,
        readOnlyReason: "Recorded by Grok when the folder-trust decision was made.",
      }] : []),
    ],
    mcpServers: [],
    // Other trusted paths are none of this workspace's business, and they are not
    // runtime-managed records either — so they are neither listed nor counted.
    unknownKeys: [],
    internalStateCount: 0,
    readOnly: true,
    impact: TRUST_IMPACT,
  };
}

/**
 * Grok's config home. `GROK_HOME` overrides `~/.grok` natively, but a Tachyon-managed private home
 * must never be mistaken for the person's home (t-303f2b) — and a Dev Host profile home always wins,
 * so dogfood cannot reach the real one.
 */
export function grokConfigHome(input: { homeDir?: string; env?: NodeJS.ProcessEnv; profileHome?: boolean }): string {
  const home = input.homeDir ?? os.homedir();
  const override = input.profileHome ? undefined : input.env?.GROK_HOME?.trim();
  if (override && override.length > 0 && !isTachyonManagedGrokHome(override)) return override;
  return path.join(home, ".grok");
}

export function inspectGrokRuntimeConfig(input: {
  workspaceRoot: string;
  agents: Record<string, AgentDef>;
  homeDir?: string;
  grokHome?: string;
  pendingAgents?: string[];
}): GrokRuntimeConfigInventory {
  const home = input.grokHome ?? path.join(input.homeDir ?? os.homedir(), ".grok");
  const potentialAgents = Object.entries(input.agents)
    .filter(([, definition]) => binaryOf(definition.cmd) === "grok")
    .map(([name]) => name)
    .sort();
  return {
    runtime: "grok",
    label: "xAI Grok",
    documents: [
      globalConfigDocument(path.join(home, "config.toml")),
      workspaceConfigDocument(path.join(input.workspaceRoot, ".grok", "config.toml")),
      trustDocument(path.join(home, "trusted_folders.toml"), input.workspaceRoot),
    ],
    potentialAgents,
    pendingAgents: [...(input.pendingAgents ?? [])].filter((name) => potentialAgents.includes(name)).sort(),
  };
}

/** The scope a saved document belongs to — global edits reach no managed agent (see GLOBAL_IMPACT). */
export function grokDocumentScope(documentId: string): "global" | "workspace" {
  return documentId === GROK_WORKSPACE_CONFIG_DOCUMENT ? "workspace" : "global";
}

function targetPath(documentId: string, workspaceRoot: string, home: string): string {
  if (documentId === GROK_GLOBAL_CONFIG_DOCUMENT) return path.join(home, "config.toml");
  if (documentId === GROK_WORKSPACE_CONFIG_DOCUMENT) return path.join(workspaceRoot, ".grok", "config.toml");
  throw new Error("This Grok document is read-only.");
}

function renderToml(value: string | boolean | number): string {
  return JSON.stringify(value);
}

/**
 * Patch one scalar inside a bare table without reformatting anything else in the file. `create`
 * stays false for MCP servers: Control may flip a declared server, never invent one.
 */
function patchScalar(text: string, table: string | undefined, leaf: string, rendered: string, create: boolean): string {
  const lines = text.split("\n");
  const assignment = (start: number, end: number, key: string): boolean => {
    const expression = new RegExp(`^(\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=).*$`);
    for (let index = start; index < end; index++) {
      const match = lines[index]?.match(expression);
      if (match) {
        lines[index] = `${match[1]} ${rendered}`;
        return true;
      }
    }
    return false;
  };
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const preambleEnd = firstTable === -1 ? lines.length : firstTable;
  if (!table) {
    if (!assignment(0, preambleEnd, leaf)) lines.splice(preambleEnd, 0, `${leaf} = ${rendered}`);
    return lines.join("\n");
  }
  // A root dotted assignment is the most specific existing spelling; keep using it.
  if (assignment(0, preambleEnd, `${table}.${leaf}`)) return lines.join("\n");
  const range = tableHeaderRange(lines, table);
  if (range) {
    if (!assignment(range.start + 1, range.end, leaf)) lines.splice(range.end, 0, `${leaf} = ${rendered}`);
    return lines.join("\n");
  }
  if (!create) throw new Error("This entry is no longer present in the source. Reload it before saving.");
  const suffix = text.trim().length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${suffix}[${table}]\n${leaf} = ${rendered}\n`;
}

function validatedSetting(documentId: string, key: string, value: unknown): { table?: string; leaf: string; rendered: string } {
  if (documentId !== GROK_GLOBAL_CONFIG_DOCUMENT) {
    throw new Error("Grok reads only [mcp_servers] from a project config, so Control does not write settings there.");
  }
  const setting = GLOBAL_SETTINGS.find((candidate) => candidate.key === key);
  if (!setting) throw new Error("Unsupported Grok Runtime Config setting.");
  const typed = typedSettingValue(setting, value);
  if (typed === undefined) throw new Error(`Unsupported value for '${key}' (measured against ${GROK_MEASURED_CLI_VERSION}).`);
  const segments = setting.key.split(".");
  return {
    table: segments.length > 1 ? segments.slice(0, -1).join(".") : undefined,
    leaf: segments[segments.length - 1]!,
    rendered: renderToml(typed),
  };
}

export function applyGrokRuntimeConfigChange(input: {
  workspaceRoot: string;
  homeDir?: string;
  grokHome?: string;
  documentId: string;
  expectedRevision?: string;
  changes: RuntimeConfigChange[];
}): { path: string; revision: string } {
  const home = input.grokHome ?? path.join(input.homeDir ?? os.homedir(), ".grok");
  const file = targetPath(input.documentId, input.workspaceRoot, home);
  const lock = `${file}.tachyon-runtime-config.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lockFd: number | undefined;
  try {
    lockFd = fs.openSync(lock, "wx", 0o600);
    const before = readRegularFile(file);
    if (before.error) throw new Error(before.error);
    const actualRevision = before.text === undefined ? undefined : digest(before.text);
    if (actualRevision !== input.expectedRevision) {
      throw new Error("The source changed since it was opened. Reload it before saving.");
    }
    const parsed = safeParse(before.text);
    if (parsed.error || !parsed.value) {
      throw new Error("This source is invalid TOML. Open the file to repair it before using Runtime Config.");
    }
    if (input.changes.length === 0) throw new Error("No runtime configuration changes were supplied.");
    let after = before.text ?? "";
    for (const change of input.changes) {
      if (change.kind === "setting") {
        const { table, leaf, rendered } = validatedSetting(input.documentId, change.key, change.value);
        after = patchScalar(after, table, leaf, rendered, true);
        continue;
      }
      if (change.kind !== "set-mcp-enabled") throw new Error("Unsupported Grok Runtime Config change.");
      if (!/^[A-Za-z0-9_-]+$/.test(change.name)) throw new Error("Invalid MCP server name.");
      const declared = isRecord(parsed.value.mcp_servers) ? parsed.value.mcp_servers[change.name] : undefined;
      if (declared === undefined) throw new Error("This MCP server is no longer present. Reload the source before saving.");
      if (!tableHeaderRange(after.split("\n"), `mcp_servers.${change.name}`)) {
        throw new Error("This MCP server is not declared as a [mcp_servers.<name>] table, so Control does not rewrite it.");
      }
      // Measured on grok 0.2.112: a server with `enabled = false` disappears from `grok inspect`.
      after = patchScalar(after, `mcp_servers.${change.name}`, "enabled", renderToml(change.enabled), false);
    }
    const reparsed = safeParse(after);
    if (reparsed.error || !reparsed.value) throw new Error("The proposed change would produce invalid TOML.");
    const text = after.endsWith("\n") || after.length === 0 ? after : `${after}\n`;
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, text, { encoding: "utf8", mode: before.mode ?? 0o600, flush: true });
      if (before.mode !== undefined) fs.chmodSync(temporary, before.mode);
      const current = readRegularFile(file);
      if ((current.text === undefined ? undefined : digest(current.text)) !== actualRevision) {
        throw new Error("The source changed before it could be saved. Reload it before trying again.");
      }
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
    }
    return { path: file, revision: digest(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Another Runtime Config save is in progress. Reload before trying again.");
    }
    throw error;
  } finally {
    if (lockFd !== undefined) fs.closeSync(lockFd);
    try { fs.unlinkSync(lock); } catch { /* lock was never acquired */ }
  }
}
