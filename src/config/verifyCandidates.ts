import fs from "node:fs";
import path from "node:path";
import { detectStack, type DetectedProject } from "../init/initLogic.js";
import { suggestVerify } from "../worktree/verify.js";
import type { TachyonConfig } from "./loadConfig.js";

/** Shared shell/engine implementation for the Studio's best-effort verify suggestions. */
export function collectVerifyCandidates(workspaceRoot: string, config: TachyonConfig | undefined): string[] {
  const manifests = ["package.json", "composer.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "Gemfile"];
  const files = manifests.filter((file) => fs.existsSync(path.join(workspaceRoot, file)));
  let packageJson: DetectedProject["packageJson"];
  if (files.includes("package.json")) {
    try {
      packageJson = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
    } catch {
      // An unreadable/invalid package.json contributes no script suggestions.
    }
  }
  const readText = (file: string): string | undefined => {
    if (!files.includes(file)) return undefined;
    try { return fs.readFileSync(path.join(workspaceRoot, file), "utf8"); }
    catch { return undefined; }
  };
  const stack = detectStack({
    files,
    packageJson,
    composerJson: readText("composer.json"),
    gemfile: readText("Gemfile"),
    installedClis: [],
  });
  const fromStack = suggestVerify(stack.label, packageJson?.scripts ?? {});
  return [...new Set([
    ...fromStack,
    ...Object.keys(config?.commands ?? {}),
    ...Object.keys(config?.runbooks ?? {}),
  ])];
}
