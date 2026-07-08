import fs from "node:fs";
import path from "node:path";

export interface OpencodeStorageSession {
  id: string;
  path: string;
}

export function resolveOpencodeStorageSession(cwd: string, dataHome: string, id?: string): OpencodeStorageSession | null {
  const storageRoot = path.join(dataHome, "opencode", "storage");
  const projectId = resolveOpencodeProjectId(storageRoot, cwd);
  for (const file of findOpencodeSessionFiles(path.join(storageRoot, "session"))) {
    const sessionId = path.basename(file, ".json");
    if (id && sessionId !== id) continue;
    try {
      const session = JSON.parse(fs.readFileSync(file, "utf8")) as { id?: string; directory?: string };
      const directory = typeof session.directory === "string" ? session.directory : "";
      const matchesDirectory = directory !== "" && path.resolve(directory) === path.resolve(cwd);
      const matchesLegacyProject = directory === "" && !!projectId && path.basename(path.dirname(file)) === projectId;
      if ((session.id === undefined || session.id === sessionId) && (matchesDirectory || matchesLegacyProject)) return { id: sessionId, path: storageRoot };
    } catch {
      if (projectId && path.basename(path.dirname(file)) === projectId) return { id: sessionId, path: storageRoot };
    }
  }
  return null;
}

function resolveOpencodeProjectId(storageRoot: string, cwd: string): string | null {
  try {
    for (const f of fs.readdirSync(path.join(storageRoot, "project"))) {
      if (!f.endsWith(".json")) continue;
      const proj = JSON.parse(fs.readFileSync(path.join(storageRoot, "project", f), "utf8")) as { id?: string; worktree?: string };
      if (typeof proj.id === "string" && typeof proj.worktree === "string" && path.resolve(proj.worktree) === path.resolve(cwd)) return proj.id;
    }
  } catch {
    return null;
  }
  return null;
}

function findOpencodeSessionFiles(dir: string): string[] {
  const out: { p: string; mtime: number }[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^ses_.*\.json$/.test(e.name)) {
        try { out.push({ p, mtime: fs.statSync(p).mtimeMs }); } catch { /* vanished */ }
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => b.mtime - a.mtime).map((f) => f.p);
}
