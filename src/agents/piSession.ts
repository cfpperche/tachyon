import fs from "node:fs";
import path from "node:path";

export const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

export function piSessionDir(workspaceRoot: string, agent: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(agent)) throw new Error(`invalid Pi agent name '${agent}'`);
  return path.join(workspaceRoot, ".tachyon", "pi-sessions", agent);
}

function ensureRealDirectory(dir: string): void {
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Pi session path is not a real directory: ${dir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(dir, { mode: 0o700 });
  }
}

export function removePiSessionDir(workspaceRoot: string, agent: string): void {
  const root = path.join(fs.realpathSync(workspaceRoot), ".tachyon", "pi-sessions");
  let rootStat: fs.Stats;
  try { rootStat = fs.lstatSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Pi session root is not a real directory: ${root}`);
  }
  const target = piSessionDir(fs.realpathSync(workspaceRoot), agent);
  let targetStat: fs.Stats;
  try { targetStat = fs.lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (targetStat.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  if (!targetStat.isDirectory()) throw new Error(`Pi session path is not a directory: ${target}`);
  fs.rmSync(target, { recursive: true, force: false });
}

/** Materialize a private, workspace-contained session namespace for one managed Pi agent. */
export function materializePiSessionDir(workspaceRoot: string, agent: string): string {
  const workspace = fs.realpathSync(workspaceRoot);
  const tachyon = path.join(workspace, ".tachyon");
  const root = path.join(tachyon, "pi-sessions");
  const target = piSessionDir(workspace, agent);

  ensureRealDirectory(tachyon);
  ensureRealDirectory(root);
  ensureRealDirectory(target);

  const resolved = fs.realpathSync(target);
  if (!resolved.startsWith(`${workspace}${path.sep}`)) {
    throw new Error(`Pi session path escapes workspace: ${target}`);
  }
  fs.chmodSync(root, 0o700);
  fs.chmodSync(target, 0o700);
  return target;
}
