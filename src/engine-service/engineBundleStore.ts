import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  engineBundleId,
  isEngineBundleManifestV1,
  isSha256,
  type EngineBundleManifestV1,
} from "./protocol.js";

export interface StageEngineBundleInput {
  sourceRoot: string;
  manifest: EngineBundleManifestV1;
  /** Test/embedding override. Production resolves a machine-private per-user data directory. */
  installRoot?: string;
  requireCleanBuild?: boolean;
}

export interface StagePackagedEngineBundleInput {
  extensionRoot: string;
  installRoot?: string;
  /** Test/local-build override. Installed production bundles remain clean-only. */
  requireCleanBuild?: boolean;
}

export interface StagedEngineBundle {
  bundleId: string;
  root: string;
  entrypoint: string;
  manifestPath: string;
  reused: boolean;
}

export class EngineBundleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EngineBundleError";
  }
}

/**
 * Extension-shell entrypoint: locate the engine shipped inside the installed extension, validate the
 * manifest before trusting any of its paths, then reuse the same atomic immutable staging primitive as
 * every other caller.  The returned entrypoint never points into the disposable extension directory.
 */
export function stagePackagedEngineBundle(input: StagePackagedEngineBundleInput): StagedEngineBundle {
  const extensionRoot = path.resolve(input.extensionRoot);
  const sourceRoot = path.join(extensionRoot, "dist", "engine");
  const manifestPath = path.join(sourceRoot, "engine-manifest.json");
  let manifest: unknown;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch (error) {
    throw new EngineBundleError("PACKAGED_MANIFEST_UNREADABLE", `packaged engine manifest is unreadable: ${String(error)}`);
  }
  if (!isEngineBundleManifestV1(manifest)) {
    throw new EngineBundleError("INVALID_PACKAGED_MANIFEST", "packaged engine manifest is invalid");
  }
  return stageEngineBundle({
    sourceRoot,
    manifest,
    installRoot: input.installRoot,
    requireCleanBuild: input.requireCleanBuild,
  });
}

export function engineBundleInstallRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
    return path.join(local, "Tachyon", "engine-bundles");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Tachyon", "engine-bundles");
  }
  const data = env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  return path.join(data, "tachyon", "engine-bundles");
}

/**
 * Verifies and atomically stages one immutable engine bundle outside the extension-version directory.
 * Existing bundle ids are verified and reused; a corrupt existing id is never overwritten in place.
 */
export function stageEngineBundle(input: StageEngineBundleInput): StagedEngineBundle {
  if (!isEngineBundleManifestV1(input.manifest)) {
    throw new EngineBundleError("INVALID_MANIFEST", "engine bundle manifest is invalid");
  }
  if ((input.requireCleanBuild ?? true) && !input.manifest.build.workingTreeClean) {
    throw new EngineBundleError("DIRTY_BUILD", "refusing to stage an engine bundle from a dirty build");
  }

  const installRoot = path.resolve(input.installRoot ?? engineBundleInstallRoot());
  ensurePrivateDirectory(installRoot);
  const bundleId = engineBundleId(input.manifest);
  const destination = path.join(installRoot, bundleId);
  if (fs.existsSync(destination)) {
    verifyStagedBundle(destination, input.manifest);
    return stagedResult(destination, input.manifest, bundleId, true);
  }

  const sourceRoot = path.resolve(input.sourceRoot);
  const temp = path.join(installRoot, `.${bundleId}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  fs.mkdirSync(temp, { mode: 0o700 });
  try {
    for (const file of input.manifest.files) {
      const source = containedPath(sourceRoot, file.path, "SOURCE_OUTSIDE_BUNDLE");
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new EngineBundleError("UNSAFE_SOURCE_FILE", `engine bundle source is not a regular file: ${file.path}`);
      }
      if (sha256File(source) !== file.sha256) {
        throw new EngineBundleError("SOURCE_HASH_MISMATCH", `engine bundle source hash mismatch: ${file.path}`);
      }
      const target = containedPath(temp, file.path, "TARGET_OUTSIDE_BUNDLE");
      ensurePrivateDirectory(path.dirname(target));
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, file.executable ? 0o500 : 0o400);
    }
    fs.writeFileSync(path.join(temp, "engine-manifest.json"), `${JSON.stringify(input.manifest, null, 2)}\n`, {
      mode: 0o400,
      flag: "wx",
    });
    verifyStagedBundle(temp, input.manifest);
    try {
      fs.renameSync(temp, destination);
    } catch (error) {
      if (!fs.existsSync(destination)) throw error;
      verifyStagedBundle(destination, input.manifest);
    }
    return stagedResult(destination, input.manifest, bundleId, false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Reopens one immutable bundle that was staged beside the requested install.  Upgrade rollback uses the
 * running engine's signed bundle id rather than a mutable "current" pointer, then re-verifies every byte
 * before the old entrypoint can be launched again.
 */
export function loadStagedEngineBundle(installRoot: string, bundleId: string): StagedEngineBundle {
  if (!isSha256(bundleId)) throw new EngineBundleError("INVALID_BUNDLE_ID", "staged engine bundle id is invalid");
  const root = path.join(path.resolve(installRoot), bundleId);
  const manifestPath = path.join(root, "engine-manifest.json");
  let manifest: unknown;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch (error) {
    throw new EngineBundleError("STAGED_MANIFEST_UNREADABLE", `staged engine manifest is unreadable: ${String(error)}`);
  }
  if (!isEngineBundleManifestV1(manifest) || engineBundleId(manifest) !== bundleId) {
    throw new EngineBundleError("STAGED_MANIFEST_MISMATCH", "staged engine manifest does not match its bundle id");
  }
  verifyStagedBundle(root, manifest);
  return stagedResult(root, manifest, bundleId, true);
}

export function verifyStagedBundle(root: string, expected: EngineBundleManifestV1): void {
  const resolvedRoot = path.resolve(root);
  const stat = fs.lstatSync(resolvedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new EngineBundleError("UNSAFE_STAGED_ROOT", `staged engine root is not a real directory: ${resolvedRoot}`);
  }
  const manifestPath = path.join(resolvedRoot, "engine-manifest.json");
  let actual: unknown;
  try {
    actual = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new EngineBundleError("STAGED_MANIFEST_UNREADABLE", `staged engine manifest is unreadable: ${String(error)}`);
  }
  if (!isEngineBundleManifestV1(actual) || engineBundleId(actual) !== engineBundleId(expected)) {
    throw new EngineBundleError("STAGED_MANIFEST_MISMATCH", "staged engine manifest does not match the requested bundle");
  }
  for (const file of expected.files) {
    const target = containedPath(resolvedRoot, file.path, "STAGED_FILE_OUTSIDE_BUNDLE");
    const fileStat = fs.lstatSync(target);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new EngineBundleError("UNSAFE_STAGED_FILE", `staged engine file is not regular: ${file.path}`);
    }
    if (sha256File(target) !== file.sha256) {
      throw new EngineBundleError("STAGED_HASH_MISMATCH", `staged engine file hash mismatch: ${file.path}`);
    }
  }
}

function stagedResult(
  root: string,
  manifest: EngineBundleManifestV1,
  bundleId: string,
  reused: boolean,
): StagedEngineBundle {
  return {
    bundleId,
    root,
    entrypoint: containedPath(root, manifest.entrypoint, "ENTRYPOINT_OUTSIDE_BUNDLE"),
    manifestPath: path.join(root, "engine-manifest.json"),
    reused,
  };
}

function containedPath(root: string, relative: string, code: string): string {
  const base = path.resolve(root);
  const candidate = path.resolve(base, ...relative.split("/"));
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) {
    throw new EngineBundleError(code, `engine bundle path escapes its root: ${relative}`);
  }
  return candidate;
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new EngineBundleError("UNSAFE_INSTALL_DIR", `engine bundle install path is not a real directory: ${dir}`);
  }
  if (process.platform !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) {
      throw new EngineBundleError("UNSAFE_INSTALL_DIR", `engine bundle install path is not owned by uid ${uid}: ${dir}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new EngineBundleError("UNSAFE_INSTALL_DIR", `engine bundle install path is group/other-accessible: ${dir}`);
    }
  }
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
