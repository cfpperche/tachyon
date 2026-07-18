import fs from "node:fs";
import path from "node:path";

export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

function validateAgent(agent: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(agent)) throw new Error(`invalid Pi agent name '${agent}'`);
}

export function piAgentHome(workspaceRoot: string, agent: string): string {
  validateAgent(agent);
  return path.join(workspaceRoot, ".tachyon", "harness", agent);
}

export function piSessionDir(workspaceRoot: string, agent: string): string {
  return path.join(piAgentHome(workspaceRoot, agent), "sessions");
}

function ensureRealDirectory(dir: string, privateMode = false): void {
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Pi private-home path is not a real directory: ${dir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(dir, { mode: privateMode ? 0o700 : 0o755 });
  }
  if (privateMode) fs.chmodSync(dir, 0o700);
}

/**
 * Ensure the complete no-follow directory chain used by Pi's private home. The generic harness
 * materializer predates this stronger boundary; Pi uses this helper before copying credentials.
 */
export function materializePiAgentHome(workspaceRoot: string, agent: string): string {
  const workspace = fs.realpathSync(workspaceRoot);
  const tachyon = path.join(workspace, ".tachyon");
  const root = path.join(tachyon, "harness");
  const target = piAgentHome(workspace, agent);

  ensureRealDirectory(tachyon);
  ensureRealDirectory(root, true);
  ensureRealDirectory(target, true);

  const resolved = fs.realpathSync(target);
  if (!resolved.startsWith(`${workspace}${path.sep}`)) {
    throw new Error(`Pi private home escapes workspace: ${target}`);
  }
  return target;
}

/** Remove only Pi's session subtree. Canonical forget also removes the complete harness home. */
export function removePiSessionDir(workspaceRoot: string, agent: string): void {
  const workspace = fs.realpathSync(workspaceRoot);
  const target = piSessionDir(workspace, agent);
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

/** Materialize the transcript subtree inside one agent's private Pi home. */
export function materializePiSessionDir(workspaceRoot: string, agent: string): string {
  const workspace = fs.realpathSync(workspaceRoot);
  const home = materializePiAgentHome(workspace, agent);
  const target = path.join(home, "sessions");
  ensureRealDirectory(target, true);

  const resolved = fs.realpathSync(target);
  if (!resolved.startsWith(`${home}${path.sep}`)) {
    throw new Error(`Pi session path escapes private home: ${target}`);
  }
  return target;
}
