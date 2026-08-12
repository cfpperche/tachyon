import fs from "node:fs";
import path from "node:path";
import { parse, parseDocument, stringify } from "yaml";
import { AGENT_NAME_PATTERN } from "./nameValidation.js";

export const TERMINAL_DECLARATIONS_DIRECTORY = ".tachyon/terminals";
export const LEGACY_TERMINALS_BLOCK_WARNING =
  "terminals: in tachyon.yml is legacy and continues to load; new declarations live at "
  + ".tachyon/terminals/<name>.yml.";

function assertName(name: string): void {
  if (!AGENT_NAME_PATTERN.test(name)) throw new Error(`invalid terminal name '${name}'`);
}

export function terminalDeclarationPath(workspaceRoot: string, name: string): string {
  assertName(name);
  return path.join(workspaceRoot, TERMINAL_DECLARATIONS_DIRECTORY, `${name}.yml`);
}

function serializable(definition: Record<string, unknown>): Record<string, unknown> {
  const { kind: _kind, ...entry } = definition;
  if (typeof entry.cmd !== "string" || entry.cmd.trim().length === 0) throw new Error("terminal requires a non-empty command");
  if (Array.isArray(entry.watch) && entry.watch.length === 0) delete entry.watch;
  return entry;
}

function carryUnauthoredForward(
  prior: Record<string, unknown> | undefined,
  definition: Record<string, unknown>,
): Record<string, unknown> {
  if (!prior) return definition;
  const merged = { ...definition };
  if (merged.env === undefined && prior.env !== undefined) merged.env = prior.env;
  const priorAttention = prior.attention;
  if (priorAttention && typeof priorAttention === "object" && !Array.isArray(priorAttention)) {
    const preserved = priorAttention as Record<string, unknown>;
    const next = merged.attention;
    merged.attention = typeof next === "object" && next !== null
      ? { ...preserved, ...next }
      : { ...preserved, enabled: typeof next === "boolean" ? next : false };
  }
  return merged;
}

function write(workspaceRoot: string, name: string, definition: Record<string, unknown>): void {
  const file = terminalDeclarationPath(workspaceRoot, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, stringify(serializable(definition)), "utf8");
  fs.renameSync(temporary, file);
}

export function upsertTerminalDeclaration(
  workspaceRoot: string,
  name: string,
  definition: Record<string, unknown>,
  replaceName?: string,
): void {
  const destination = terminalDeclarationPath(workspaceRoot, name);
  if (replaceName === undefined && fs.existsSync(destination)) throw new Error(`terminal '${name}' already exists`);
  if (replaceName !== undefined && replaceName !== name) {
    const source = terminalDeclarationPath(workspaceRoot, replaceName);
    if (!fs.existsSync(source)) throw new Error(`terminal '${replaceName}' does not exist`);
    if (fs.existsSync(destination)) throw new Error(`terminal '${name}' already exists`);
    const prior = readTerminalDeclaration(workspaceRoot, replaceName);
    write(workspaceRoot, name, carryUnauthoredForward(prior, definition));
    fs.unlinkSync(source);
    return;
  }
  if (replaceName !== undefined && !fs.existsSync(terminalDeclarationPath(workspaceRoot, replaceName))) {
    throw new Error(`terminal '${replaceName}' does not exist`);
  }
  const prior = replaceName !== undefined ? readTerminalDeclaration(workspaceRoot, replaceName) : undefined;
  write(workspaceRoot, name, carryUnauthoredForward(prior, definition));
}

export function readTerminalDeclaration(workspaceRoot: string, name: string): Record<string, unknown> {
  const file = terminalDeclarationPath(workspaceRoot, name);
  const value: unknown = parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${TERMINAL_DECLARATIONS_DIRECTORY}/${name}.yml must be a mapping`);
  return value as Record<string, unknown>;
}

export function cloneTerminalDeclaration(workspaceRoot: string, source: string, newName: string): void {
  const destination = terminalDeclarationPath(workspaceRoot, newName);
  if (fs.existsSync(destination)) throw new Error(`terminal '${newName}' already exists`);
  write(workspaceRoot, newName, readTerminalDeclaration(workspaceRoot, source));
}

export function renameTerminalDeclaration(workspaceRoot: string, oldName: string, newName: string): void {
  upsertTerminalDeclaration(workspaceRoot, newName, readTerminalDeclaration(workspaceRoot, oldName), oldName);
}

export function deleteTerminalDeclaration(workspaceRoot: string, name: string): void {
  const file = terminalDeclarationPath(workspaceRoot, name);
  if (!fs.existsSync(file)) throw new Error(`terminal '${name}' does not exist`);
  fs.unlinkSync(file);
}

/** Compatibility mutation for a legacy hand-authored block. It remains readable forever. */
export function deleteLegacyTerminalDeclaration(text: string, name: string): { text: string; warnings: string[] } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`tachyon.yml is not parseable: ${doc.errors[0]!.message}`);
  if (!doc.hasIn(["terminals", name])) throw new Error(`terminal '${name}' does not exist`);
  doc.deleteIn(["terminals", name]);
  const terminals = doc.get("terminals") as { items?: unknown[] } | undefined;
  if (terminals?.items?.length === 0) doc.delete("terminals");
  return { text: String(doc), warnings: [] };
}

export interface TerminalDeclarationScan {
  declarations: Record<string, Record<string, unknown>>;
  warnings: string[];
}

export function scanTerminalDeclarations(workspaceRoot: string): TerminalDeclarationScan {
  const directory = path.join(workspaceRoot, TERMINAL_DECLARATIONS_DIRECTORY);
  const declarations: Record<string, Record<string, unknown>> = {};
  const warnings: string[] = [];
  if (!fs.existsSync(directory)) return { declarations, warnings };
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".yml")) continue;
    const name = entry.name.slice(0, -4);
    try {
      assertName(name);
      declarations[name] = readTerminalDeclaration(workspaceRoot, name);
    } catch (error) {
      warnings.push(`${TERMINAL_DECLARATIONS_DIRECTORY}/${entry.name}: ${error instanceof Error ? error.message : String(error)} — dropped`);
    }
  }
  return { declarations, warnings };
}
