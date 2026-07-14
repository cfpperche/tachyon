#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ARCH_LABEL = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;

function executable(candidate) {
  if (!candidate) return false;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function canonical(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

export function isWslRemoteCli(candidate) {
  if (!candidate) return false;
  const paths = [path.resolve(candidate), canonical(candidate)];
  return paths.some((value) => /(?:^|\/)remote-cli\/code(?:\.exe)?$/i.test(value.replaceAll("\\", "/")));
}

export function latestCachedCode(root, archLabel = ARCH_LABEL) {
  const cache = path.join(root, ".vscode-test");
  let entries;
  try {
    entries = fs.readdirSync(cache, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const prefix = `vscode-linux-${archLabel}-`;
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(cache, entry.name, "code"))
    .filter((candidate) => executable(candidate) && !isWslRemoteCli(candidate))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  return candidates.at(-1);
}

export function primaryCheckoutRoot(repo) {
  let common;
  try {
    common = execFileSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
  if (!common) return undefined;
  const root = path.dirname(path.resolve(repo, common));
  return canonical(root) === canonical(repo) ? undefined : root;
}

export function commandOnPath(command, pathValue = process.env.PATH ?? "") {
  for (const dir of pathValue.split(path.delimiter)) {
    const candidate = path.join(dir || ".", command);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

export function resolveEdhCode({
  repo,
  explicit,
  commonRoot = primaryCheckoutRoot(repo),
  pathCandidate = commandOnPath("code"),
} = {}) {
  if (!repo) throw new Error("repository path is required");

  if (explicit) {
    if (!executable(explicit)) throw new Error("TACHYON_EDH_CODE is not an executable file");
    if (isWslRemoteCli(explicit)) {
      throw new Error("TACHYON_EDH_CODE resolves to WSL remote-cli/code, which cannot launch an isolated Extension Development Host");
    }
    return { path: canonical(explicit), source: "explicit" };
  }

  const local = latestCachedCode(repo);
  if (local) return { path: canonical(local), source: "worktree-cache" };

  if (commonRoot) {
    const shared = latestCachedCode(commonRoot);
    if (shared) return { path: canonical(shared), source: "shared-checkout-cache" };
  }

  if (pathCandidate) {
    if (!executable(pathCandidate)) throw new Error("the code executable found on PATH is not executable");
    if (isWslRemoteCli(pathCandidate)) {
      throw new Error("code on PATH resolves to WSL remote-cli/code; run the integration suite once to seed .vscode-test or set TACHYON_EDH_CODE to a native VS Code binary");
    }
    return { path: canonical(pathCandidate), source: "path" };
  }

  throw new Error("no compatible VS Code executable found; run the integration suite once to seed .vscode-test or set TACHYON_EDH_CODE");
}

function main() {
  const repo = process.argv[2];
  try {
    const resolved = resolveEdhCode({ repo, explicit: process.env.TACHYON_EDH_CODE });
    process.stdout.write(`${resolved.path}\n`);
  } catch (error) {
    process.stderr.write(`edh-palliative: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
