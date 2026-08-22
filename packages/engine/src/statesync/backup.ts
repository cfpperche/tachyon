import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DURABLE_STATE_MANIFEST, isAtomicTemp, isSecretPath, type DurableEntry } from "./manifest.js";
import type { StateBackupAdapter } from "./adapter.js";

/**
 * t-5786bc — backup and restore of the durable-state allowlist.
 *
 * Model: every backup is one WHOLE, self-contained generation —
 *   generations/<id>/<workspace-relative path>   (the files, verbatim)
 *   generations/<id>.manifest.json               (what was written, with sha256s)
 *   latest                                       (the id of the newest complete generation)
 * The manifest is written AFTER every file and `latest` after the manifest, so a torn backup is
 * never the one a restore picks up. Point-in-time = pick a generation id; pruning keeps the last N.
 */

export interface GenerationManifest {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  workspaceRoot: string;
  files: { path: string; size: number; sha256: string }[];
}

export interface BackupStats {
  generationId: string;
  files: number;
  bytes: number;
  prunedGenerations: string[];
}

export interface RestoreStats {
  generationId: string;
  files: number;
  bytes: number;
}

/** Resolve the manifest against a real workspace: the concrete files a backup pass will read. */
export function collectDurableFiles(workspaceRoot: string, manifest: readonly DurableEntry[] = DURABLE_STATE_MANIFEST): string[] {
  const out: string[] = [];
  const pushFile = (rel: string): void => {
    // Belt and suspenders: the manifest module already refuses secret entries; refuse again per
    // resolved file so a symlinked or nested surprise cannot ride an allowed directory out.
    if (isSecretPath(rel) || isAtomicTemp(rel)) return;
    out.push(rel);
  };
  for (const entry of manifest) {
    const abs = path.join(workspaceRoot, entry.relPath);
    if (entry.kind === "file") {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) pushFile(entry.relPath);
      continue;
    }
    const walk = (dir: string, rel: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const child of entries) {
        const childRel = `${rel}/${child.name}`;
        if (child.isDirectory()) walk(path.join(dir, child.name), childRel);
        else if (child.isFile() && (!entry.include || entry.include(childRel))) pushFile(childRel);
      }
    };
    walk(abs, entry.relPath);
  }
  return out.sort();
}

// Monotonic within the process so that two backups in the same millisecond still sort in the
// order they ran (generation ids are compared lexicographically by prune and list).
let generationSeq = 0;
function newGenerationId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  generationSeq = (generationSeq + 1) % 10000;
  return `${stamp}-${String(generationSeq).padStart(4, "0")}-${crypto.randomBytes(3).toString("hex")}`;
}

export async function runBackup(
  workspaceRoot: string,
  adapter: StateBackupAdapter,
  options: { keepGenerations?: number } = {},
): Promise<BackupStats> {
  const id = newGenerationId();
  const files: GenerationManifest["files"] = [];
  let bytes = 0;
  for (const rel of collectDurableFiles(workspaceRoot)) {
    let content: Buffer;
    try {
      content = fs.readFileSync(path.join(workspaceRoot, rel));
    } catch (error) {
      // A store may replace its file between walk and read; the next pass picks it up.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await adapter.put(`generations/${id}/${rel}`, content);
    files.push({ path: rel, size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex") });
    bytes += content.length;
  }
  const manifest: GenerationManifest = { schemaVersion: 1, id, createdAt: new Date().toISOString(), workspaceRoot, files };
  await adapter.put(`generations/${id}.manifest.json`, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  await adapter.put("latest", Buffer.from(id, "utf8"));

  const keep = Math.max(1, options.keepGenerations ?? 30);
  const prunedGenerations = await pruneGenerations(adapter, keep, id);
  return { generationId: id, files: files.length, bytes, prunedGenerations };
}

export async function listGenerationIds(adapter: StateBackupAdapter): Promise<string[]> {
  const keys = await adapter.list("generations");
  return keys
    .filter((key) => key.endsWith(".manifest.json"))
    .map((key) => key.slice("generations/".length, -".manifest.json".length))
    .sort();
}

async function pruneGenerations(adapter: StateBackupAdapter, keep: number, current: string): Promise<string[]> {
  const ids = await listGenerationIds(adapter);
  // Generation ids sort chronologically (ISO stamp prefix). Never prune the one just written.
  const excess = ids.filter((generationId) => generationId !== current).slice(0, Math.max(0, ids.length - keep));
  for (const generationId of excess) {
    for (const key of await adapter.list(`generations/${generationId}`)) await adapter.remove(key);
    await adapter.remove(`generations/${generationId}.manifest.json`);
  }
  return excess;
}

export async function readGenerationManifest(adapter: StateBackupAdapter, generationId?: string): Promise<GenerationManifest | null> {
  let id = generationId;
  if (!id) {
    const latest = await adapter.get("latest");
    if (!latest) return null;
    id = latest.toString("utf8").trim();
  }
  const raw = await adapter.get(`generations/${id}.manifest.json`);
  if (!raw) return null;
  const parsed = JSON.parse(raw.toString("utf8")) as GenerationManifest;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.files)) {
    throw new Error(`backup generation ${id} has an unsupported manifest`);
  }
  return parsed;
}

/**
 * Repopulate a workspace from a generation. Refuses to touch a workspace that already has any of
 * the files unless `force` — restore is for a FRESH checkout; overwriting live state is a decision
 * the human makes explicitly, not a side effect.
 */
export async function runRestore(
  workspaceRoot: string,
  adapter: StateBackupAdapter,
  options: { generationId?: string; force?: boolean } = {},
): Promise<RestoreStats> {
  const manifest = await readGenerationManifest(adapter, options.generationId);
  if (!manifest) throw new Error(`no backup generation found at ${adapter.description}`);
  if (!options.force) {
    const existing = manifest.files.filter((file) => fs.existsSync(path.join(workspaceRoot, file.path)));
    if (existing.length > 0) {
      throw new Error(
        `restore would overwrite ${existing.length} existing file(s) (first: ${existing[0].path}); pass force to allow it`,
      );
    }
  }
  let bytes = 0;
  for (const file of manifest.files) {
    const content = await adapter.get(`generations/${manifest.id}/${file.path}`);
    if (!content) throw new Error(`backup generation ${manifest.id} is missing ${file.path}`);
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    if (sha256 !== file.sha256) throw new Error(`backup file ${file.path} failed checksum verification`);
    const target = path.join(workspaceRoot, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    bytes += content.length;
  }
  return { generationId: manifest.id, files: manifest.files.length, bytes };
}
