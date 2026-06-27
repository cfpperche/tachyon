/**
 * spec 274 — durable evidence artifacts. A producer (e.g. Visual QA) attaches worktree-relative artifact refs
 * (screenshots/logs) to an evidence record; this COPIES them into a managed dir under `.tachyon/evidence/<agent>/
 * <id>/` (outside the worktree, gitignored) so the artifact survives a worktree rebuild/removal — a vanished
 * screenshot makes a verdict unauditable. Returns workspace-relative managed refs. A missing source fails cleanly;
 * identical basenames within one record are de-collided. IO is isolated here so it unit-tests with tmpdirs only.
 */
import fs from "node:fs";
import path from "node:path";
import { evidenceArtifactRelDir } from "./evidence.js";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type CopyResult = { ok: true; refs: string[] } | { ok: false; reason: string };

export function copyEvidenceArtifacts(opts: {
  workspaceRoot: string;
  worktreePath: string;
  agent: string;
  id: string;
  refs: readonly string[];
}): CopyResult {
  const { workspaceRoot, worktreePath, agent, id, refs } = opts;
  if (refs.length === 0) return { ok: true, refs: [] };

  const relDir = evidenceArtifactRelDir(agent, id);
  const absDir = path.join(workspaceRoot, relDir);
  try {
    fs.mkdirSync(absDir, { recursive: true });
  } catch (e) {
    return { ok: false, reason: `cannot create evidence dir: ${msg(e)}` };
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const src = path.join(worktreePath, ref); // the producer wrote it in the worktree
    // SECURITY (codex): copyFileSync follows symlinks — a producer could attach `shot.png` that is a symlink to a
    // readable file OUTSIDE the worktree and have Tachyon durably copy it. lstat + reject anything that isn't a
    // REAL regular file (symlink/dir/special all rejected).
    let st: fs.Stats;
    try {
      st = fs.lstatSync(src);
    } catch {
      return { ok: false, reason: `artifact not found in worktree: ${ref}` };
    }
    if (!st.isFile()) return { ok: false, reason: `artifact ref must be a real regular file (no symlink/dir/special): ${ref}` };
    let name = path.basename(ref);
    for (let i = 1; seen.has(name); i++) name = `${i}-${path.basename(ref)}`;
    seen.add(name);
    try {
      fs.copyFileSync(src, path.join(absDir, name));
    } catch (e) {
      return { ok: false, reason: `failed to copy artifact ${ref}: ${msg(e)}` };
    }
    out.push(path.posix.join(relDir, name)); // workspace-relative managed ref (survives a worktree rebuild)
  }
  return { ok: true, refs: out };
}
