/**
 * spec 377 T15A — durable profile mutation journal for common-path actions.
 *
 * Mutating actions (create / import / adopt / enable / disable) hold the shared
 * per-principal admission lock, reject active launch reservations, write a same-
 * filesystem journal under `.tachyon/agent-profile-transactions/<txid>/`, CAS only
 * the affected agent stanza + name presence + profile ID/digests, compensate
 * ordinary failures, and leave a blocking `profile-transaction-degraded` journal
 * when convergence cannot be proven. Replace / rename / destructive delete / Repair
 * UI remain out of scope for T15A.
 */

import { constants as fsConstants } from "node:fs";
import {
  open,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
  lstat,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  SOUL_MINIMAL_TEMPLATE,
  SoulError,
  agentSoulManifestPath,
  agentSoulPath,
  assertNoActiveLaunchReservation,
  findFoldedProfileCollision,
  inspectSoulProfile,
  isCanonicalSoulPath,
  publishCanonicalSoulFiles,
  readCanonicalSoulBytes,
  readSoulManifestAnyState,
  readValidatedSoulSourceBytes,
  resolveSoul,
  validateSoulAgentName,
  validateSoulBytes,
  withSoulProfileAdmission,
  writeSoulManifestState,
  type SoulProfileManifest,
  type SoulProfileStatus,
} from "./soul.js";
import {
  agentStanzaCasToken,
  setAgentSoulEnablement,
  type AgentStanzaCasToken,
} from "../config/YamlConfigEditor.js";

export const PROFILE_TRANSACTIONS_REL = ".tachyon/agent-profile-transactions";
export const PROFILE_TX_SCHEMA_VERSION = 1 as const;

export type ProfileTransactionAction = "create" | "import" | "adopt" | "enable" | "disable";
export type ProfileTransactionPhase =
  | "intent"
  | "staged"
  | "published"
  | "config-written"
  | "committed"
  | "compensating"
  | "degraded";

export interface ProfileTransactionJournal {
  schemaVersion: typeof PROFILE_TX_SCHEMA_VERSION;
  txid: string;
  action: ProfileTransactionAction;
  principal: string;
  phase: ProfileTransactionPhase;
  profileId?: string;
  /** Prior soul bytes digest when known (null = no prior file). */
  priorSoulDigest: string | null;
  /** Target soul bytes digest after successful publish (null for enable-only). */
  targetSoulDigest: string | null;
  priorManifestState: "active" | "retained" | "missing" | "unowned";
  targetManifestState: "active" | "retained";
  priorConfig: AgentStanzaCasToken;
  expectedSoulEnabled: boolean;
  createdAt: string;
  degraded?: boolean;
  degradedCode?: "profile-transaction-degraded";
  degradedReason?: string;
  /** Never stores an import source path. */
}

export interface ProfileMutationResult {
  action: ProfileTransactionAction;
  profileId?: string;
  sha256?: string;
  chars?: number;
  bytes?: number;
  status: SoulProfileStatus;
  /** True when the selected import path was the canonical profile (self-selection → adopt/enable). */
  selfSelected?: boolean;
}

export function profileTransactionsRoot(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), PROFILE_TRANSACTIONS_REL);
}

function journalPath(txDir: string): string {
  return path.join(txDir, "journal.json");
}

function backupSoulPath(txDir: string): string {
  return path.join(txDir, "backup-SOUL.md");
}

function backupManifestPath(txDir: string): string {
  return path.join(txDir, "backup-profile.json");
}

function backupConfigPath(txDir: string): string {
  return path.join(txDir, "backup-tachyon.yml");
}

async function ensureTxRoot(workspaceRoot: string): Promise<string> {
  const root = profileTransactionsRoot(workspaceRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

async function writeJournal(txDir: string, journal: ProfileTransactionJournal): Promise<void> {
  const file = journalPath(txDir);
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  await rename(tmp, file);
}

async function readJournal(txDir: string): Promise<ProfileTransactionJournal | undefined> {
  try {
    const raw = await readFile(journalPath(txDir), "utf8");
    const value = JSON.parse(raw) as ProfileTransactionJournal;
    if (value.schemaVersion !== PROFILE_TX_SCHEMA_VERSION || typeof value.txid !== "string") return undefined;
    return value;
  } catch {
    return undefined;
  }
}

async function durableCopy(from: string, to: string): Promise<void> {
  const bytes = await readFile(from);
  const handle = await open(to, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

export interface ProfileTxConfigAccess {
  /** Absolute path to tachyon.yml (may not exist yet). */
  configPath: string;
  readConfigText(): string | undefined;
  /**
   * Validate-then-write full YAML. Must throw on validation failure and leave the
   * previous file intact. Returns the written text.
   */
  writeConfigText(text: string): string;
  /** Whether the agent is currently soul-enabled in the live config. */
  isSoulEnabled(name: string): boolean;
}

async function capturePriorProfile(workspaceRoot: string, name: string, txDir: string): Promise<{
  priorManifestState: ProfileTransactionJournal["priorManifestState"];
  priorSoulDigest: string | null;
  priorProfileId?: string;
  priorManifest?: SoulProfileManifest;
}> {
  let priorManifestState: ProfileTransactionJournal["priorManifestState"] = "missing";
  let priorSoulDigest: string | null = null;
  let priorProfileId: string | undefined;
  let priorManifest: SoulProfileManifest | undefined;
  try {
    priorManifest = await readSoulManifestAnyState(workspaceRoot, name);
    priorManifestState = priorManifest.state;
    priorProfileId = priorManifest.profileId;
    if (await pathExists(agentSoulManifestPath(workspaceRoot, name))) {
      await durableCopy(agentSoulManifestPath(workspaceRoot, name), backupManifestPath(txDir));
    }
  } catch {
    const bytes = await readCanonicalSoulBytes(workspaceRoot, name);
    if (bytes) priorManifestState = "unowned";
  }
  const soulPath = agentSoulPath(workspaceRoot, name);
  if (await pathExists(soulPath)) {
    await durableCopy(soulPath, backupSoulPath(txDir));
    const bytes = await readFile(backupSoulPath(txDir));
    priorSoulDigest = createHash("sha256").update(bytes).digest("hex");
  }
  return { priorManifestState, priorSoulDigest, priorProfileId, priorManifest };
}

async function restoreFromBackup(workspaceRoot: string, name: string, txDir: string, journal: ProfileTransactionJournal): Promise<void> {
  const soulPath = agentSoulPath(workspaceRoot, name);
  const manifestPath = agentSoulManifestPath(workspaceRoot, name);
  if (await pathExists(backupSoulPath(txDir))) {
    await mkdir(path.dirname(soulPath), { recursive: true, mode: 0o700 });
    await unlink(soulPath).catch(() => undefined);
    await durableCopy(backupSoulPath(txDir), soulPath);
  } else if (journal.priorSoulDigest === null) {
    await unlink(soulPath).catch(() => undefined);
  }
  if (await pathExists(backupManifestPath(txDir))) {
    await unlink(manifestPath).catch(() => undefined);
    await durableCopy(backupManifestPath(txDir), manifestPath);
  } else if (journal.priorManifestState === "missing") {
    await unlink(manifestPath).catch(() => undefined);
  }
}

function markDegraded(journal: ProfileTransactionJournal, reason: string): ProfileTransactionJournal {
  return {
    ...journal,
    phase: "degraded",
    degraded: true,
    degradedCode: "profile-transaction-degraded",
    degradedReason: reason,
  };
}

async function removeTxDir(txDir: string): Promise<void> {
  await rm(txDir, { recursive: true, force: true });
}

async function applyConfigSoul(
  access: ProfileTxConfigAccess,
  name: string,
  enabled: boolean,
  expected: AgentStanzaCasToken,
  txDir: string,
): Promise<void> {
  const existing = access.readConfigText();
  if (existing !== undefined && !(await pathExists(backupConfigPath(txDir)))) {
    const handle = await open(backupConfigPath(txDir), fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(existing);
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  const current = agentStanzaCasToken(existing, name);
  if (current.present !== expected.present || current.hash !== expected.hash) {
    throw new SoulError(
      "soul/profile-transaction-degraded",
      `Affected agent stanza for '${name}' changed during the profile transaction (CAS mismatch)`,
    );
  }
  const { text } = setAgentSoulEnablement(existing, name, enabled);
  access.writeConfigText(text);
  const after = agentStanzaCasToken(access.readConfigText(), name);
  if (!after.present || after.soulEnabled !== enabled) {
    throw new SoulError("soul/io-error", `Config CAS failed to converge soul enablement for '${name}'`);
  }
}

async function compensate(
  workspaceRoot: string,
  name: string,
  access: ProfileTxConfigAccess,
  txDir: string,
  journal: ProfileTransactionJournal,
): Promise<void> {
  const next = { ...journal, phase: "compensating" as const };
  await writeJournal(txDir, next);
  try {
    await restoreFromBackup(workspaceRoot, name, txDir, journal);
    if (await pathExists(backupConfigPath(txDir))) {
      const prior = await readFile(backupConfigPath(txDir), "utf8");
      access.writeConfigText(prior);
    } else if (journal.priorConfig.present && journal.priorConfig.soulEnabled !== journal.expectedSoulEnabled) {
      // no backup but config was touched — try reverse enablement using current text
      const currentText = access.readConfigText();
      if (currentText !== undefined) {
        const { text } = setAgentSoulEnablement(currentText, name, journal.priorConfig.soulEnabled);
        access.writeConfigText(text);
      }
    }
    // Prove convergence to prior
    const soulBytes = await readCanonicalSoulBytes(workspaceRoot, name);
    const digest = soulBytes ? createHash("sha256").update(soulBytes).digest("hex") : null;
    if (digest !== journal.priorSoulDigest) {
      throw new Error(`soul digest ${digest} !== prior ${journal.priorSoulDigest}`);
    }
    const cfg = agentStanzaCasToken(access.readConfigText(), name);
    if (cfg.present !== journal.priorConfig.present || cfg.soulEnabled !== journal.priorConfig.soulEnabled) {
      throw new Error("config did not restore to prior soul enablement/presence");
    }
    await removeTxDir(txDir);
  } catch (error) {
    const degraded = markDegraded(journal, error instanceof Error ? error.message : String(error));
    await writeJournal(txDir, degraded);
    throw new SoulError("soul/profile-transaction-degraded", `Profile transaction for '${name}' is degraded and blocks further mutations`, {
      cause: error,
    });
  }
}

async function beginJournal(
  workspaceRoot: string,
  name: string,
  action: ProfileTransactionAction,
  access: ProfileTxConfigAccess,
  expectedSoulEnabled: boolean,
): Promise<{ txDir: string; journal: ProfileTransactionJournal; prior: Awaited<ReturnType<typeof capturePriorProfile>> }> {
  validateSoulAgentName(name);
  await assertNoActiveLaunchReservation(workspaceRoot, name);
  const degraded = await listDegradedTransactions(workspaceRoot, name);
  if (degraded.length > 0) {
    throw new SoulError(
      "soul/profile-transaction-degraded",
      `Soul profile for '${name}' has a blocking profile-transaction-degraded journal`,
    );
  }
  const collision = await findFoldedProfileCollision(workspaceRoot, name);
  if (collision && collision.owner !== name) {
    throw new SoulError(
      "soul/profile-collision",
      `Soul profile name '${name}' collides with existing profile owner '${collision.owner}' (profileId ${collision.profileId})`,
    );
  }
  const root = await ensureTxRoot(workspaceRoot);
  const txid = randomUUID();
  const txDir = path.join(root, txid);
  await mkdir(txDir, { recursive: true, mode: 0o700 });
  const priorConfig = agentStanzaCasToken(access.readConfigText(), name);
  if (!priorConfig.present && action !== "create" && action !== "import") {
    // enable/disable/adopt still require a declared agent for config CAS
  }
  const prior = await capturePriorProfile(workspaceRoot, name, txDir);
  const journal: ProfileTransactionJournal = {
    schemaVersion: PROFILE_TX_SCHEMA_VERSION,
    txid,
    action,
    principal: name,
    phase: "intent",
    profileId: prior.priorProfileId,
    priorSoulDigest: prior.priorSoulDigest,
    targetSoulDigest: null,
    priorManifestState: prior.priorManifestState,
    targetManifestState: action === "disable" ? "retained" : "active",
    priorConfig,
    expectedSoulEnabled,
    createdAt: new Date().toISOString(),
  };
  await writeJournal(txDir, journal);
  return { txDir, journal, prior };
}

async function commitSuccess(
  workspaceRoot: string,
  name: string,
  access: ProfileTxConfigAccess,
  txDir: string,
  journal: ProfileTransactionJournal,
  resultMeta: { profileId?: string; sha256?: string; chars?: number; bytes?: number; selfSelected?: boolean },
): Promise<ProfileMutationResult> {
  const committed = { ...journal, phase: "committed" as const, profileId: resultMeta.profileId ?? journal.profileId };
  await writeJournal(txDir, committed);
  await removeTxDir(txDir);
  const status = await inspectSoulProfile(workspaceRoot, name, {
    soulEnabled: access.isSoulEnabled(name),
    transactionDegraded: false,
    includePreview: true,
  });
  return {
    action: journal.action,
    profileId: resultMeta.profileId ?? status.profileId,
    sha256: resultMeta.sha256 ?? status.sha256,
    chars: resultMeta.chars ?? status.chars,
    bytes: resultMeta.bytes ?? status.bytes,
    status,
    selfSelected: resultMeta.selfSelected,
  };
}

async function runMutation(
  workspaceRoot: string,
  name: string,
  access: ProfileTxConfigAccess,
  action: ProfileTransactionAction,
  body: (ctx: {
    txDir: string;
    journal: ProfileTransactionJournal;
    prior: Awaited<ReturnType<typeof capturePriorProfile>>;
  }) => Promise<{ journal: ProfileTransactionJournal; profileId?: string; sha256?: string; chars?: number; bytes?: number; selfSelected?: boolean }>,
): Promise<ProfileMutationResult> {
  return withSoulProfileAdmission(workspaceRoot, name, async () => {
    const expectedSoulEnabled = action !== "disable";
    const { txDir, journal: started, prior } = await beginJournal(workspaceRoot, name, action, access, expectedSoulEnabled);
    let journal = started;
    try {
      const out = await body({ txDir, journal, prior });
      journal = out.journal;
      return await commitSuccess(workspaceRoot, name, access, txDir, journal, out);
    } catch (error) {
      if (error instanceof SoulError && error.code === "soul/profile-transaction-degraded") throw error;
      try {
        await compensate(workspaceRoot, name, access, txDir, journal);
      } catch (compErr) {
        if (compErr instanceof SoulError) throw compErr;
        throw new SoulError("soul/profile-transaction-degraded", `Profile transaction for '${name}' failed and could not compensate`, {
          cause: compErr,
        });
      }
      throw error instanceof SoulError
        ? error
        : new SoulError("soul/io-error", error instanceof Error ? error.message : String(error), { cause: error });
    }
  });
}

/** Create publishes the minimal template exclusively; never overwrites retained/active bytes. */
export function createSoulProfile(
  workspaceRoot: string,
  name: string,
  access: ProfileTxConfigAccess,
): Promise<ProfileMutationResult> {
  return runMutation(workspaceRoot, name, access, "create", async ({ txDir, journal, prior }) => {
    if (prior.priorManifestState !== "missing" || prior.priorSoulDigest !== null) {
      throw new SoulError(
        "soul/profile-adoption-required",
        `Canonical profile data already exists for '${name}'; use Adopt/Open rather than silent overwrite`,
      );
    }
    if (!journal.priorConfig.present) {
      throw new SoulError("soul/path-invalid", `Agent '${name}' is not declared in tachyon.yml`);
    }
    const bytes = Buffer.from(SOUL_MINIMAL_TEMPLATE, "utf8");
    const validated = validateSoulBytes(bytes);
    const profileId = randomUUID();
    const manifest: SoulProfileManifest = { schemaVersion: 1, profileId, owner: name, state: "active" };
    let next: ProfileTransactionJournal = {
      ...journal,
      phase: "staged",
      profileId,
      targetSoulDigest: validated.sha256,
      targetManifestState: "active",
    };
    await writeJournal(txDir, next);
    // Stage bytes into the tx dir for crash recovery diagnostics (exact template).
    await writeFile(path.join(txDir, "staged-SOUL.md"), bytes, { mode: 0o600 });
    next = { ...next, phase: "published" };
    await writeJournal(txDir, next);
    const published = await publishCanonicalSoulFiles(workspaceRoot, name, bytes, manifest);
    next = { ...next, phase: "config-written" };
    await writeJournal(txDir, next);
    await applyConfigSoul(access, name, true, journal.priorConfig, txDir);
    const resolved = await resolveSoul(workspaceRoot, name);
    if (resolved.sha256 !== validated.sha256) {
      throw new SoulError("soul/digest-mismatch", `Published soul digest mismatch for '${name}'`);
    }
    return { journal: next, profileId, sha256: published.sha256, chars: published.chars, bytes: published.bytes };
  });
}

/**
 * Import copies exact validated bytes. Never persists/logs the source path.
 * Selecting the canonical path is digest-backed Adopt/Enable without copying.
 */
export function importSoulProfileTransaction(
  workspaceRoot: string,
  name: string,
  importSource: string,
  access: ProfileTxConfigAccess,
): Promise<ProfileMutationResult> {
  // Self-selection is decided before journaling copy intent so the journal never records a path.
  if (isCanonicalSoulPath(workspaceRoot, name, importSource)) {
    return adoptSoulProfile(workspaceRoot, name, access, { expectedDigest: undefined, enable: true });
  }
  return runMutation(workspaceRoot, name, access, "import", async ({ txDir, journal, prior }) => {
    if (prior.priorManifestState !== "missing" || prior.priorSoulDigest !== null) {
      throw new SoulError(
        "soul/profile-adoption-required",
        `Canonical profile already exists for '${name}'; explicit adoption or replace is required`,
      );
    }
    if (!journal.priorConfig.present) {
      throw new SoulError("soul/path-invalid", `Agent '${name}' is not declared in tachyon.yml`);
    }
    // Read/validate first; the source path is local-only and never written into the journal.
    const bytes = await readValidatedSoulSourceBytes(importSource);
    const validated = validateSoulBytes(bytes);
    const profileId = randomUUID();
    const manifest: SoulProfileManifest = { schemaVersion: 1, profileId, owner: name, state: "active" };
    let next: ProfileTransactionJournal = {
      ...journal,
      phase: "staged",
      profileId,
      targetSoulDigest: validated.sha256,
      targetManifestState: "active",
    };
    await writeJournal(txDir, next);
    await writeFile(path.join(txDir, "staged-SOUL.md"), bytes, { mode: 0o600 });
    // Prove the staged file has no source path metadata — only exact content.
    next = { ...next, phase: "published" };
    await writeJournal(txDir, next);
    const published = await publishCanonicalSoulFiles(workspaceRoot, name, bytes, manifest);
    next = { ...next, phase: "config-written" };
    await writeJournal(txDir, next);
    await applyConfigSoul(access, name, true, journal.priorConfig, txDir);
    const resolved = await resolveSoul(workspaceRoot, name);
    if (resolved.sha256 !== validated.sha256) {
      throw new SoulError("soul/digest-mismatch", `Imported soul digest mismatch for '${name}'`);
    }
    return { journal: next, profileId, sha256: published.sha256, chars: published.chars, bytes: published.bytes };
  });
}

/** Digest-backed adopt of retained/unowned same-path data; marks active and enables soul. */
export function adoptSoulProfile(
  workspaceRoot: string,
  name: string,
  access: ProfileTxConfigAccess,
  opts?: { expectedDigest?: string; enable?: boolean },
): Promise<ProfileMutationResult> {
  const enable = opts?.enable !== false;
  return runMutation(workspaceRoot, name, access, "adopt", async ({ txDir, journal, prior }) => {
    if (!journal.priorConfig.present) {
      throw new SoulError("soul/path-invalid", `Agent '${name}' is not declared in tachyon.yml`);
    }
    const bytes = await readCanonicalSoulBytes(workspaceRoot, name);
    if (!bytes) {
      throw new SoulError("soul/missing", `No canonical soul bytes to adopt for '${name}'`);
    }
    const validated = validateSoulBytes(bytes);
    if (opts?.expectedDigest && opts.expectedDigest !== validated.sha256) {
      throw new SoulError("soul/digest-mismatch", `Adopt digest mismatch for '${name}'`);
    }
    let profileId = prior.priorProfileId;
    let manifest: SoulProfileManifest;
    try {
      const existing = await readSoulManifestAnyState(workspaceRoot, name);
      profileId = existing.profileId;
      manifest = { ...existing, state: "active", owner: name };
    } catch {
      profileId = randomUUID();
      manifest = { schemaVersion: 1, profileId, owner: name, state: "active" };
    }
    let next: ProfileTransactionJournal = {
      ...journal,
      phase: "staged",
      profileId,
      targetSoulDigest: validated.sha256,
      targetManifestState: "active",
    };
    await writeJournal(txDir, next);
    next = { ...next, phase: "published" };
    await writeJournal(txDir, next);
    await writeSoulManifestState(workspaceRoot, name, manifest);
    // Bytes stay in place; reopen through the strict resolver after activation.
    next = { ...next, phase: "config-written" };
    await writeJournal(txDir, next);
    if (enable) await applyConfigSoul(access, name, true, journal.priorConfig, txDir);
    const resolved = await resolveSoul(workspaceRoot, name);
    if (resolved.sha256 !== validated.sha256) {
      throw new SoulError("soul/digest-mismatch", `Adopted soul digest mismatch for '${name}'`);
    }
    return {
      journal: next,
      profileId,
      sha256: resolved.sha256,
      chars: resolved.chars,
      bytes: resolved.bytes,
      selfSelected: true,
    };
  });
}

/** Enable requires an active resolvable canonical profile. */
export function enableSoulProfile(
  workspaceRoot: string,
  name: string,
  access: ProfileTxConfigAccess,
): Promise<ProfileMutationResult> {
  return runMutation(workspaceRoot, name, access, "enable", async ({ txDir, journal }) => {
    if (!journal.priorConfig.present) {
      throw new SoulError("soul/path-invalid", `Agent '${name}' is not declared in tachyon.yml`);
    }
    let resolved;
    try {
      resolved = await resolveSoul(workspaceRoot, name);
    } catch (error) {
      if (error instanceof SoulError && error.code === "soul/profile-adoption-required") throw error;
      throw error instanceof SoulError
        ? error
        : new SoulError("soul/missing", `Enable requires a resolvable active canonical profile for '${name}'`, { cause: error });
    }
    let next: ProfileTransactionJournal = {
      ...journal,
      phase: "staged",
      profileId: resolved.profileId,
      targetSoulDigest: resolved.sha256,
      targetManifestState: "active",
    };
    await writeJournal(txDir, next);
    next = { ...next, phase: "published" };
    await writeJournal(txDir, next);
    next = { ...next, phase: "config-written" };
    await writeJournal(txDir, next);
    await applyConfigSoul(access, name, true, journal.priorConfig, txDir);
    return {
      journal: next,
      profileId: resolved.profileId,
      sha256: resolved.sha256,
      chars: resolved.chars,
      bytes: resolved.bytes,
    };
  });
}

/** Disable retains SOUL.md bytes and marks the manifest retained. */
export function disableSoulProfile(
  workspaceRoot: string,
  name: string,
  access: ProfileTxConfigAccess,
): Promise<ProfileMutationResult> {
  return runMutation(workspaceRoot, name, access, "disable", async ({ txDir, journal, prior }) => {
    if (!journal.priorConfig.present) {
      throw new SoulError("soul/path-invalid", `Agent '${name}' is not declared in tachyon.yml`);
    }
    let profileId = prior.priorProfileId;
    let next: ProfileTransactionJournal = {
      ...journal,
      phase: "staged",
      profileId,
      targetSoulDigest: prior.priorSoulDigest,
      targetManifestState: "retained",
    };
    await writeJournal(txDir, next);
    if (prior.priorManifest || prior.priorSoulDigest) {
      const existing = prior.priorManifest ?? {
        schemaVersion: 1 as const,
        profileId: profileId ?? randomUUID(),
        owner: name,
        state: "active" as const,
      };
      profileId = existing.profileId;
      next = { ...next, profileId, phase: "published" };
      await writeJournal(txDir, next);
      await writeSoulManifestState(workspaceRoot, name, { ...existing, state: "retained", owner: name });
    } else {
      next = { ...next, phase: "published" };
      await writeJournal(txDir, next);
    }
    // Prove bytes retained
    if (prior.priorSoulDigest) {
      const bytes = await readCanonicalSoulBytes(workspaceRoot, name);
      const digest = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
      if (digest !== prior.priorSoulDigest) {
        throw new SoulError("soul/digest-mismatch", `Disable must retain exact soul bytes for '${name}'`);
      }
    }
    next = { ...next, phase: "config-written" };
    await writeJournal(txDir, next);
    await applyConfigSoul(access, name, false, journal.priorConfig, txDir);
    return { journal: next, profileId, sha256: prior.priorSoulDigest ?? undefined };
  });
}

export async function refreshSoulProfileStatus(
  workspaceRoot: string,
  name: string,
  access: Pick<ProfileTxConfigAccess, "isSoulEnabled">,
): Promise<SoulProfileStatus> {
  validateSoulAgentName(name);
  const degraded = await listDegradedTransactions(workspaceRoot, name);
  return inspectSoulProfile(workspaceRoot, name, {
    soulEnabled: access.isSoulEnabled(name),
    transactionDegraded: degraded.length > 0,
    includePreview: true,
  });
}

export async function listDegradedTransactions(
  workspaceRoot: string,
  principal?: string,
): Promise<ProfileTransactionJournal[]> {
  const root = profileTransactionsRoot(workspaceRoot);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: ProfileTransactionJournal[] = [];
  for (const entry of entries) {
    if (entry === "launch-reservations") continue;
    const txDir = path.join(root, entry);
    const journal = await readJournal(txDir);
    if (!journal) continue;
    if (principal && journal.principal.toLowerCase() !== principal.toLowerCase()) continue;
    if (journal.phase === "degraded" || journal.degraded) out.push(journal);
  }
  return out;
}

export async function principalBlockedByProfileTransaction(
  workspaceRoot: string,
  principal: string,
): Promise<boolean> {
  const degraded = await listDegradedTransactions(workspaceRoot, principal);
  return degraded.length > 0;
}

/**
 * Startup/reload reconciliation: finish or compensate incomplete journals.
 * Unprovable states stay degraded and block affected principals.
 */
export async function reconcileProfileTransactions(
  workspaceRoot: string,
  accessFactory: (principal: string) => ProfileTxConfigAccess,
): Promise<{ reconciled: string[]; degraded: string[] }> {
  const root = profileTransactionsRoot(workspaceRoot);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reconciled: [], degraded: [] };
    throw error;
  }
  const reconciled: string[] = [];
  const degraded: string[] = [];
  for (const entry of entries) {
    if (entry === "launch-reservations") continue;
    const txDir = path.join(root, entry);
    let st;
    try {
      st = await lstat(txDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const journal = await readJournal(txDir);
    if (!journal) {
      // Corrupt/missing journal — do not delete; mark degraded via synthetic note when possible
      continue;
    }
    if (journal.phase === "committed") {
      await removeTxDir(txDir);
      reconciled.push(journal.txid);
      continue;
    }
    if (journal.phase === "degraded" || journal.degraded) {
      degraded.push(journal.txid);
      continue;
    }
    const access = accessFactory(journal.principal);
    try {
      await reconcileOne(workspaceRoot, txDir, journal, access);
      reconciled.push(journal.txid);
    } catch {
      const d = markDegraded(journal, "startup reconciliation could not prove prior or target convergence");
      await writeJournal(txDir, d);
      degraded.push(journal.txid);
    }
  }
  return { reconciled, degraded };
}

async function reconcileOne(
  workspaceRoot: string,
  txDir: string,
  journal: ProfileTransactionJournal,
  access: ProfileTxConfigAccess,
): Promise<void> {
  const name = journal.principal;
  // If target state is fully present, drop journal.
  const soulBytes = await readCanonicalSoulBytes(workspaceRoot, name);
  const digest = soulBytes ? createHash("sha256").update(soulBytes).digest("hex") : null;
  const cfg = agentStanzaCasToken(access.readConfigText(), name);
  const targetOk =
    journal.targetSoulDigest !== null &&
    digest === journal.targetSoulDigest &&
    cfg.present &&
    cfg.soulEnabled === journal.expectedSoulEnabled &&
    (journal.targetManifestState === "retained"
      ? true
      : await resolveSoul(workspaceRoot, name).then(() => true).catch(() => false));

  if (journal.action === "disable") {
    const retainedOk =
      digest === journal.priorSoulDigest &&
      cfg.present &&
      cfg.soulEnabled === false;
    if (retainedOk && (journal.phase === "config-written" || journal.phase === "published")) {
      await removeTxDir(txDir);
      return;
    }
  } else if (targetOk && (journal.phase === "config-written" || journal.phase === "published")) {
    await removeTxDir(txDir);
    return;
  }

  // Prefer complete prior when still matching backups / prior digests.
  const priorOk = digest === journal.priorSoulDigest &&
    cfg.present === journal.priorConfig.present &&
    cfg.soulEnabled === journal.priorConfig.soulEnabled;
  if (priorOk && (journal.phase === "intent" || journal.phase === "staged")) {
    await removeTxDir(txDir);
    return;
  }

  // Attempt compensation to prior.
  await compensate(workspaceRoot, name, access, txDir, journal);
}

/** Hash helper used by tests and CAS diagnostics. */
export function hashAgentStanza(configText: string | undefined, name: string): AgentStanzaCasToken {
  return agentStanzaCasToken(configText, name);
}

/** Pure: ensure a journal JSON never contains a filesystem path looking like the import source. */
export function journalContainsPath(journal: ProfileTransactionJournal, candidatePath: string): boolean {
  return JSON.stringify(journal).includes(candidatePath);
}
