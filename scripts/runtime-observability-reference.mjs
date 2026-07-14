#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_MANIFEST = "docs/research/runtime-observability-reference.json";
const SHA256 = /^[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SAFE_GIT_PATH = /^[A-Za-z0-9_./+@-]{1,256}$/;
const SAFE_GIT_REF = /^(?:HEAD|[0-9a-f]{40}|[A-Za-z0-9][A-Za-z0-9._/+\-]{0,255})$/;
const SAFE_GIT_TAG = /^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"], "workspace root");
  const manifestPath = resolveContained(workspaceRoot, args.manifest ?? DEFAULT_MANIFEST, "manifest");
  const manifest = loadManifest(manifestPath, workspaceRoot);
  verifyFixturePins(manifest, workspaceRoot);

  if (!args.repo) {
    console.log(`runtime-observability reference OK: ${manifest.upstream.tag} @ ${manifest.upstream.commit}`);
    console.log("No upstream checkout inspected. Pass --repo <CodexBar checkout> [--candidate <ref>] to run the radar.");
    return 0;
  }

  const upstreamRoot = path.resolve(args.repo);
  const origin = normalizeRemote(git(upstreamRoot, ["remote", "get-url", "origin"], "upstream origin"));
  if (origin !== normalizeRemote(manifest.upstream.repository)) throw new RadarError("upstream origin does not match the manifest");

  const tagObject = git(upstreamRoot, ["rev-parse", `refs/tags/${manifest.upstream.tag}`], "reference tag");
  if (tagObject !== manifest.upstream.annotatedTagObject) throw new RadarError("reference tag object does not match the manifest");
  const peeledTag = git(upstreamRoot, ["rev-parse", `${manifest.upstream.tag}^{commit}`], "reference commit");
  if (peeledTag !== manifest.upstream.commit) throw new RadarError("reference tag commit does not match the manifest");
  for (const watchedPath of manifest.watchedPaths) {
    git(upstreamRoot, ["cat-file", "-e", `${manifest.upstream.commit}:${watchedPath}`], "watched baseline path", true);
  }

  const candidateRef = args.candidate ?? "HEAD";
  if (!SAFE_GIT_REF.test(candidateRef) || candidateRef.includes("..") || candidateRef.endsWith(".")) {
    throw new RadarError("candidate must be a bounded git ref");
  }
  const candidate = git(upstreamRoot, ["rev-parse", `${candidateRef}^{commit}`], "candidate commit");
  const changed = git(
    upstreamRoot,
    ["diff", "--name-only", "--no-renames", `${manifest.upstream.commit}..${candidate}`, "--", ...manifest.watchedPaths],
    "upstream diff",
    true,
  ).split("\n").filter(Boolean);

  if (changed.length === 0) {
    console.log(`runtime-observability radar clean: ${manifest.upstream.commit}..${candidate}`);
    return 0;
  }

  console.error(`runtime-observability radar: ${changed.length} relevant upstream path(s) changed`);
  for (const file of changed) console.error(`  ${SAFE_GIT_PATH.test(file) ? file : "[unsafe-path]"}`);
  return 1;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--manifest" && arg !== "--repo" && arg !== "--candidate") {
      throw new RadarError("usage: runtime-observability-reference [--manifest <path>] [--repo <path>] [--candidate <ref>]");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new RadarError(`missing value for ${arg}`);
    const key = arg.slice(2);
    if (result[key] !== undefined) throw new RadarError(`duplicate ${arg}`);
    result[key] = value;
    index += 1;
  }
  if (result.candidate && !result.repo) throw new RadarError("--candidate requires --repo");
  return result;
}

function loadManifest(manifestPath, workspaceRoot) {
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new RadarError("manifest must be a bounded regular file");
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!record(raw) || raw.schemaVersion !== 1 || raw.purpose !== "development-reference-only" || raw.productionDependency !== false) {
    throw new RadarError("invalid reference manifest header");
  }
  if (!record(raw.upstream)
    || raw.upstream.repository !== "https://github.com/steipete/CodexBar"
    || typeof raw.upstream.tag !== "string" || raw.upstream.tag.length > 64 || !SAFE_GIT_TAG.test(raw.upstream.tag)
    || typeof raw.upstream.annotatedTagObject !== "string"
    || !SHA1.test(raw.upstream.annotatedTagObject)
    || typeof raw.upstream.commit !== "string"
    || !SHA1.test(raw.upstream.commit)
    || raw.upstream.license !== "MIT") {
    throw new RadarError("invalid upstream reference");
  }
  if (raw.upstream.annotatedTagObject === raw.upstream.commit) {
    throw new RadarError("upstream reference must use an annotated tag");
  }
  if (!Array.isArray(raw.providers) || raw.providers.length !== 2
    || raw.providers[0] !== "codex" || raw.providers[1] !== "claude") {
    throw new RadarError("reference providers must be exactly codex and claude");
  }
  if (!Array.isArray(raw.fixturePins) || raw.fixturePins.length === 0 || raw.fixturePins.length > 16) {
    throw new RadarError("invalid fixture pin set");
  }
  const fixturePins = raw.fixturePins.map((pin) => {
    if (!record(pin) || typeof pin.path !== "string" || typeof pin.sha256 !== "string" || !SHA256.test(pin.sha256)) {
      throw new RadarError("invalid fixture pin");
    }
    resolveContained(workspaceRoot, pin.path, "fixture");
    return { path: pin.path, sha256: pin.sha256 };
  });
  if (new Set(fixturePins.map((pin) => pin.path)).size !== fixturePins.length) {
    throw new RadarError("duplicate fixture pin");
  }
  if (!Array.isArray(raw.watchedPaths) || raw.watchedPaths.length === 0 || raw.watchedPaths.length > 64) {
    throw new RadarError("invalid watched path set");
  }
  const watchedPaths = raw.watchedPaths.map((value) => {
    if (typeof value !== "string" || !safeRelative(value)) throw new RadarError("invalid watched path");
    return value;
  });
  if (new Set(watchedPaths).size !== watchedPaths.length) throw new RadarError("duplicate watched path");
  return {
    upstream: {
      repository: raw.upstream.repository,
      tag: raw.upstream.tag,
      annotatedTagObject: raw.upstream.annotatedTagObject,
      commit: raw.upstream.commit,
    },
    fixturePins,
    watchedPaths,
  };
}

function verifyFixturePins(manifest, workspaceRoot) {
  for (const pin of manifest.fixturePins) {
    const file = resolveContained(workspaceRoot, pin.path, "fixture");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new RadarError("fixture must be a bounded regular file");
    const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (actual !== pin.sha256) throw new RadarError(`fixture hash mismatch: ${pin.path}`);
  }
}

function resolveContained(root, relative, label) {
  if (!safeRelative(relative)) throw new RadarError(`${label} path must be workspace-relative and contained`);
  const resolved = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new RadarError(`${label} path escapes the workspace`);
  try {
    const realRoot = fs.realpathSync(root);
    const realResolved = fs.realpathSync(resolved);
    if (!realResolved.startsWith(`${realRoot}${path.sep}`)) {
      throw new RadarError(`${label} path escapes the workspace through a symlink`);
    }
  } catch (error) {
    if (error instanceof RadarError) throw error;
    throw new RadarError(`${label} path is unavailable`);
  }
  return resolved;
}

function safeRelative(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && SAFE_GIT_PATH.test(value)
    && !path.isAbsolute(value)
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function normalizeRemote(value) {
  return value.trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "");
}

function git(cwd, args, label, allowEmpty = false) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  if (result.status !== 0 || result.error) throw new RadarError(`unable to inspect ${label}`);
  const output = result.stdout.trim();
  if (!allowEmpty && output.length === 0) throw new RadarError(`empty ${label}`);
  return output;
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RadarError extends Error {}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`runtime-observability reference check failed: ${error instanceof RadarError ? error.message : "unexpected error"}`);
  process.exitCode = 2;
}
