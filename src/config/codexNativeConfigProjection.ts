import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "@iarna/toml";
import {
  carryNativeConfigSources,
  nativeConfigAuthorizations,
  CODEX_FULL_ACCESS_AUTHORIZATION,
  CODEX_NEVER_APPROVAL_AUTHORIZATION,
  type ResolvedAgentNativeConfigProjection,
} from "./agentNativeConfigPolicy.js";
import type { AgentProfileV1 } from "./agentProfileSchema.js";
import { getCodexMcpServerBlock, removeCodexMcpServer } from "../registration/adapters.js";

type ScalarFamily = "permissions" | "interface" | "featureFlags";
type SourceName = "global" | "workspace";

export interface CodexNativeConfigSourceTexts {
  global?: string;
  workspace?: string;
}

export interface CodexNativeConfigProjectionResult {
  projection: ResolvedAgentNativeConfigProjection;
  errors: string[];
  warnings: string[];
}

const FAMILY_KEYS: Record<ScalarFamily, readonly string[]> = {
  permissions: ["approval_policy", "sandbox_mode"],
  interface: ["personality", "tui.status_line", "tui.status_line_use_colors"],
  featureFlags: ["features.terminal_resize_reflow"],
};

/** The closed, measured Codex settings that Control may change. */
export const CODEX_EDITABLE_SETTING_KEYS = [
  "approval_policy",
  "sandbox_mode",
  "personality",
  "tui.status_line",
  "tui.status_line_use_colors",
  "features.terminal_resize_reflow",
] as const;

export type CodexEditableSettingKey = typeof CODEX_EDITABLE_SETTING_KEYS[number];
export type CodexEditableSettingValue = string | boolean | string[];
export type CodexNativeConfigScope = "global" | "workspace";

export type CodexNativeConfigChange =
  | { kind: "setting"; key: CodexEditableSettingKey; value: CodexEditableSettingValue }
  | { kind: "set-mcp-enabled"; name: string; enabled: boolean };

export interface ApplyCodexNativeConfigChangeInput {
  workspaceRoot: string;
  scope: CodexNativeConfigScope;
  expectedRevision?: string;
  changes?: CodexNativeConfigChange[];
  /** Transitional single-change spelling for callers outside the Control batch path. */
  change?: CodexNativeConfigChange;
  homeDir?: string;
}

export interface ApplyCodexNativeConfigChangeResult {
  path: string;
  revision: string;
}

function digest(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Codex updates hooks.state while sessions are alive. Those records are runtime-owned and hidden
 * from Control, so they must not make an otherwise unrelated human edit look stale.
 */
export function codexNativeConfigRevision(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = parse(text) as Record<string, unknown>;
    const stable = structuredClone(parsed);
    const hooks = stable.hooks;
    if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
      delete (hooks as Record<string, unknown>).state;
    }
    return digest(JSON.stringify(stable));
  } catch {
    return digest(text);
  }
}

function nativeConfigPath(scope: CodexNativeConfigScope, workspaceRoot: string, homeDir: string): string {
  return scope === "global"
    ? path.join(homeDir, ".codex", "config.toml")
    : path.join(workspaceRoot, ".codex", "config.toml");
}

function isEditableKey(key: string): key is CodexEditableSettingKey {
  return (CODEX_EDITABLE_SETTING_KEYS as readonly string[]).includes(key);
}

function validValue(key: CodexEditableSettingKey, value: CodexEditableSettingValue): boolean {
  if (key === "tui.status_line") return Array.isArray(value) && value.every((item) => typeof item === "string");
  if (key === "tui.status_line_use_colors" || key === "features.terminal_resize_reflow") return typeof value === "boolean";
  return typeof value === "string";
}

function tomlValue(value: CodexEditableSettingValue): string {
  return JSON.stringify(value);
}

function patchLine(lines: string[], start: number, end: number, key: string, value: string): boolean {
  const expression = new RegExp(`^(\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=).*$`);
  for (let index = start; index < end; index++) {
    const match = lines[index]?.match(expression);
    if (match) {
      lines[index] = `${match[1]} ${value}`;
      return true;
    }
  }
  return false;
}

/**
 * Change one owned scalar without parsing/re-stringifying unrelated TOML. The fixed
 * keys let this remain a deliberately small patcher rather than a generic editor.
 */
function patchCodexSetting(text: string, key: CodexEditableSettingKey, value: CodexEditableSettingValue): string {
  const lines = text.split("\n");
  const rendered = tomlValue(value);
  const [table, leaf] = key.includes(".") ? key.split(".") as [string, string] : [undefined, key];
  if (!table) {
    const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
    const end = firstTable === -1 ? lines.length : firstTable;
    if (!patchLine(lines, 0, end, leaf, rendered)) lines.splice(end, 0, `${leaf} = ${rendered}`);
    return lines.join("\n");
  }

  // A root dotted assignment is the most specific existing representation; retain it.
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  if (patchLine(lines, 0, firstTable === -1 ? lines.length : firstTable, key, rendered)) return lines.join("\n");
  const header = new RegExp(`^\\s*\\[${table.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\]\\s*$`);
  const tableStart = lines.findIndex((line) => header.test(line));
  if (tableStart !== -1) {
    let tableEnd = lines.length;
    for (let index = tableStart + 1; index < lines.length; index++) {
      if (/^\s*\[/.test(lines[index])) { tableEnd = index; break; }
    }
    if (!patchLine(lines, tableStart + 1, tableEnd, leaf, rendered)) lines.splice(tableEnd, 0, `${leaf} = ${rendered}`);
    return lines.join("\n");
  }
  const suffix = text.trim().length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${suffix}[${table}]\n${leaf} = ${rendered}\n`;
}

function readEditableText(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("source must be a regular file");
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function atomicWrite(file: string, text: string, expectedRevision: string | undefined, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", mode: mode ?? 0o600, flush: true });
    if (mode !== undefined) fs.chmodSync(temporary, mode);
    const current = readEditableText(file);
    if (codexNativeConfigRevision(current) !== expectedRevision) {
      throw new Error("The source changed before it could be saved. Reload it before trying again.");
    }
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

/**
 * Canonical SDD 442 mutation boundary for the small Codex subset Tachyon measures.
 * It verifies the snapshot revision, validates the full TOML before and after the
 * targeted patch, then atomically replaces the source file.
 */
export function applyCodexNativeConfigChange(input: ApplyCodexNativeConfigChangeInput): ApplyCodexNativeConfigChangeResult {
  const homeDir = input.homeDir ?? os.homedir();
  const file = nativeConfigPath(input.scope, input.workspaceRoot, homeDir);
  const before = readEditableText(file);
  const actualRevision = codexNativeConfigRevision(before);
  if (actualRevision !== input.expectedRevision) throw new Error("The source changed since it was opened. Reload it before saving.");
  if (before !== undefined) {
    try { parse(before); } catch { throw new Error("This source is invalid TOML. Open the file to repair it before using Runtime Config."); }
  }

  const changes = input.changes ?? (input.change ? [input.change] : []);
  if (changes.length === 0) throw new Error("No runtime configuration changes were supplied.");
  let after = before ?? "";
  for (const change of changes) {
    if (change.kind === "setting") {
      if (!isEditableKey(change.key) || !validValue(change.key, change.value)) throw new Error("Unsupported Codex setting value.");
      after = patchCodexSetting(after, change.key, change.value);
      continue;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(change.name)) throw new Error("Invalid MCP server name.");
    if (before === undefined) throw new Error("This source does not contain that MCP server.");
    after = setCodexMcpEnabled(after, change.name, change.enabled);
  }
  try { parse(after); } catch { throw new Error("The proposed change would produce invalid TOML."); }
  const mode = before === undefined ? undefined : fs.statSync(file).mode & 0o777;
  atomicWrite(file, after, actualRevision, mode);
  return { path: file, revision: codexNativeConfigRevision(after)! };
}

const DISABLED_MCP_MARKER = "# tachyon-disabled-mcp: ";

function commentedMcpRange(text: string, name: string): { start: number; end: number } | undefined {
  const lines = text.split("\n");
  const marker = `${DISABLED_MCP_MARKER}${name}`;
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith("# ") || lines[end].trim() === "#")) end++;
  return { start, end };
}

function setCodexMcpEnabled(text: string, name: string, enabled: boolean): string {
  const disabled = commentedMcpRange(text, name);
  if (!enabled) {
    if (disabled) return text;
    const block = getCodexMcpServerBlock(text, name);
    if (!block) throw new Error("This MCP server is no longer present. Reload the source before saving.");
    const removed = removeCodexMcpServer(text, name);
    const commented = block.trimEnd().split("\n").map((line) => `# ${line}`).join("\n");
    const suffix = removed.endsWith("\n") ? "" : "\n";
    return `${removed}${suffix}${DISABLED_MCP_MARKER}${name}\n${commented}\n`;
  }
  if (!disabled) {
    const block = getCodexMcpServerBlock(text, name);
    if (!block) throw new Error("This MCP server is no longer present. Reload the source before saving.");
    return text;
  }
  const lines = text.split("\n");
  const restored = lines.slice(disabled.start + 1, disabled.end)
    .map((line) => line.startsWith("# ") ? line.slice(2) : line.slice(1))
    .join("\n");
  return [...lines.slice(0, disabled.start), restored, ...lines.slice(disabled.end)].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leafPaths(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const field = prefix ? `${prefix}.${key}` : key;
    return isRecord(child) ? leafPaths(child, field) : [field];
  });
}

function valueAt(source: Record<string, unknown>, field: string): unknown {
  return field.split(".").reduce<unknown>((value, key) => isRecord(value) ? value[key] : undefined, source);
}

function parseSource(family: ScalarFamily, source: SourceName, text: string | undefined): Record<string, unknown> | string {
  if (!text?.trim()) return {};
  try {
    const parsed = parse(text);
    return isRecord(parsed)
      ? parsed
      : `profile/native-config-source: family '${family}' source '${source}' must be a TOML table`;
  } catch (error) {
    return `profile/native-config-source: family '${family}' source '${source}' is invalid TOML: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * SDD 472 — measured against `codex-cli 0.145.0` by feeding an invalid value and reading the config
 * parser's own "expected one of" list, then loading every candidate under an isolated CODEX_HOME.
 *
 * These are the CONFIG enums, which are wider than the CLI flag enums: `--ask-for-approval` offers
 * only untrusted/on-request/never, while `config.toml` also accepts `on-failure`. Copying the flag
 * list would have refused a value real users already have.
 *
 * `granular` appears in the parser's list but is a newtype variant (a TOML table, not a scalar), so
 * it can never arrive here as a string — `typedValue` already rejects a table as "must be string".
 */
const CODEX_MEASURED_CLI_VERSION = "codex-cli 0.145.0";
const CODEX_APPROVAL_POLICIES = ["untrusted", "on-failure", "on-request", "never"] as const;
const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

/**
 * Values that hand a canonical agent real authority, each gated behind the profile authorization
 * that names that capability. Everything else in the measured enums is bounded by either an
 * approval prompt or the sandbox, and stays freely projectable.
 */
const CODEX_DANGEROUS_VALUES: Record<string, { value: string; authorization: string; consequence: string }> = {
  approval_policy: {
    value: "never",
    authorization: CODEX_NEVER_APPROVAL_AUTHORIZATION,
    consequence: "the agent never asks before running a command",
  },
  sandbox_mode: {
    value: "danger-full-access",
    authorization: CODEX_FULL_ACCESS_AUTHORIZATION,
    consequence: "the agent runs without a sandbox",
  },
};

/**
 * Read one permission scalar: type-check it, hold it to the measured enum, and require an explicit
 * per-agent authorization before a dangerous value may be projected. Inheriting the value from the
 * person's global config is never sufficient on its own.
 */
function permissionValue(
  source: SourceName,
  parsed: Record<string, unknown>,
  field: string,
  measured: readonly string[],
  authorized: ReadonlySet<string>,
  errors: string[],
  warnings: string[],
): string | undefined {
  const value = typedValue("permissions", source, parsed, field, "string", errors);
  if (value === undefined) return undefined;
  const text = value as string;
  if (!measured.includes(text)) {
    errors.push(
      `profile/native-config-value: Codex ${source} key '${field}' value '${text}' is not projectable`
      + ` (supported: ${measured.join(", ")}; measured against ${CODEX_MEASURED_CLI_VERSION})`,
    );
    return undefined;
  }
  const dangerous = CODEX_DANGEROUS_VALUES[field];
  if (dangerous && dangerous.value === text && !authorized.has(dangerous.authorization)) {
    // Existing canonical agents inherited these values before SDD 472. On upgrade, keep the agent
    // loadable but omit the unauthorized capability from its private projection. The runtime stays
    // fail-closed and the human gets an actionable path to opt in deliberately.
    warnings.push(
      `profile/native-config-value: Codex ${source} key '${field}' value '${text}' means`
      + ` ${dangerous.consequence}; it was omitted because this agent does not explicitly authorize it`
      + `; authorize it for this agent, set the Permissions family to Exclude,`
      + ` or change the ${source} value`,
    );
    return undefined;
  }
  return text;
}

function typedValue<T extends "string" | "boolean" | "string[]">(
  family: ScalarFamily,
  source: SourceName,
  parsed: Record<string, unknown>,
  field: string,
  expected: T,
  errors: string[],
): string | boolean | string[] | undefined {
  const value = valueAt(parsed, field);
  if (value === undefined) return undefined;
  const valid = expected === "string"
    ? typeof value === "string"
    : expected === "boolean"
      ? typeof value === "boolean"
      : Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!valid) {
    errors.push(`profile/native-config-key: family '${family}' source '${source}' key '${field}' must be ${expected}`);
    return undefined;
  }
  return value as string | boolean | string[];
}

export function projectCodexScalarNativeConfig(
  profile: Pick<AgentProfileV1, "nativeConfig">,
  texts: CodexNativeConfigSourceTexts,
  base: ResolvedAgentNativeConfigProjection,
): CodexNativeConfigProjectionResult {
  // structuredClone drops the non-enumerable ownership metadata, so carry it across (t-59a11b).
  const projection = carryNativeConfigSources(structuredClone(base), base);
  const errors: string[] = [];
  const warnings: string[] = [];
  // Read from the PROFILE, never from the config file: the global file supplies a value, only this
  // agent's own authorization makes a dangerous one projectable (SDD 472).
  const authorized = nativeConfigAuthorizations(profile.nativeConfig, "permissions");
  const parsedBySource = new Map<SourceName, Record<string, unknown> | string>();
  const selectedWorkspaceKeys = new Set<string>();

  for (const family of ["permissions", "interface", "featureFlags"] as const) {
    const policy = profile.nativeConfig?.[family];
    if (!policy || (policy.source !== "global" && policy.source !== "workspace")) continue;
    if (policy.source === "workspace") for (const key of FAMILY_KEYS[family]) selectedWorkspaceKeys.add(key);
    let parsed = parsedBySource.get(policy.source);
    if (!parsed) {
      parsed = parseSource(family, policy.source, texts[policy.source]);
      parsedBySource.set(policy.source, parsed);
    }
    if (typeof parsed === "string") {
      errors.push(parsed);
      continue;
    }
    if (family === "permissions") {
      const approvalPolicy = permissionValue(
        policy.source, parsed, "approval_policy", CODEX_APPROVAL_POLICIES, authorized, errors, warnings,
      );
      const sandboxMode = permissionValue(
        policy.source, parsed, "sandbox_mode", CODEX_SANDBOX_MODES, authorized, errors, warnings,
      );
      projection.permissions = {
        ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
        ...(sandboxMode !== undefined ? { sandboxMode } : {}),
      };
    } else if (family === "interface") {
      const personality = typedValue(family, policy.source, parsed, "personality", "string", errors);
      const statusLine = typedValue(family, policy.source, parsed, "tui.status_line", "string[]", errors);
      const statusLineUseColors = typedValue(family, policy.source, parsed, "tui.status_line_use_colors", "boolean", errors);
      projection.interface = {
        ...(personality !== undefined ? { personality: personality as string } : {}),
        ...(statusLine !== undefined ? { statusLine: statusLine as string[] } : {}),
        ...(statusLineUseColors !== undefined ? { statusLineUseColors: statusLineUseColors as boolean } : {}),
      };
    } else {
      const terminalResizeReflow = typedValue(family, policy.source, parsed, "features.terminal_resize_reflow", "boolean", errors);
      projection.featureFlags = {
        ...(terminalResizeReflow !== undefined ? { terminalResizeReflow: terminalResizeReflow as boolean } : {}),
      };
    }
  }

  const workspace = parsedBySource.get("workspace");
  if (workspace && typeof workspace !== "string") {
    for (const key of leafPaths(workspace)) {
      if (!selectedWorkspaceKeys.has(key)) {
        errors.push(`profile/native-config-key: source 'workspace' key '${key}' is outside the selected family allowlist`);
      }
    }
  }
  return { projection, errors, warnings };
}
