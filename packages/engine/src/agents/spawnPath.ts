/**
 * Session PATH for Tachyon-spawned agent panes.
 *
 * After a VS Code reload, Bridge rebind stop->resume can respawn panes against a
 * tmux server/global env that does not include nvm (or other user CLI dirs).
 * The agent command is then "codex ..." / "claude ..." looked up via PATH -> exit 127
 * ("command not found") with boundGeneration already stamped as if resume succeeded.
 *
 * Always pin a PATH onto the session env (via getExtraEnv) so:
 * 1. new-session -e carries the host's CLI dirs
 * 2. respawn-pane's session-env sync re-sets PATH instead of leaving a stripped global
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const USER_CLI_DIR_REL = [".local/bin", ".bun/bin", ".cargo/bin", "bin", "go/bin", "go-sdk/go/bin", ".grok/bin"] as const;

/** Dirs under $HOME that commonly hold agent CLIs (codex, claude, grok, node). */
export function userCliDirs(home: string = os.homedir()): string[] {
  const out: string[] = [];
  for (const rel of USER_CLI_DIR_REL) {
    const abs = path.join(home, rel);
    if (isDir(abs)) out.push(abs);
  }
  return out;
}

/**
 * Best-effort nvm node bin dir: $NVM_BIN, else newest versions/node/<ver>/bin that exists.
 * Does not shell out to nvm.sh (non-interactive extension host cannot source it).
 */
export function nvmBinDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | undefined {
  const fromEnv = env.NVM_BIN?.trim();
  if (fromEnv && isDir(fromEnv)) return fromEnv;

  const nvmDir = (env.NVM_DIR?.trim() || path.join(home, ".nvm")).replace(/\/+$/, "");
  const versionsRoot = path.join(nvmDir, "versions", "node");
  if (!isDir(versionsRoot)) return undefined;

  let best: string | undefined;
  let bestName = "";
  try {
    for (const ent of fs.readdirSync(versionsRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const bin = path.join(versionsRoot, ent.name, "bin");
      if (!isDir(bin)) continue;
      // Prefer a dir that actually has node; lexical max is a decent "latest" for vN.M.P.
      if (!fs.existsSync(path.join(bin, "node"))) continue;
      if (!best || ent.name.localeCompare(bestName, undefined, { numeric: true }) > 0) {
        best = bin;
        bestName = ent.name;
      }
    }
  } catch {
    return undefined;
  }
  return best;
}

/**
 * Build the PATH string to inject into agent session env.
 * Prepend missing nvm + user CLI dirs, then keep host PATH order.
 */
export function agentLaunchPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const existing = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const seen = new Set(existing);
  const prepend: string[] = [];

  const nvm = nvmBinDir(env, home);
  if (nvm && !seen.has(nvm)) {
    prepend.push(nvm);
    seen.add(nvm);
  }
  for (const dir of userCliDirs(home)) {
    if (seen.has(dir)) continue;
    prepend.push(dir);
    seen.add(dir);
  }

  return [...prepend, ...existing].join(path.delimiter);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
