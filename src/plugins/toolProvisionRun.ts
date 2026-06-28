/**
 * spec 265 task 10b — the PROVISIONING COMMIT PATH orchestrator. Given a consented ToolPlan, provision every
 * fetched tool into the live content-addressed store under a crash-safe transaction, smoke-check it, materialize
 * the workspace launcher atomically, and return the ToolLocks + LauncherLock for the engine to commit into the
 * lockfile. Rolls back just-installed (non-reused, unreferenced) binaries on any failure.
 *
 * No `${tool:}` activation here (that is task 10c) — this only makes the binaries + launcher exist and recorded.
 */

import fs from "node:fs";
import path from "node:path";
import { downloadToTemp, verifyArtifact, extractArchiveMember, installExecutable, installData, smokeCheck, sha256File, sha256FileStreaming, isTrustedExecPath, MAX_DATA_ARTIFACT_BYTES } from "./toolProvisioning.js";
import { materializeLauncher } from "./toolLauncher.js";
import { materializeDataResolver } from "./dataLauncher.js";
import { ToolTransaction } from "./toolTransaction.js";
import { parseLockfile, serializeLockfile, LOCKFILE_REL_PATH, physicalToolKey, physicalDataKey, type ToolLock, type DataLock, type LauncherLock, type Lockfile } from "./lockfile.js";
import type { ToolPlan } from "./toolPlan.js";
import type { DataPlan } from "./dataPlan.js";

export const TACHYON_DATA_REL = ".tachyon/data/sha256";

export const TACHYON_BIN_REL = ".tachyon/bin";

export interface ProvisionOpts {
  /** the explicit per-tool acknowledgement (download + execute a binary) — fail-closed at the engine. */
  toolConfirmed?: boolean;
  /** the extension-bundled launcher validator (dist/tool-launcher.cjs) to copy into the workspace. */
  launcherBundlePath: string;
  /** the absolute Node the shim execs (default process.execPath); trust-checked before use. */
  nodePath?: string;
  /** TEST-ONLY: a trusted CA injected into the download client. */
  tlsCa?: string | Buffer;
  /** the current lockfile (for physical-refcount rollback — never delete another plugin's bytes). */
  existingLockfile: Lockfile;
  /** test injection. */
  txid?: string;
  startedAtIso?: string;
}

export interface ProvisionResult {
  toolLocks: ToolLock[];
  launcher?: LauncherLock;
  errors: string[];
}

interface Installed {
  name: string;
  binSha256: string;
  /** absolute content-addressed dir `<binDir>/<name>/<binSha>` (the rollback unit). */
  binShaDir: string;
  reused: boolean;
}

/** Provision a plugin's tools. Returns the locks + launcher, or errors (with rollback already performed). */
export async function provisionTools(pluginName: string, workspaceRoot: string, toolPlan: ToolPlan, opts: ProvisionOpts): Promise<ProvisionResult> {
  if (toolPlan.items.length === 0) return { toolLocks: [], errors: [] };
  if (opts.toolConfirmed !== true) {
    return { toolLocks: [], errors: ["tools download + execute a binary — re-open the consent drawer and confirm the tool acknowledgement before installing"] };
  }

  // resolve + trust-check the Node the launcher shim will exec.
  const nodePath = opts.nodePath ?? process.execPath;
  const trust = isTrustedExecPath(nodePath, process.getuid?.() ?? 0, (p) => {
    try {
      return fs.statSync(p);
    } catch {
      return null;
    }
  });
  if (!trust.trusted) return { toolLocks: [], errors: [`launcher Node '${nodePath}' is not trusted: ${trust.reason}`] };

  const binDir = path.join(workspaceRoot, TACHYON_BIN_REL);
  // physical keys already referenced by the lockfile — never roll back those bytes.
  const preserved = new Set<string>();
  for (const lock of Object.values(opts.existingLockfile.plugins)) for (const t of lock.tools ?? []) preserved.add(physicalToolKey(t));

  const tx = ToolTransaction.begin(workspaceRoot, { plugin: pluginName, txid: opts.txid, startedAtIso: opts.startedAtIso });
  const installed: Installed[] = [];
  const toolLocks: ToolLock[] = [];

  const rollback = () => {
    for (const i of installed) {
      // delete only what THIS run freshly created (not a reused copy) and that the lockfile doesn't already
      // reference — never another plugin's bytes.
      const lock = toolLocks.find((t) => t.name === i.name && t.binSha256 === i.binSha256);
      const referenced = lock ? preserved.has(physicalToolKey(lock)) : false;
      if (!i.reused && !referenced) fs.rmSync(i.binShaDir, { recursive: true, force: true });
    }
    tx.abandon();
  };

  try {
    for (const item of toolPlan.items) {
      tx.appendJournal({ step: "begin", tool: item.name });
      const dl = await downloadToTemp(item.finalUrl, { destDir: tx.stagingDir(), tlsCa: opts.tlsCa });
      if (!dl.ok) {
        rollback();
        return { toolLocks: [], errors: [`tool '${item.name}': download failed (${dl.code}: ${dl.detail})`] };
      }
      const vf = verifyArtifact(dl.tempPath, item.sha256);
      if (!vf.ok) {
        rollback();
        return { toolLocks: [], errors: [`tool '${item.name}': artifact checksum ${vf.code} (${vf.detail})`] };
      }

      let exeSrc = dl.tempPath;
      if (item.archive) {
        const ex = await extractArchiveMember(dl.tempPath, { innerPath: item.archive.innerPath, binSha256: item.binSha256, destDir: tx.stagingDir() });
        if (!ex.ok) {
          rollback();
          return { toolLocks: [], errors: [`tool '${item.name}': archive ${ex.code} (${ex.detail})`] };
        }
        exeSrc = ex.tempPath;
      }

      const inst = installExecutable(exeSrc, { binDir, name: item.name, exeName: item.exeName, binSha256: item.binSha256 });
      if (!inst.ok) {
        rollback();
        return { toolLocks: [], errors: [`tool '${item.name}': install ${inst.code} (${inst.detail})`] };
      }
      installed.push({ name: item.name, binSha256: item.binSha256, binShaDir: path.join(binDir, item.name, item.binSha256), reused: inst.reused });

      const smoke = smokeCheck(inst.installPath);
      if (!smoke.ok) {
        rollback();
        return { toolLocks: [], errors: [`tool '${item.name}': smoke-check ${smoke.code} (${smoke.detail}) — the binary is not runnable on this host`] };
      }

      toolLocks.push({
        name: item.name,
        source: "fetched",
        resolvedPlatform: item.resolvedPlatform,
        version: item.version,
        binSha256: item.binSha256,
        exeName: item.exeName,
        installPath: path.posix.join(TACHYON_BIN_REL, item.name, item.binSha256, item.exeName),
        declaredUrl: item.declaredUrl,
        finalUrl: item.finalUrl,
        artifactSha256: item.sha256,
        ...(item.archive ? { archive: { innerPath: item.archive.innerPath } } : {}),
        ...(item.launchPolicy ? { launchPolicy: item.launchPolicy } : {}), // spec 269 — carry the consented policy into the lock
      });
      tx.appendJournal({ step: "installed", tool: item.name, binSha256: item.binSha256, reused: inst.reused });
    }

    // materialize the workspace launcher (shim + validator) atomically-ish under the bin dir.
    const lr = materializeLauncher(binDir, { nodePath, launcherBundlePath: opts.launcherBundlePath });
    const launcher: LauncherLock = { nodePath, shimSha256: lr.shimSha256, validatorSha256: lr.validatorSha256 };

    tx.abandon(); // success → drop the staging journal
    return { toolLocks, launcher, errors: [] };
  } catch (e) {
    rollback();
    return { toolLocks: [], errors: [`tool provisioning failed: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

export interface RehydrateOpts {
  launcherBundlePath: string;
  nodePath?: string;
  /** TEST-ONLY trusted CA. */
  tlsCa?: string | Buffer;
}

export interface RehydrateResult {
  rehydrated: number;
  launcher?: LauncherLock;
  errors: string[];
}

/**
 * spec 265 task 11 — re-provision a workspace's FETCHED tools from the committed lockfile (the clone/CI case:
 * `.tachyon/bin` is gitignored, so a fresh checkout has the lockfile but no binaries). EXPLICIT (never a silent
 * fetch) + RE-RESOLVES Node (the baked nodePath can't be trusted on another machine). Idempotent: an already-
 * present, hash-matching binary is skipped. Host-provided tools are left to runtime re-validation by the launcher.
 */
export async function rehydrateTools(workspaceRoot: string, opts: RehydrateOpts): Promise<RehydrateResult> {
  const lockPath = path.join(workspaceRoot, LOCKFILE_REL_PATH);
  if (!fs.existsSync(lockPath)) return { rehydrated: 0, errors: [`${LOCKFILE_REL_PATH} is absent — nothing to rehydrate`] };
  const parsed = parseLockfile(fs.readFileSync(lockPath, "utf8"));
  if (!parsed.lockfile) return { rehydrated: 0, errors: [`lockfile is corrupt: ${parsed.errors[0] ?? "?"}`] };
  const lockfile = parsed.lockfile;

  // unique FETCHED tools by physical identity (the same bytes are installed once).
  const unique = new Map<string, ToolLock>();
  for (const lock of Object.values(lockfile.plugins)) for (const t of lock.tools ?? []) if (t.source === "fetched") unique.set(physicalToolKey(t), t);
  if (unique.size === 0) return { rehydrated: 0, errors: [] };

  const nodePath = opts.nodePath ?? process.execPath;
  const trust = isTrustedExecPath(nodePath, process.getuid?.() ?? 0, (p) => {
    try {
      return fs.statSync(p);
    } catch {
      return null;
    }
  });
  if (!trust.trusted) return { rehydrated: 0, errors: [`launcher Node '${nodePath}' is not trusted: ${trust.reason}`] };

  const binDir = path.join(workspaceRoot, ".tachyon", "bin");
  const tx = ToolTransaction.begin(workspaceRoot, { plugin: "__rehydrate__" });
  let rehydrated = 0;
  try {
    for (const t of unique.values()) {
      const installAbs = path.join(workspaceRoot, t.installPath);
      // idempotent: a present, hash-matching binary is already good.
      if (fs.existsSync(installAbs)) {
        try {
          if (sha256File(installAbs) === t.binSha256) continue;
        } catch {
          /* unreadable → re-provision */
        }
      }
      if (!t.finalUrl || !t.artifactSha256) {
        tx.abandon();
        return { rehydrated: 0, errors: [`tool '${t.name}': lockfile is missing fetch provenance (finalUrl/artifactSha256)`] };
      }
      const dl = await downloadToTemp(t.finalUrl, { destDir: tx.stagingDir(), tlsCa: opts.tlsCa });
      if (!dl.ok) {
        tx.abandon();
        return { rehydrated: 0, errors: [`tool '${t.name}': download failed (${dl.code}: ${dl.detail})`] };
      }
      const vf = verifyArtifact(dl.tempPath, t.artifactSha256);
      if (!vf.ok) {
        tx.abandon();
        return { rehydrated: 0, errors: [`tool '${t.name}': artifact ${vf.code} (${vf.detail})`] };
      }
      let exeSrc = dl.tempPath;
      if (t.archive) {
        const ex = await extractArchiveMember(dl.tempPath, { innerPath: t.archive.innerPath, binSha256: t.binSha256, destDir: tx.stagingDir() });
        if (!ex.ok) {
          tx.abandon();
          return { rehydrated: 0, errors: [`tool '${t.name}': archive ${ex.code} (${ex.detail})`] };
        }
        exeSrc = ex.tempPath;
      }
      const inst = installExecutable(exeSrc, { binDir, name: t.name, exeName: t.exeName, binSha256: t.binSha256 });
      if (!inst.ok) {
        tx.abandon();
        return { rehydrated: 0, errors: [`tool '${t.name}': install ${inst.code} (${inst.detail})`] };
      }
      const smoke = smokeCheck(inst.installPath);
      if (!smoke.ok) {
        tx.abandon();
        return { rehydrated: 0, errors: [`tool '${t.name}': smoke-check ${smoke.code} (${smoke.detail})`] };
      }
      rehydrated++;
    }

    // re-materialize the launcher (re-resolved Node) + refresh the lockfile launcher record.
    const lr = materializeLauncher(binDir, { nodePath, launcherBundlePath: opts.launcherBundlePath });
    const launcher: LauncherLock = { nodePath, shimSha256: lr.shimSha256, validatorSha256: lr.validatorSha256 };
    lockfile.launcher = launcher;
    fs.writeFileSync(lockPath, serializeLockfile(lockfile));
    tx.abandon();
    return { rehydrated, launcher, errors: [] };
  } catch (e) {
    tx.abandon();
    return { rehydrated: 0, errors: [`rehydrate failed: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

// ───────────────────────── spec 284 — DATA artifact provisioning (non-executable sibling) ─────────────────────────

export interface ProvisionDataOpts {
  /** the explicit data acknowledgement (download + store a checksummed DATA file — no execution). Fail-closed. */
  dataConfirmed?: boolean;
  /** TEST-ONLY: a trusted CA injected into the download client. */
  tlsCa?: string | Buffer;
  /** the current lockfile (for physical-refcount rollback — never delete another plugin's bytes). */
  existingLockfile: Lockfile;
  /** the data-resolver bundle (dist/data-resolver.cjs) to materialize the `_tachyon-data` shim; omit to skip (tests). */
  resolverBundlePath?: string;
  /** the absolute Node the shim execs (default process.execPath); trust-checked before use. */
  nodePath?: string;
  txid?: string;
  startedAtIso?: string;
}

export interface ProvisionDataResult {
  dataLocks: DataLock[];
  /** present when resolverBundlePath was given + materialization succeeded — merged into the lockfile launcher block. */
  resolver?: { nodePath: string; dataShimSha256: string; dataValidatorSha256: string };
  errors: string[];
}

interface InstalledData {
  contentSha256: string;
  /** absolute content-addressed dir `<dataDir>/<sha>` (the rollback unit). */
  shaDir: string;
  reused: boolean;
}

/**
 * spec 284 — provision a plugin's DATA artifacts (the non-executable sibling of provisionTools): download → verify
 * → installData (streamed, read-only, NO smoke, NO launcher). Returns the DataLocks for the engine to commit. Rolls
 * back just-installed (non-reused, unreferenced) blobs on any failure. The `_tachyon-data` resolver shim is NOT
 * materialized here — the engine does that once per workspace alongside the tool launcher.
 */
export async function provisionData(pluginName: string, workspaceRoot: string, dataPlan: DataPlan, opts: ProvisionDataOpts): Promise<ProvisionDataResult> {
  if (dataPlan.items.length === 0) return { dataLocks: [], errors: [] };
  if (opts.dataConfirmed !== true) {
    return { dataLocks: [], errors: ["data artifacts download + store a checksummed file — re-open the consent drawer and confirm the data acknowledgement before installing"] };
  }

  const dataDir = path.join(workspaceRoot, TACHYON_DATA_REL);
  // physical keys already referenced by the lockfile — never roll back those bytes.
  const preserved = new Set<string>();
  for (const lock of Object.values(opts.existingLockfile.plugins)) for (const d of lock.data ?? []) preserved.add(physicalDataKey(d));

  const tx = ToolTransaction.begin(workspaceRoot, { plugin: pluginName, txid: opts.txid, startedAtIso: opts.startedAtIso });
  const installed: InstalledData[] = [];
  const dataLocks: DataLock[] = [];

  const rollback = () => {
    for (const i of installed) {
      const lock = dataLocks.find((d) => d.contentSha256 === i.contentSha256);
      const referenced = lock ? preserved.has(physicalDataKey(lock)) : false;
      if (!i.reused && !referenced) fs.rmSync(i.shaDir, { recursive: true, force: true });
    }
    tx.abandon();
  };

  try {
    for (const item of dataPlan.items) {
      tx.appendJournal({ step: "begin", tool: `data:${item.name}` });
      const dl = await downloadToTemp(item.finalUrl, { destDir: tx.stagingDir(), tlsCa: opts.tlsCa, maxBytes: MAX_DATA_ARTIFACT_BYTES });
      if (!dl.ok) {
        rollback();
        return { dataLocks: [], errors: [`data '${item.name}': download failed (${dl.code}: ${dl.detail})`] };
      }
      const vf = verifyArtifact(dl.tempPath, item.sha256);
      if (!vf.ok) {
        rollback();
        return { dataLocks: [], errors: [`data '${item.name}': artifact checksum ${vf.code} (${vf.detail})`] };
      }
      const inst = installData(dl.tempPath, { dataDir, sha256: item.sha256, fileName: item.fileName });
      if (!inst.ok) {
        rollback();
        return { dataLocks: [], errors: [`data '${item.name}': install ${inst.code} (${inst.detail})`] };
      }
      installed.push({ contentSha256: item.sha256, shaDir: path.join(dataDir, item.sha256), reused: inst.reused });
      dataLocks.push({
        name: item.name,
        resolvedPlatform: item.resolvedPlatform,
        version: item.version,
        contentSha256: item.sha256,
        fileName: item.fileName,
        installPath: path.posix.join(TACHYON_DATA_REL, item.sha256, item.fileName),
        declaredUrl: item.declaredUrl,
        finalUrl: item.finalUrl,
      });
      tx.appendJournal({ step: "installed", tool: `data:${item.name}`, binSha256: item.sha256, reused: inst.reused });
    }

    // materialize the `_tachyon-data` resolver shim (when a bundle is given) so a skill can resolve the blob with
    // no VS Code running — the data analog of the launcher. Trust-check the Node baked into the shim first.
    let resolver: ProvisionDataResult["resolver"];
    if (opts.resolverBundlePath) {
      const nodePath = opts.nodePath ?? process.execPath;
      const trust = isTrustedExecPath(nodePath, process.getuid?.() ?? 0, (p) => { try { return fs.statSync(p); } catch { return null; } });
      if (!trust.trusted) {
        rollback();
        return { dataLocks: [], errors: [`data resolver Node '${nodePath}' is not trusted: ${trust.reason}`] };
      }
      const mr = materializeDataResolver(path.join(workspaceRoot, TACHYON_BIN_REL), { nodePath, resolverBundlePath: opts.resolverBundlePath });
      resolver = { nodePath, dataShimSha256: mr.shimSha256, dataValidatorSha256: mr.validatorSha256 };
    }

    tx.abandon(); // success → drop the staging journal
    return { dataLocks, ...(resolver ? { resolver } : {}), errors: [] };
  } catch (e) {
    rollback();
    return { dataLocks: [], errors: [`data provisioning failed: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

export interface RehydrateDataResult {
  rehydrated: number;
  errors: string[];
}

/**
 * spec 284 — re-provision a workspace's DATA artifacts from the committed lockfile (the clone/CI case: `.tachyon/data`
 * is gitignored). EXPLICIT, never a silent fetch. Idempotent: a present, hash-matching blob is skipped. Does NOT
 * write the lockfile or materialize the shim (the engine's rehydrate orchestration owns those).
 */
export async function rehydrateData(workspaceRoot: string, opts: { tlsCa?: string | Buffer } = {}): Promise<RehydrateDataResult> {
  const lockPath = path.join(workspaceRoot, LOCKFILE_REL_PATH);
  if (!fs.existsSync(lockPath)) return { rehydrated: 0, errors: [] };
  const parsed = parseLockfile(fs.readFileSync(lockPath, "utf8"));
  if (!parsed.lockfile) return { rehydrated: 0, errors: [`lockfile is corrupt: ${parsed.errors[0] ?? "?"}`] };

  // unique DATA blobs by physical identity (the same bytes are installed once).
  const unique = new Map<string, DataLock>();
  for (const lock of Object.values(parsed.lockfile.plugins)) for (const d of lock.data ?? []) unique.set(physicalDataKey(d), d);
  if (unique.size === 0) return { rehydrated: 0, errors: [] };

  const dataDir = path.join(workspaceRoot, TACHYON_DATA_REL);
  const tx = ToolTransaction.begin(workspaceRoot, { plugin: "__rehydrate_data__" });
  let rehydrated = 0;
  try {
    for (const d of unique.values()) {
      const installAbs = path.join(workspaceRoot, d.installPath);
      if (fs.existsSync(installAbs)) {
        try {
          if (sha256FileStreaming(installAbs) === d.contentSha256) continue;
        } catch {
          /* unreadable → re-provision */
        }
      }
      const dl = await downloadToTemp(d.finalUrl, { destDir: tx.stagingDir(), tlsCa: opts.tlsCa, maxBytes: MAX_DATA_ARTIFACT_BYTES });
      if (!dl.ok) {
        tx.abandon();
        return { rehydrated: 0, errors: [`data '${d.name}': download failed (${dl.code}: ${dl.detail})`] };
      }
      const vf = verifyArtifact(dl.tempPath, d.contentSha256);
      if (!vf.ok) {
        tx.abandon();
        return { rehydrated: 0, errors: [`data '${d.name}': artifact ${vf.code} (${vf.detail})`] };
      }
      const inst = installData(dl.tempPath, { dataDir, sha256: d.contentSha256, fileName: d.fileName });
      if (!inst.ok) {
        tx.abandon();
        return { rehydrated: 0, errors: [`data '${d.name}': install ${inst.code} (${inst.detail})`] };
      }
      rehydrated++;
    }
    tx.abandon();
    return { rehydrated, errors: [] };
  } catch (e) {
    tx.abandon();
    return { rehydrated: 0, errors: [`data rehydrate failed: ${e instanceof Error ? e.message : String(e)}`] };
  }
}
