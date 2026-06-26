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
import { downloadToTemp, verifyArtifact, extractArchiveMember, installExecutable, smokeCheck, isTrustedExecPath } from "./toolProvisioning.js";
import { materializeLauncher } from "./toolLauncher.js";
import { ToolTransaction } from "./toolTransaction.js";
import { physicalToolKey, type ToolLock, type LauncherLock, type Lockfile } from "./lockfile.js";
import type { ToolPlan } from "./toolPlan.js";

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
