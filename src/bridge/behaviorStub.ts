import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  behaviorStubPathError,
  configuredBehaviorStubPath,
  type BehaviorVerificationSettings,
} from "../config/behaviorVerification.js";

const execFileP = promisify(execFile);

export function canonicalBehaviorStubPath(
  agent: string,
  settings: BehaviorVerificationSettings,
): string {
  return configuredBehaviorStubPath(agent, settings.stubPath);
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, { cwd, encoding: "utf8" });
    return stdout;
  } catch (error) {
    const detail = error as Error & { stderr?: string; stdout?: string };
    throw new Error(`git ${args.join(" ")} failed: ${(detail.stderr ?? detail.stdout ?? detail.message).trim()}`);
  }
}

async function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFileP("git", args, { cwd, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    return Buffer.from(stdout);
  } catch (error) {
    const detail = error as Error & { stderr?: Buffer; stdout?: Buffer };
    throw new Error(
      `git ${args.join(" ")} failed: ${detail.stderr?.toString("utf8").trim() || detail.stdout?.toString("utf8").trim() || detail.message}`,
    );
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function realProjectFile(worktree: string, relativePath: string, label: string): string {
  const pathError = behaviorStubPathError(relativePath);
  if (pathError) throw new Error(`${label} has an unsafe path '${relativePath}': ${pathError}`);
  const absolute = path.resolve(worktree, ...relativePath.split("/"));
  if (!contained(worktree, absolute)) throw new Error(`${label} escapes the worktree: ${relativePath}`);

  let current = worktree;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`${label} does not exist: ${relativePath}`);
      }
      throw error;
    }
    const leaf = current === absolute;
    if (stat.isSymbolicLink() || (leaf ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`${label} is not a real ${leaf ? "file" : "directory path"}: ${relativePath}`);
    }
    const canonical = fs.realpathSync(current);
    if (!contained(worktree, canonical)) throw new Error(`${label} resolves outside the worktree: ${relativePath}`);
  }
  return absolute;
}

async function bindCommittedFile(input: {
  worktreePath: string;
  worktree: string;
  relativePath: string;
  label: string;
}): Promise<string> {
  const absolute = realProjectFile(input.worktree, input.relativePath, input.label);
  const tracked = (await gitText(input.worktreePath, ["--literal-pathspecs", "ls-files", "-z", "--", input.relativePath]))
    .split("\0")
    .filter(Boolean);
  if (tracked.length !== 1 || tracked[0] !== input.relativePath) {
    throw new Error(`${input.label} must already be a tracked project file: ${input.relativePath}`);
  }
  const committed = await gitBytes(input.worktreePath, ["show", `HEAD:./${input.relativePath}`]);
  const checkout = fs.readFileSync(absolute);
  if (!checkout.equals(committed)) {
    throw new Error(`${input.label} checkout bytes differ from HEAD: ${input.relativePath}`);
  }
  return crypto.createHash("sha256").update(committed).digest("hex");
}

/**
 * Resolve a project/delegator-owned behavior oracle without creating or editing project files.
 * Tachyon can select and execute an oracle, but prose is not enough information to invent one.
 * The committed bytes are hashed here and must remain identical at BASE and HEAD verification.
 */
export async function resolveCanonicalBehaviorOracle(input: {
  worktreePath: string;
  agent: string;
  settings: BehaviorVerificationSettings;
}): Promise<{ stubPath: string; oracleHash: string; executorHashes: Record<string, string>; headRef: string }> {
  const stubPath = canonicalBehaviorStubPath(input.agent, input.settings);
  const worktree = fs.realpathSync(input.worktreePath);
  // Validate path shape before the broad dirty-worktree refusal so a symlink attack is diagnosed
  // as such and never hidden behind the untracked symlink it introduced.
  try {
    realProjectFile(worktree, stubPath, "configured behavior oracle");
  } catch (error) {
    if (error instanceof Error && error.message.includes("does not exist")) {
      throw new Error(`${error.message}; commit a real failing project-owned test before spawning the delegation`);
    }
    throw error;
  }
  for (const executorPath of input.settings.executorPaths) {
    realProjectFile(worktree, executorPath, "configured behavior executor");
  }
  const dirty = await gitText(input.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (dirty.length > 0) {
    throw new Error("cannot bind a behavior oracle in a dirty worktree; commit or remove the pre-existing changes first");
  }
  let oracleHash: string;
  try {
    oracleHash = await bindCommittedFile({
      worktreePath: input.worktreePath,
      worktree,
      relativePath: stubPath,
      label: "configured behavior oracle",
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("does not exist")) {
      throw new Error(`${error.message}; commit a real failing project-owned test before spawning the delegation`);
    }
    throw error;
  }
  const executorEntries: Array<[string, string]> = [];
  const seenExecutorPaths = new Set<string>();
  for (const executorPath of input.settings.executorPaths) {
    if (seenExecutorPaths.has(executorPath)) throw new Error(`configured behavior executor path is duplicated: ${executorPath}`);
    seenExecutorPaths.add(executorPath);
    executorEntries.push([executorPath, await bindCommittedFile({
      worktreePath: input.worktreePath,
      worktree,
      relativePath: executorPath,
      label: "configured behavior executor",
    })]);
  }
  const executorHashes = Object.fromEntries(executorEntries);
  const headRef = (await gitText(input.worktreePath, ["rev-parse", "HEAD"])).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headRef)) throw new Error("behavior oracle HEAD could not be resolved");
  return {
    stubPath,
    oracleHash,
    executorHashes,
    headRef,
  };
}
