import path from "node:path";

/**
 * t-84c678 — Grok's native project skill roots that remain visible after redirecting `GROK_HOME`.
 *
 * Grok 0.2.118 was measured loading BOTH roots as active `project` skills with every compatibility
 * cell pinned off. `.agents/skills` is native Grok discovery, not Codex compatibility, so the compat
 * block cannot close it. Canonical/private agents must hide both roots and receive selected captured
 * skills through `$GROK_HOME/skills` instead.
 */
export const GROK_PROJECT_SKILL_ROOTS = [".grok/skills", ".agents/skills"] as const;

/** Absolute ignore paths for the configured workspace and effective spawn cwd/worktree. */
export function grokProjectSkillIgnorePaths(workspaceRoot: string, cwd?: string): string[] {
  const roots = new Set([path.resolve(workspaceRoot), path.resolve(cwd ?? workspaceRoot)]);
  return [...roots]
    .flatMap((root) => GROK_PROJECT_SKILL_ROOTS.map((relative) => path.join(root, ...relative.split("/"))))
    .sort();
}

/**
 * Prepend the closed `[skills]` policy to a Tachyon-owned Grok config.
 *
 * Every caller passes a config built from closed product projection, never an ambient `[skills]`
 * table. Refuse a duplicate instead of producing invalid TOML or silently merging authority.
 */
export function withGrokProjectSkillsIgnored(toml: string, workspaceRoot: string, cwd?: string): string {
  if (/^\s*\[skills\]\s*$/m.test(toml)) {
    throw new Error("Tachyon-owned Grok config already contains a [skills] table");
  }
  const paths = grokProjectSkillIgnorePaths(workspaceRoot, cwd);
  const block = `[skills]\nignore = [${paths.map((entry) => JSON.stringify(entry)).join(", ")}]\n`;
  return toml.length === 0 ? block : `${block}\n${toml}`;
}
