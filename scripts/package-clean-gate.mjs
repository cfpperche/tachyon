import { execFileSync } from "node:child_process";

/**
 * A packaged engine is clean-only at activation, so refuse to create a VSIX that could never start.
 * Git-ignored build artifacts are allowed; every other tracked or untracked source change is rejected.
 */
export function assertPackageTreeClean(cwd = process.cwd(), runGit = execFileSync) {
  let status;
  try {
    status = runGit("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`refusing to package Tachyon because the source tree could not be verified: ${String(error)}`);
  }

  if (status) {
    throw new Error(`refusing to package Tachyon from a dirty source tree:\n${status}`);
  }
}
