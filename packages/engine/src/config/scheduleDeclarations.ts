import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { AGENT_NAME_PATTERN } from "./nameValidation.js";

/**
 * t-a65335 — schedules leave tachyon.yml: one declaration IS one file, `.tachyon/schedules/<name>.yml`,
 * the exact mould of terminalDeclarations.ts (and of `.tachyon/agents/<name>/` before it). The
 * file's mapping is the ScheduleDef body — the name lives in the filename, never duplicated inside.
 */

export const SCHEDULE_DECLARATIONS_DIRECTORY = ".tachyon/schedules";

function assertName(name: string): void {
  if (!AGENT_NAME_PATTERN.test(name)) throw new Error(`invalid schedule name '${name}'`);
}

export function scheduleDeclarationPath(workspaceRoot: string, name: string): string {
  assertName(name);
  return path.join(workspaceRoot, SCHEDULE_DECLARATIONS_DIRECTORY, `${name}.yml`);
}

function write(workspaceRoot: string, name: string, definition: Record<string, unknown>): void {
  const file = scheduleDeclarationPath(workspaceRoot, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, stringify(definition), "utf8");
  fs.renameSync(temporary, file);
}

export function upsertScheduleDeclaration(
  workspaceRoot: string,
  name: string,
  definition: Record<string, unknown>,
  options: { overwrite?: boolean } = {},
): void {
  const destination = scheduleDeclarationPath(workspaceRoot, name);
  if (!options.overwrite && fs.existsSync(destination)) throw new Error(`schedule '${name}' already exists`);
  write(workspaceRoot, name, definition);
}

export function readScheduleDeclaration(workspaceRoot: string, name: string): Record<string, unknown> {
  const file = scheduleDeclarationPath(workspaceRoot, name);
  const value: unknown = parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${SCHEDULE_DECLARATIONS_DIRECTORY}/${name}.yml must be a mapping`);
  }
  return value as Record<string, unknown>;
}

export function deleteScheduleDeclaration(workspaceRoot: string, name: string): void {
  const file = scheduleDeclarationPath(workspaceRoot, name);
  if (!fs.existsSync(file)) throw new Error(`schedule '${name}' does not exist`);
  fs.unlinkSync(file);
}

export interface ScheduleDeclarationScan {
  declarations: Record<string, Record<string, unknown>>;
  warnings: string[];
}

export function scanScheduleDeclarations(workspaceRoot: string): ScheduleDeclarationScan {
  const directory = path.join(workspaceRoot, SCHEDULE_DECLARATIONS_DIRECTORY);
  const declarations: Record<string, Record<string, unknown>> = {};
  const warnings: string[] = [];
  if (!fs.existsSync(directory)) return { declarations, warnings };
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".yml") || entry.name.includes(".tmp-")) continue;
    const name = entry.name.slice(0, -4);
    try {
      assertName(name);
      declarations[name] = readScheduleDeclaration(workspaceRoot, name);
    } catch (error) {
      warnings.push(`${SCHEDULE_DECLARATIONS_DIRECTORY}/${entry.name}: ${error instanceof Error ? error.message : String(error)} — dropped`);
    }
  }
  return { declarations, warnings };
}
