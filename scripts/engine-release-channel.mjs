import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertPackageTreeClean } from "./package-clean-gate.mjs";

export const ENGINE_RELEASE_CHANNELS = ["stable", "dev"];

export function resolveEngineReleaseChannel(env = process.env) {
  const value = env.TACHYON_ENGINE_CHANNEL?.trim() || "dev";
  if (!ENGINE_RELEASE_CHANNELS.includes(value)) {
    throw new Error(`invalid TACHYON_ENGINE_CHANNEL '${value}'; expected stable or dev`);
  }
  return value;
}

function git(cwd, args, runGit) {
  return runGit("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Stable is a release provenance claim, not a synonym for "clean".  A stable build must come from
 * the primary checkout at the exact cached origin/main commit.  This function never fetches or mutates
 * refs: the operator decides when to refresh origin/main, and the build remains deterministic/offline.
 */
export function assertStableBuildSource(cwd = process.cwd(), runGit = execFileSync) {
  assertPackageTreeClean(cwd, runGit);
  let branch;
  let gitDir;
  let commonDir;
  let head;
  let localMain;
  let originMain;
  let treeSha;
  try {
    gitDir = path.resolve(cwd, git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"], runGit));
    commonDir = path.resolve(cwd, git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], runGit));
  } catch (error) {
    throw new Error(`refusing stable Tachyon build because repository ownership could not be verified: ${String(error)}`);
  }
  if (gitDir !== commonDir) {
    throw new Error("refusing stable Tachyon build from a linked worktree; use Dev Host for worktree builds");
  }
  try {
    branch = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], runGit);
    head = git(cwd, ["rev-parse", "HEAD"], runGit);
    localMain = git(cwd, ["rev-parse", "refs/heads/main"], runGit);
    originMain = git(cwd, ["rev-parse", "refs/remotes/origin/main"], runGit);
    treeSha = git(cwd, ["rev-parse", "HEAD^{tree}"], runGit);
  } catch (error) {
    throw new Error(`refusing stable Tachyon build because main provenance could not be verified: ${String(error)}`);
  }
  if (branch !== "main") {
    throw new Error(`refusing stable Tachyon build from branch '${branch || "detached"}'; stable requires main`);
  }
  if (head !== localMain || head !== originMain) {
    throw new Error(
      "refusing stable Tachyon build because HEAD, local main, and cached origin/main differ; fetch/integrate/push main first",
    );
  }
  return { channel: "stable", commit: head, treeSha, branch, gitDir, commonDir };
}

/**
 * Recheck the already-emitted engine before packaging.  The source gate alone is insufficient:
 * dist/ may still contain bytes built before main advanced, or a dev build produced by a worktree.
 */
export function assertStableEngineManifest(manifest, stableSource) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("stable engine manifest is not an object");
  }
  if (manifest.channel !== "stable") {
    throw new Error(`refusing to package engine channel '${String(manifest.channel)}'; installed VSIX requires stable`);
  }
  if (manifest.build?.commit !== stableSource.commit || manifest.build?.treeSha !== stableSource.treeSha) {
    throw new Error("refusing to package a stale engine manifest that does not match the canonical main checkout");
  }
  return manifest;
}
