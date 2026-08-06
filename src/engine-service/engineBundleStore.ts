import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  engineBundleId,
  isEngineBundleManifestV1,
  isSha256,
  type EngineBundleManifestV1,
  type EngineReleaseChannel,
} from "./protocol.js";

export interface StageEngineBundleInput {
  sourceRoot: string;
  manifest: EngineBundleManifestV1;
  /** Test/embedding override. Production resolves a machine-private per-user data directory. */
  installRoot?: string;
  requireCleanBuild?: boolean;
  requiredChannel?: EngineReleaseChannel;
}

export interface StagePackagedEngineBundleInput {
  extensionRoot: string;
  installRoot?: string;
  /** Test/local-build override. Installed production bundles remain clean-only. */
  requireCleanBuild?: boolean;
  requiredChannel?: EngineReleaseChannel;
  /** Production shell build identity; dev leaves this unset because dirty worktree builds are expected. */
  requiredBuild?: { commit: string; treeSha: string };
}

export interface StagedEngineBundle {
  bundleId: string;
  root: string;
  entrypoint: string;
  manifestPath: string;
  reused: boolean;
}

export interface StageEngineRuntimeInput {
  /** Runtime executable currently hosting the Extension Host. Symlinks are resolved before copying. */
  sourceExecutable: string;
  /** Test/embedding override. Production resolves a machine-private per-user data directory. */
  installRoot?: string;
}

export interface ResolveEngineRuntimeSourceInput {
  sourceExecutable: string;
  versions?: Readonly<Record<string, string | undefined>>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface StagedEngineRuntime {
  runtimeId: string;
  root: string;
  executable: string;
  manifestPath: string;
  reused: boolean;
}

interface EngineRuntimeManifestV1 {
  schemaVersion: 1;
  sha256: string;
  byteSize: number;
}

export class EngineBundleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EngineBundleError";
  }
}

const execFileAsync = promisify(execFile);

export function isElectronRuntime(
  versions: Readonly<Record<string, string | undefined>> = process.versions,
): boolean {
  return typeof versions.electron === "string" && versions.electron.length > 0;
}

function nodeExecutableNames(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== "win32") return ["node"];
  const extensions = (env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
  return extensions.map((extension) => `node${extension.toLowerCase()}`);
}

/**
 * ASYNC, and the wedge invariant is why. A first cut used the blocking form and
 * `cxWedgeBehavior.gen.test.ts` went red on it, correctly: this probes every PATH entry with a 5s
 * timeout each, and it runs at activation inside the Extension Host — exactly where a blocking
 * subprocess freezes the window the human is waiting on. The allowlist in that guard was not the
 * answer either; every entry there says "separate process, no VS Code running", and this one runs
 * with VS Code running, so claiming a slot would have made the guard lie.
 *
 * Do not name the blocking API in this file, not even in prose. The guard matches the identifier
 * anywhere in the text, so a comment explaining why it is absent would itself be an offender.
 */
async function validatesAsNode(candidate: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(candidate, [
      "-p",
      "JSON.stringify({execPath:process.execPath,node:process.versions.node,electron:process.versions.electron||null})",
    ], { encoding: "utf8", env, timeout: 5_000, windowsHide: true });
    const probe = JSON.parse(stdout) as { execPath?: unknown; node?: unknown; electron?: unknown };
    if (typeof probe.execPath !== "string" || typeof probe.node !== "string" || probe.electron !== null) return false;
    return fs.realpathSync(probe.execPath) === fs.realpathSync(candidate);
  } catch {
    return false;
  }
}

/**
 * Resolve a relocatable Node binary when the Extension Host itself is Electron.
 *
 * Deliberately NOT called from `stageEngineRuntime`. That function is an fs primitive — hash, copy,
 * verify — and its callers (including three tests) stay synchronous. Only the probe needs to await,
 * so the resolution happens one level up, in `connectPackagedWorkspaceClient`, which is already async.
 */
export async function resolveEngineRuntimeSource(input: ResolveEngineRuntimeSourceInput): Promise<string> {
  if (!isElectronRuntime(input.versions)) return input.sourceExecutable;

  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const directories = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of nodeExecutableNames(platform, env)) {
      const candidate = path.resolve(directory, name);
      if (await validatesAsNode(candidate, env)) return fs.realpathSync(candidate);
    }
  }
  throw new EngineBundleError(
    "NODE_RUNTIME_NOT_FOUND",
    "the local Electron Extension Host requires a real Node executable on PATH. A shim (asdf, volta) "
      + "is rejected on purpose: the probe requires the candidate's own process.execPath to match it.",
  );
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
  assertRequiredChannel(manifest, input.requiredChannel);
  if (input.requiredBuild
    && (manifest.build.commit !== input.requiredBuild.commit || manifest.build.treeSha !== input.requiredBuild.treeSha)) {
    throw new EngineBundleError(
      "PACKAGED_BUILD_MISMATCH",
      "refusing a packaged engine whose source identity differs from the extension shell",
    );
  }
  return stageEngineBundle({
    sourceRoot,
    manifest,
    installRoot: input.installRoot,
    requireCleanBuild: input.requireCleanBuild,
    requiredChannel: input.requiredChannel,
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

export function engineRuntimeInstallRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
    return path.join(local, "Tachyon", "engine-runtimes");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Tachyon", "engine-runtimes");
  }
  const data = env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  return path.join(data, "tachyon", "engine-runtimes");
}

/**
 * Copies the exact Node runtime used to launch the daemon into immutable Tachyon-owned
 * storage.  A systemd unit may outlive the VS Code Server version that activated it, so it must never
 * retain an ExecStart path inside ~/.vscode-server or an extension installation.
 */
export function stageEngineRuntime(input: StageEngineRuntimeInput): StagedEngineRuntime {
  let source: string;
  try { source = fs.realpathSync(path.resolve(input.sourceExecutable)); }
  catch (error) {
    throw new EngineBundleError("RUNTIME_SOURCE_UNREADABLE", `engine runtime source is unreadable: ${String(error)}`);
  }
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || (process.platform !== "win32" && (sourceStat.mode & 0o111) === 0)) {
    throw new EngineBundleError("UNSAFE_RUNTIME_SOURCE", "engine runtime source is not a regular executable file");
  }
  if (process.platform !== "win32" && (sourceStat.mode & 0o022) !== 0) {
    throw new EngineBundleError("UNSAFE_RUNTIME_SOURCE", "engine runtime source is group/other-writable");
  }

  const manifest: EngineRuntimeManifestV1 = {
    schemaVersion: 1,
    sha256: sha256File(source),
    byteSize: sourceStat.size,
  };
  const installRoot = path.resolve(input.installRoot ?? engineRuntimeInstallRoot());
  ensurePrivateDirectory(installRoot);
  const destination = path.join(installRoot, manifest.sha256);
  if (fs.existsSync(destination)) {
    verifyRuntimeDirectory(destination, manifest);
    return stagedRuntimeResult(destination, manifest, true);
  }

  const temp = path.join(installRoot, `.${manifest.sha256}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  fs.mkdirSync(temp, { mode: 0o700 });
  try {
    const executable = path.join(temp, "node");
    fs.copyFileSync(source, executable, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(executable, 0o500);
    fs.writeFileSync(path.join(temp, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o400,
      flag: "wx",
    });
    verifyRuntimeDirectory(temp, manifest);
    try {
      fs.renameSync(temp, destination);
    } catch (error) {
      if (!fs.existsSync(destination)) throw error;
      verifyRuntimeDirectory(destination, manifest);
    }
    return stagedRuntimeResult(destination, manifest, false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function verifyStagedEngineRuntime(runtime: StagedEngineRuntime): void {
  if (!isSha256(runtime.runtimeId)) throw new EngineBundleError("INVALID_RUNTIME_ID", "staged engine runtime id is invalid");
  const root = path.resolve(runtime.root);
  if (path.basename(root) !== runtime.runtimeId
    || path.resolve(runtime.executable) !== path.join(root, "node")
    || path.resolve(runtime.manifestPath) !== path.join(root, "runtime-manifest.json")) {
    throw new EngineBundleError("RUNTIME_IDENTITY_MISMATCH", "staged engine runtime paths do not match its identity");
  }
  const manifest = readRuntimeManifest(root);
  if (manifest.sha256 !== runtime.runtimeId) {
    throw new EngineBundleError("RUNTIME_IDENTITY_MISMATCH", "staged engine runtime manifest does not match its identity");
  }
  verifyRuntimeDirectory(root, manifest);
}

/**
 * Verifies and atomically stages one immutable engine bundle outside the extension-version directory.
 * Existing bundle ids are verified and reused; a corrupt existing id is never overwritten in place.
 */
export function stageEngineBundle(input: StageEngineBundleInput): StagedEngineBundle {
  if (!isEngineBundleManifestV1(input.manifest)) {
    throw new EngineBundleError("INVALID_MANIFEST", "engine bundle manifest is invalid");
  }
  assertRequiredChannel(input.manifest, input.requiredChannel);
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

function assertRequiredChannel(manifest: EngineBundleManifestV1, required: EngineReleaseChannel | undefined): void {
  if (required === undefined || manifest.channel === required) return;
  throw new EngineBundleError(
    "ENGINE_CHANNEL_MISMATCH",
    `refusing engine channel '${manifest.channel ?? "legacy"}'; this host requires '${required}'`,
  );
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

function stagedRuntimeResult(
  root: string,
  manifest: EngineRuntimeManifestV1,
  reused: boolean,
): StagedEngineRuntime {
  return {
    runtimeId: manifest.sha256,
    root,
    executable: path.join(root, "node"),
    manifestPath: path.join(root, "runtime-manifest.json"),
    reused,
  };
}

function readRuntimeManifest(root: string): EngineRuntimeManifestV1 {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(path.join(root, "runtime-manifest.json"), "utf8")); }
  catch (error) {
    throw new EngineBundleError("RUNTIME_MANIFEST_UNREADABLE", `staged engine runtime manifest is unreadable: ${String(error)}`);
  }
  if (!isRuntimeManifest(value)) throw new EngineBundleError("INVALID_RUNTIME_MANIFEST", "staged engine runtime manifest is invalid");
  return value;
}

function verifyRuntimeDirectory(root: string, expected: EngineRuntimeManifestV1): void {
  ensurePrivateDirectory(root);
  const actual = readRuntimeManifest(root);
  if (actual.sha256 !== expected.sha256 || actual.byteSize !== expected.byteSize) {
    throw new EngineBundleError("RUNTIME_MANIFEST_MISMATCH", "staged engine runtime manifest changed");
  }
  const executable = path.join(root, "node");
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.byteSize) {
    throw new EngineBundleError("UNSAFE_STAGED_RUNTIME", "staged engine runtime is not a regular file of the expected size");
  }
  if (process.platform !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0 || (stat.mode & 0o100) === 0) {
      throw new EngineBundleError("UNSAFE_STAGED_RUNTIME", "staged engine runtime ownership or permissions are unsafe");
    }
  }
  if (sha256File(executable) !== expected.sha256) {
    throw new EngineBundleError("RUNTIME_HASH_MISMATCH", "staged engine runtime hash mismatch");
  }
}

function isRuntimeManifest(value: unknown): value is EngineRuntimeManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3
    && record.schemaVersion === 1
    && isSha256(record.sha256)
    && Number.isSafeInteger(record.byteSize)
    && (record.byteSize as number) > 0;
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
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let offset = 0;
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}
