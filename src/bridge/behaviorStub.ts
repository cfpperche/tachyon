import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const CONTAINER_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "tachyon-container",
  GIT_AUTHOR_EMAIL: "tachyon@example.invalid",
  GIT_COMMITTER_NAME: "tachyon-container",
  GIT_COMMITTER_EMAIL: "tachyon@example.invalid",
};

function jsString(value: string): string {
  return JSON.stringify(value);
}

function stubFileName(agent: string): string {
  return `${agent}Behavior.gen.test.ts`;
}

export function canonicalBehaviorStubPath(agent: string): string {
  return path.posix.join("test", "unit", stubFileName(agent));
}

export function canonicalBehaviorStubSource(behaviorTest: string): string {
  return [
    'import { describe, expect, it } from "vitest";',
    "",
    'describe("container-generated delegation behavior", () => {',
    `  it(${jsString(behaviorTest)}, () => {`,
    '    expect.fail("delegation not implemented yet");',
    "  });",
    "});",
    "",
  ].join("\n");
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, { cwd, encoding: "utf8", env: CONTAINER_GIT_ENV });
    return stdout.trim();
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    throw new Error(`git ${args.join(" ")} failed: ${(e.stderr ?? e.stdout ?? e.message).trim()}`);
  }
}

export async function writeAndCommitCanonicalBehaviorStub(input: {
  worktreePath: string;
  agent: string;
  behaviorTest: string;
}): Promise<{ stubPath: string; committed: boolean }> {
  const stubPath = canonicalBehaviorStubPath(input.agent);
  const absolute = path.join(input.worktreePath, ...stubPath.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, canonicalBehaviorStubSource(input.behaviorTest), "utf8");

  await git(input.worktreePath, ["add", "--", stubPath]);
  const staged = await git(input.worktreePath, ["diff", "--cached", "--name-only", "--", stubPath]);
  if (!staged) return { stubPath, committed: false };

  await git(input.worktreePath, ["commit", "-m", `tachyon setup: canonical behavior stub for ${input.agent}`]);
  return { stubPath, committed: true };
}
