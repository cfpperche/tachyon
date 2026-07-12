/**
 * t-8354ae — Last-Known-Good config roster snapshot.
 *
 * Machine-local (under .tachyon/, gitignored). Written on every successful config load.
 * READ path only for degraded sidebar rendering when tachyon.yml is invalid —
 * never a source of truth for spawn/autostart.
 */
import fs from "node:fs";
import path from "node:path";
import type { EntryKind, TachyonConfig } from "./loadConfig.js";

export const CONFIG_LKG_FILENAME = "config.lkg.json";
export const CONFIG_LKG_SCHEMA_VERSION = 1 as const;

export interface ConfigLkgAgent {
  name: string;
  kind: EntryKind;
  /** best-effort command for model badge / terminal sub-line; never used to spawn */
  cmd?: string;
  declaredOwner?: string;
}

export interface ConfigLkgSnapshot {
  schemaVersion: typeof CONFIG_LKG_SCHEMA_VERSION;
  savedAt: string;
  /** basename of the config file that produced this snapshot (tachyon.yml / tachyon.yaml) */
  sourceFile: string;
  agents: ConfigLkgAgent[];
}

export function configLkgPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", CONFIG_LKG_FILENAME);
}

/** Build a roster-only snapshot from a successfully parsed config. */
export function snapshotFromConfig(config: TachyonConfig, sourceFile: string, now = new Date()): ConfigLkgSnapshot {
  const agents: ConfigLkgAgent[] = Object.entries(config.agents)
    .map(([name, def]) => {
      const row: ConfigLkgAgent = {
        name,
        kind: def.kind,
        ...(def.cmd ? { cmd: def.cmd } : {}),
        ...(config.declaredOwner[name] ? { declaredOwner: config.declaredOwner[name] } : {}),
      };
      return row;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    schemaVersion: CONFIG_LKG_SCHEMA_VERSION,
    savedAt: now.toISOString(),
    sourceFile: path.basename(sourceFile),
    agents,
  };
}

/** Best-effort write; never throws into the config load path. */
export function writeConfigLkg(workspaceRoot: string, snapshot: ConfigLkgSnapshot): void {
  try {
    const dir = path.join(workspaceRoot, ".tachyon");
    fs.mkdirSync(dir, { recursive: true });
    const file = configLkgPath(workspaceRoot);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch {
    /* LKG is advisory — a write failure must never block a successful config load */
  }
}

/** Tolerant read — missing/corrupt file → null (never throws). */
export function readConfigLkg(workspaceRoot: string): ConfigLkgSnapshot | null {
  try {
    const raw = fs.readFileSync(configLkgPath(workspaceRoot), "utf8");
    return parseConfigLkg(raw);
  } catch {
    return null;
  }
}

export function parseConfigLkg(raw: string): ConfigLkgSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.schemaVersion !== CONFIG_LKG_SCHEMA_VERSION) return null;
  if (typeof o.savedAt !== "string" || !o.savedAt) return null;
  if (typeof o.sourceFile !== "string" || !o.sourceFile) return null;
  if (!Array.isArray(o.agents)) return null;
  const agents: ConfigLkgAgent[] = [];
  for (const item of o.agents) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.name !== "string" || !a.name) continue;
    const kind: EntryKind = a.kind === "terminal" ? "terminal" : "agent";
    agents.push({
      name: a.name,
      kind,
      ...(typeof a.cmd === "string" && a.cmd ? { cmd: a.cmd } : {}),
      ...(typeof a.declaredOwner === "string" && a.declaredOwner ? { declaredOwner: a.declaredOwner } : {}),
    });
  }
  return {
    schemaVersion: CONFIG_LKG_SCHEMA_VERSION,
    savedAt: o.savedAt,
    sourceFile: o.sourceFile,
    agents,
  };
}
