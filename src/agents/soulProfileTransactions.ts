/**
 * spec 377 T15A — durable, affected-stanza-only canonical soul profile transactions.
 */

import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
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
  readCanonicalSoulManifestBytes,
  readSoulManifestAnyState,
  readValidatedSoulSourceBytes,
  resolveSoul,
  tryWithSoulProfileAdmission,
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
type ManifestTupleState = "active" | "retained" | "missing" | "unowned";

export interface ProfileTransactionJournal {
  schemaVersion: typeof PROFILE_TX_SCHEMA_VERSION;
  txid: string;
  action: ProfileTransactionAction;
  /** `*` is reserved for a synthetic fail-closed record whose corrupt source did not prove identity. */
  principal: string;
  phase: ProfileTransactionPhase;
  profileId?: string;
  priorProfileId?: string;
  targetProfileId?: string;
  priorSoulDigest: string | null;
  targetSoulDigest: string | null;
  priorManifestDigest: string | null;
  targetManifestDigest: string | null;
  priorManifestState: ManifestTupleState;
  targetManifestState: ManifestTupleState;
  priorConfig: AgentStanzaCasToken;
  targetConfig: AgentStanzaCasToken;
  expectedSoulEnabled: boolean;
  createdAt: string;
  degraded?: boolean;
  degradedCode?: "profile-transaction-degraded";
  degradedReason?: string;
  /** Import source paths are deliberately absent. */
}

export interface ProfileMutationResult {
  action: ProfileTransactionAction;
  profileId?: string;
  sha256?: string;
  chars?: number;
  bytes?: number;
  status: SoulProfileStatus;
  selfSelected?: boolean;
}

export interface ProfileTxConfigAccess {
  configPath: string;
  readConfigText(): string | undefined;
  writeConfigText(text: string): string;
  isSoulEnabled(name: string): boolean;
}

interface CapturedProfile {
  priorManifestState: ManifestTupleState;
  priorSoulDigest: string | null;
  priorManifestDigest: string | null;
  priorProfileId?: string;
  priorManifest?: SoulProfileManifest;
}

interface CurrentTuple {
  config: AgentStanzaCasToken;
  soulDigest: string | null;
  manifestDigest: string | null;
  manifestState: ManifestTupleState;
  profileId?: string;
}

const ACTIONS = new Set<ProfileTransactionAction>(["create", "import", "adopt", "enable", "disable"]);
const PHASES = new Set<ProfileTransactionPhase>(["intent", "staged", "published", "config-written", "committed", "compensating", "degraded"]);
const DIGEST_RE = /^[0-9a-f]{64}$/;
const PROFILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function profileTransactionsRoot(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), PROFILE_TRANSACTIONS_REL);
}

function journalPath(txDir: string): string { return path.join(txDir, "journal.json"); }
function backupSoulPath(txDir: string): string { return path.join(txDir, "backup-SOUL.md"); }
function backupManifestPath(txDir: string): string { return path.join(txDir, "backup-profile.json"); }
function stagedSoulPath(txDir: string): string { return path.join(txDir, "staged-SOUL.md"); }
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function manifestBytes(manifest: SoulProfileManifest): Buffer { return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"); }
function tokenEquals(a: AgentStanzaCasToken, b: AgentStanzaCasToken): boolean {
  return a.present === b.present && a.soulEnabled === b.soulEnabled && a.hash === b.hash;
}
function digestValid(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && DIGEST_RE.test(value));
}
function tokenValid(value: unknown): value is AgentStanzaCasToken {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<AgentStanzaCasToken>;
  return typeof token.present === "boolean" && typeof token.soulEnabled === "boolean"
    && (token.hash === null || (typeof token.hash === "string" && DIGEST_RE.test(token.hash)));
}
function manifestStateValid(value: unknown): value is ManifestTupleState {
  return value === "active" || value === "retained" || value === "missing" || value === "unowned";
}
function optionalProfileIdValid(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && PROFILE_ID_RE.test(value));
}

async function syncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensureTxRoot(workspaceRoot: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  const rootReal = await realpath(root);
  const components = [path.join(root, ".tachyon"), profileTransactionsRoot(root)];
  for (const component of components) {
    try { await mkdir(component, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await lstat(component);
    const expected = path.join(rootReal, path.relative(root, component));
    const relative = path.relative(rootReal, expected);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(component) !== expected
      || relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new SoulError("soul/outside-workspace", `Profile transaction parent escapes workspace: ${component}`);
    }
  }
  return components[1]!;
}

async function readTxRoot(workspaceRoot: string): Promise<string | undefined> {
  const root = profileTransactionsRoot(workspaceRoot);
  try {
    const workspaceReal = await realpath(path.resolve(workspaceRoot));
    const stat = await lstat(root);
    const expected = path.join(workspaceReal, PROFILE_TRANSACTIONS_REL);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(root) !== expected) {
      throw new SoulError("soul/profile-transaction-degraded", "Profile transaction root is unsafe");
    }
    return root;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertTxDir(root: string, entry: string): Promise<string> {
  const txDir = path.join(root, entry);
  const stat = await lstat(txDir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(txDir) !== txDir) {
    throw new SoulError("soul/profile-transaction-degraded", `Profile transaction '${entry}' has an unsafe directory`);
  }
  return txDir;
}

async function writeJournal(txDir: string, journal: ProfileTransactionJournal): Promise<void> {
  const file = journalPath(txDir);
  const tmp = `${file}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, file);
    await syncDirectory(txDir);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

function validateJournal(value: unknown, expectedTxid: string): ProfileTransactionJournal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const journal = value as Partial<ProfileTransactionJournal>;
  if (journal.schemaVersion !== PROFILE_TX_SCHEMA_VERSION || journal.txid !== expectedTxid
    || !ACTIONS.has(journal.action as ProfileTransactionAction) || !PHASES.has(journal.phase as ProfileTransactionPhase)
    || typeof journal.principal !== "string" || (journal.principal !== "*" && (() => { try { validateSoulAgentName(journal.principal!); return false; } catch { return true; } })())
    || (journal.principal === "*" && journal.phase !== "degraded")
    || !digestValid(journal.priorSoulDigest) || !digestValid(journal.targetSoulDigest)
    || !digestValid(journal.priorManifestDigest) || !digestValid(journal.targetManifestDigest)
    || !manifestStateValid(journal.priorManifestState) || !manifestStateValid(journal.targetManifestState)
    || !optionalProfileIdValid(journal.profileId) || !optionalProfileIdValid(journal.priorProfileId) || !optionalProfileIdValid(journal.targetProfileId)
    || ((journal.priorManifestState === "active" || journal.priorManifestState === "retained") && (journal.priorManifestDigest === null || journal.priorProfileId === undefined))
    || ((journal.targetManifestState === "active" || journal.targetManifestState === "retained") && (journal.targetManifestDigest === null || journal.targetProfileId === undefined))
    || (journal.priorManifestState === "missing" && (journal.priorManifestDigest !== null || journal.priorProfileId !== undefined))
    || (journal.targetManifestState === "missing" && (journal.targetManifestDigest !== null || journal.targetProfileId !== undefined))
    || (journal.priorManifestState === "unowned" && journal.priorProfileId !== undefined)
    || (journal.targetManifestState === "unowned" && journal.targetProfileId !== undefined)
    || !tokenValid(journal.priorConfig) || !tokenValid(journal.targetConfig)
    || typeof journal.expectedSoulEnabled !== "boolean" || typeof journal.createdAt !== "string") return undefined;
  return journal as ProfileTransactionJournal;
}

async function readJournal(txDir: string, expectedTxid = path.basename(txDir)): Promise<{ ok: true; journal: ProfileTransactionJournal } | { ok: false; reason: string }> {
  const file = journalPath(txDir);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) return { ok: false, reason: "journal is not a bounded regular file" };
    handle = await open(file, fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0)));
    const parsed = JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
    const journal = validateJournal(parsed, expectedTxid);
    return journal ? { ok: true, journal } : { ok: false, reason: "journal schema or identity is invalid" };
  } catch (error) {
    return { ok: false, reason: (error as Error).message || "journal is unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function syntheticDegraded(txid: string, reason: string): ProfileTransactionJournal {
  const absent: AgentStanzaCasToken = { present: false, soulEnabled: false, hash: null };
  return {
    schemaVersion: PROFILE_TX_SCHEMA_VERSION,
    txid,
    action: "create",
    principal: "*",
    phase: "degraded",
    priorSoulDigest: null,
    targetSoulDigest: null,
    priorManifestDigest: null,
    targetManifestDigest: null,
    priorManifestState: "missing",
    targetManifestState: "missing",
    priorConfig: absent,
    targetConfig: absent,
    expectedSoulEnabled: false,
    createdAt: new Date().toISOString(),
    degraded: true,
    degradedCode: "profile-transaction-degraded",
    degradedReason: reason,
  };
}

function markDegraded(journal: ProfileTransactionJournal, reason: string): ProfileTransactionJournal {
  return { ...journal, phase: "degraded", degraded: true, degradedCode: "profile-transaction-degraded", degradedReason: reason };
}

async function durableWriteNew(file: string, bytes: Buffer): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await syncDirectory(path.dirname(file));
}

async function atomicReplacePrivate(file: string, bytes: Buffer): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await durableWriteNew(tmp, bytes);
    await rename(tmp, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

async function durableUnlink(file: string): Promise<void> {
  try { await unlink(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await syncDirectory(path.dirname(file));
}

async function removeTxDir(txDir: string): Promise<void> {
  const root = path.dirname(txDir);
  await rm(txDir, { recursive: true, force: true });
  await syncDirectory(root);
}

async function capturePriorProfile(workspaceRoot: string, name: string, txDir: string): Promise<CapturedProfile> {
  const soul = await readCanonicalSoulBytes(workspaceRoot, name);
  const manifest = await readCanonicalSoulManifestBytes(workspaceRoot, name);
  if (soul) await durableWriteNew(backupSoulPath(txDir), soul);
  if (manifest) await durableWriteNew(backupManifestPath(txDir), manifest);
  let priorManifestState: ManifestTupleState = manifest ? "unowned" : soul ? "unowned" : "missing";
  let priorProfileId: string | undefined;
  let priorManifest: SoulProfileManifest | undefined;
  if (manifest) {
    try {
      priorManifest = await readSoulManifestAnyState(workspaceRoot, name);
      priorManifestState = priorManifest.state;
      priorProfileId = priorManifest.profileId;
    } catch (error) {
      if (!(error instanceof SoulError) || error.code !== "soul/profile-adoption-required") throw error;
    }
  }
  return {
    priorManifestState,
    priorSoulDigest: soul ? digest(soul) : null,
    priorManifestDigest: manifest ? digest(manifest) : null,
    priorProfileId,
    priorManifest,
  };
}

function desiredConfigToken(text: string | undefined, name: string, enabled: boolean, prior: AgentStanzaCasToken): AgentStanzaCasToken {
  if (!prior.present) return prior;
  return agentStanzaCasToken(setAgentSoulEnablement(text, name, enabled).text, name);
}

async function beginJournal(
  workspaceRoot: string,
  name: string,
  action: ProfileTransactionAction,
  access: ProfileTxConfigAccess,
  expectedSoulEnabled: boolean,
): Promise<{ txDir: string; journal: ProfileTransactionJournal; prior: CapturedProfile }> {
  validateSoulAgentName(name);
  await assertNoActiveLaunchReservation(workspaceRoot, name);
  if ((await listDegradedTransactions(workspaceRoot, name)).length > 0) {
    throw new SoulError("soul/profile-transaction-degraded", `Soul profile for '${name}' has a blocking profile transaction journal`);
  }
  const collision = await findFoldedProfileCollision(workspaceRoot, name);
  if (collision && collision.owner !== name) {
    throw new SoulError("soul/profile-collision", `Soul profile name '${name}' collides with existing profile owner '${collision.owner}' (profileId ${collision.profileId})`);
  }
  const root = await ensureTxRoot(workspaceRoot);
  const txid = randomUUID();
  const txDir = path.join(root, txid);
  await mkdir(txDir, { mode: 0o700 });
  await syncDirectory(root);
  const configText = access.readConfigText();
  const priorConfig = agentStanzaCasToken(configText, name);
  const prior = await capturePriorProfile(workspaceRoot, name, txDir);
  const journal: ProfileTransactionJournal = {
    schemaVersion: PROFILE_TX_SCHEMA_VERSION,
    txid,
    action,
    principal: name,
    phase: "intent",
    profileId: prior.priorProfileId,
    priorProfileId: prior.priorProfileId,
    targetProfileId: prior.priorProfileId,
    priorSoulDigest: prior.priorSoulDigest,
    targetSoulDigest: prior.priorSoulDigest,
    priorManifestDigest: prior.priorManifestDigest,
    targetManifestDigest: prior.priorManifestDigest,
    priorManifestState: prior.priorManifestState,
    targetManifestState: prior.priorManifestState,
    priorConfig,
    targetConfig: desiredConfigToken(configText, name, expectedSoulEnabled, priorConfig),
    expectedSoulEnabled,
    createdAt: new Date().toISOString(),
  };
  await writeJournal(txDir, journal);
  return { txDir, journal, prior };
}

async function transition(
  txDir: string,
  journal: ProfileTransactionJournal,
  patch: Partial<ProfileTransactionJournal>,
): Promise<ProfileTransactionJournal> {
  const next = { ...journal, ...patch };
  await writeJournal(txDir, next);
  return next;
}

async function applyConfigSoul(access: ProfileTxConfigAccess, name: string, journal: ProfileTransactionJournal): Promise<void> {
  const existing = access.readConfigText();
  const current = agentStanzaCasToken(existing, name);
  if (!tokenEquals(current, journal.priorConfig)) {
    throw new SoulError("soul/profile-transaction-degraded", `Affected agent stanza for '${name}' changed during the profile transaction (CAS mismatch)`);
  }
  const { text } = setAgentSoulEnablement(existing, name, journal.expectedSoulEnabled);
  const intended = agentStanzaCasToken(text, name);
  if (!tokenEquals(intended, journal.targetConfig)) throw new Error("journaled target config token does not match intended affected stanza");
  access.writeConfigText(text);
  const after = agentStanzaCasToken(access.readConfigText(), name);
  if (!tokenEquals(after, journal.targetConfig)) {
    throw new SoulError("soul/profile-transaction-degraded", `Config write for '${name}' did not preserve the journaled target stanza`);
  }
}

async function readCurrentTuple(workspaceRoot: string, name: string, access: ProfileTxConfigAccess): Promise<CurrentTuple> {
  const soul = await readCanonicalSoulBytes(workspaceRoot, name);
  const manifest = await readCanonicalSoulManifestBytes(workspaceRoot, name);
  let manifestState: ManifestTupleState = manifest ? "unowned" : soul ? "unowned" : "missing";
  let profileId: string | undefined;
  if (manifest) {
    try {
      const parsed = await readSoulManifestAnyState(workspaceRoot, name);
      manifestState = parsed.state;
      profileId = parsed.profileId;
    } catch (error) {
      if (!(error instanceof SoulError) || error.code !== "soul/profile-adoption-required") throw error;
    }
  }
  return {
    config: agentStanzaCasToken(access.readConfigText(), name),
    soulDigest: soul ? digest(soul) : null,
    manifestDigest: manifest ? digest(manifest) : null,
    manifestState,
    profileId,
  };
}

function tupleMatches(journal: ProfileTransactionJournal, tuple: CurrentTuple, which: "prior" | "target"): boolean {
  const config = which === "prior" ? journal.priorConfig : journal.targetConfig;
  const soulDigest = which === "prior" ? journal.priorSoulDigest : journal.targetSoulDigest;
  const manifestDigest = which === "prior" ? journal.priorManifestDigest : journal.targetManifestDigest;
  const manifestState = which === "prior" ? journal.priorManifestState : journal.targetManifestState;
  const profileId = which === "prior" ? journal.priorProfileId : journal.targetProfileId;
  return tokenEquals(config, tuple.config) && soulDigest === tuple.soulDigest && manifestDigest === tuple.manifestDigest
    && manifestState === tuple.manifestState && profileId === tuple.profileId;
}

async function restoreFileComponent(
  currentDigest: string | null,
  priorDigest: string | null,
  targetDigest: string | null,
  destination: string,
  backup: string,
  label: string,
): Promise<void> {
  if (currentDigest === priorDigest) return;
  if (currentDigest !== targetDigest) throw new Error(`${label} changed outside the transaction`);
  if (priorDigest === null) {
    await durableUnlink(destination);
    return;
  }
  const bytes = await readFile(backup);
  if (digest(bytes) !== priorDigest) throw new Error(`${label} backup digest does not match journaled prior`);
  await atomicReplacePrivate(destination, bytes);
}

async function compensate(
  workspaceRoot: string,
  name: string,
  access: ProfileTxConfigAccess,
  txDir: string,
  journal: ProfileTransactionJournal,
): Promise<void> {
  let currentJournal = await transition(txDir, journal, { phase: "compensating" });
  try {
    let tuple = await readCurrentTuple(workspaceRoot, name, access);
    await restoreFileComponent(tuple.soulDigest, currentJournal.priorSoulDigest, currentJournal.targetSoulDigest, agentSoulPath(workspaceRoot, name), backupSoulPath(txDir), "SOUL.md");
    tuple = await readCurrentTuple(workspaceRoot, name, access);
    await restoreFileComponent(tuple.manifestDigest, currentJournal.priorManifestDigest, currentJournal.targetManifestDigest, agentSoulManifestPath(workspaceRoot, name), backupManifestPath(txDir), "profile manifest");
    tuple = await readCurrentTuple(workspaceRoot, name, access);
    if (!tokenEquals(tuple.config, currentJournal.priorConfig)) {
      if (!tokenEquals(tuple.config, currentJournal.targetConfig)) throw new Error("affected config stanza changed outside the transaction");
      if (!currentJournal.priorConfig.present) throw new Error("cannot remove a transaction-created agent stanza");
      const currentText = access.readConfigText();
      const restoredText = setAgentSoulEnablement(currentText, name, currentJournal.priorConfig.soulEnabled).text;
      if (!tokenEquals(agentStanzaCasToken(restoredText, name), currentJournal.priorConfig)) {
        throw new Error("affected config stanza cannot be restored without overwriting unrelated state");
      }
      access.writeConfigText(restoredText);
    }
    tuple = await readCurrentTuple(workspaceRoot, name, access);
    if (!tupleMatches(currentJournal, tuple, "prior")) throw new Error("complete prior tuple did not converge after compensation");
    await removeTxDir(txDir);
  } catch (error) {
    currentJournal = markDegraded(currentJournal, error instanceof Error ? error.message : String(error));
    await writeJournal(txDir, currentJournal).catch(() => undefined);
    throw new SoulError("soul/profile-transaction-degraded", `Profile transaction for '${name}' is degraded and blocks further mutations`, { cause: error });
  }
}

async function commitSuccess(
  workspaceRoot: string,
  name: string,
  access: ProfileTxConfigAccess,
  txDir: string,
  journal: ProfileTransactionJournal,
  resultMeta: { profileId?: string; sha256?: string; chars?: number; bytes?: number; selfSelected?: boolean },
): Promise<ProfileMutationResult> {
  const tuple = await readCurrentTuple(workspaceRoot, name, access);
  if (!tupleMatches(journal, tuple, "target")) {
    const degraded = markDegraded(journal, "complete target tuple did not converge before commit");
    await writeJournal(txDir, degraded);
    throw new SoulError("soul/profile-transaction-degraded", `Profile transaction for '${name}' could not prove its complete target tuple`);
  }
  const committed = await transition(txDir, journal, { phase: "committed", profileId: resultMeta.profileId ?? journal.targetProfileId });
  await removeTxDir(txDir);
  const status = await inspectSoulProfile(workspaceRoot, name, { soulEnabled: access.isSoulEnabled(name), transactionDegraded: false, includePreview: true });
  return {
    action: committed.action,
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
  body: (ctx: { txDir: string; journal: ProfileTransactionJournal; prior: CapturedProfile }) => Promise<{ journal: ProfileTransactionJournal; profileId?: string; sha256?: string; chars?: number; bytes?: number; selfSelected?: boolean }>,
  expectedSoulEnabled = action !== "disable",
): Promise<ProfileMutationResult> {
  return withSoulProfileAdmission(workspaceRoot, name, async () => {
    const { txDir, journal: started, prior } = await beginJournal(workspaceRoot, name, action, access, expectedSoulEnabled);
    try {
      const out = await body({ txDir, journal: started, prior });
      return await commitSuccess(workspaceRoot, name, access, txDir, out.journal, out);
    } catch (error) {
      const reread = await readJournal(txDir);
      if (!reread.ok) {
        const synthetic = syntheticDegraded(path.basename(txDir), `mutation failed with unreadable journal: ${reread.reason}`);
        await writeJournal(txDir, synthetic).catch(() => undefined);
        throw new SoulError("soul/profile-transaction-degraded", `Profile transaction for '${name}' lost its durable journal`, { cause: error });
      }
      if (reread.journal.phase === "committed") throw error;
      try {
        await compensate(workspaceRoot, name, access, txDir, reread.journal);
      } catch (compensationError) {
        throw compensationError;
      }
      throw error instanceof SoulError ? error : new SoulError("soul/io-error", error instanceof Error ? error.message : String(error), { cause: error });
    }
  });
}

export function createSoulProfile(workspaceRoot: string, name: string, access: ProfileTxConfigAccess): Promise<ProfileMutationResult> {
  return runMutation(workspaceRoot, name, access, "create", async ({ txDir, journal, prior }) => {
    if (prior.priorManifestState !== "missing" || prior.priorSoulDigest !== null) {
      throw new SoulError("soul/profile-adoption-required", `Canonical profile data already exists for '${name}'; use Adopt/Open rather than silent overwrite`);
    }
    if (!journal.priorConfig.present) throw new SoulError("soul/path-invalid", `Agent '${name}' is not declared in tachyon.yml`);
    const bytes = Buffer.from(SOUL_MINIMAL_TEMPLATE, "utf8");
    const validated = validateSoulBytes(bytes);
    const profileId = randomUUID();
    const manifest: SoulProfileManifest = { schemaVersion: 1, profileId, owner: name, state: "active" };
    const serializedManifest = manifestBytes(manifest);
    let next = await transition(txDir, journal, {
      phase: "staged",
      profileId,
      targetProfileId: profileId,
      targetSoulDigest: validated.sha256,
      targetManifestDigest: digest(serializedManifest),
      targetManifestState: "active",
    });
    await durableWriteNew(stagedSoulPath(txDir), bytes);
    const published = await publishCanonicalSoulFiles(workspaceRoot, name, bytes, manifest);
    next = await transition(txDir, next, { phase: "published" });
    await applyConfigSoul(access, name, next);
    next = await transition(txDir, next, { phase: "config-written" });
    const resolved = await resolveSoul(workspaceRoot, name);
    if (resolved.sha256 !== validated.sha256 || resolved.profileId !== profileId) throw new SoulError("soul/digest-mismatch", `Published soul tuple mismatch for '${name}'`);
    return { journal: next, profileId, sha256: published.sha256, chars: published.chars, bytes: published.bytes };
  });
}

function importSoulProfileBytesProviderTransaction(
  workspaceRoot: string,
  name: string,
  provideBytes: () => Promise<Buffer>,
  access: ProfileTxConfigAccess,
): Promise<ProfileMutationResult> {
  return runMutation(workspaceRoot, name, access, "import", async ({ txDir, journal, prior }) => {
    if (prior.priorManifestState !== "missing" || prior.priorSoulDigest !== null) {
      throw new SoulError("soul/profile-adoption-required", `Canonical profile already exists for '${name}'; explicit adoption or replace is required`);
    }
    if (!journal.priorConfig.present) throw new SoulError("soul/path-invalid", `Agent '${name}' is not declared in tachyon.yml`);
    const bytes = await provideBytes();
    const validated = validateSoulBytes(bytes);
    const profileId = randomUUID();
    const manifest: SoulProfileManifest = { schemaVersion: 1, profileId, owner: name, state: "active" };
    const serializedManifest = manifestBytes(manifest);
    let next = await transition(txDir, journal, {
      phase: "staged",
      profileId,
      targetProfileId: profileId,
      targetSoulDigest: validated.sha256,
      targetManifestDigest: digest(serializedManifest),
      targetManifestState: "active",
    });
    await durableWriteNew(stagedSoulPath(txDir), bytes);
    const published = await publishCanonicalSoulFiles(workspaceRoot, name, bytes, manifest);
    next = await transition(txDir, next, { phase: "published" });
    await applyConfigSoul(access, name, next);
    next = await transition(txDir, next, { phase: "config-written" });
    const resolved = await resolveSoul(workspaceRoot, name);
    if (resolved.sha256 !== validated.sha256 || resolved.profileId !== profileId) throw new SoulError("soul/digest-mismatch", `Imported soul tuple mismatch for '${name}'`);
    return { journal: next, profileId, sha256: published.sha256, chars: published.chars, bytes: published.bytes };
  });
}

export async function importSoulProfileTransaction(
  workspaceRoot: string,
  name: string,
  importSource: string,
  access: ProfileTxConfigAccess,
): Promise<ProfileMutationResult> {
  if (isCanonicalSoulPath(workspaceRoot, name, importSource)) {
    const snapshot = await readCanonicalSoulBytes(workspaceRoot, name);
    if (!snapshot) throw new SoulError("soul/missing", `No canonical soul bytes to adopt for '${name}'`);
    return adoptSoulProfile(workspaceRoot, name, access, { expectedDigest: digest(snapshot), enable: true });
  }
  return importSoulProfileBytesProviderTransaction(workspaceRoot, name, () => readValidatedSoulSourceBytes(importSource), access);
}

/** Journaled import for bytes already selected inside a webview; no source path exists or is persisted. */
export function importSoulProfileBytesTransaction(
  workspaceRoot: string,
  name: string,
  bytes: Buffer,
  access: ProfileTxConfigAccess,
): Promise<ProfileMutationResult> {
  const snapshot = Buffer.from(bytes);
  return importSoulProfileBytesProviderTransaction(workspaceRoot, name, async () => snapshot, access);
}

export function adoptSoulProfile(
  workspaceRoot: string,
  name: string,
  access: ProfileTxConfigAccess,
  opts: { expectedDigest: string; enable?: boolean },
): Promise<ProfileMutationResult> {
  if (!DIGEST_RE.test(opts?.expectedDigest ?? "")) {
    return Promise.reject(new SoulError("soul/digest-mismatch", `Adopt requires a valid expected soul digest for '${name}'`));
  }
  const enable = opts.enable !== false;
  return runMutation(workspaceRoot, name, access, "adopt", async ({ txDir, journal, prior }) => {
    if (!journal.priorConfig.present) throw new SoulError("soul/path-invalid", `Agent '${name}' is not declared in tachyon.yml`);
    const bytes = await readCanonicalSoulBytes(workspaceRoot, name);
    if (!bytes) throw new SoulError("soul/missing", `No canonical soul bytes to adopt for '${name}'`);
    const validated = validateSoulBytes(bytes);
    if (opts.expectedDigest !== validated.sha256) throw new SoulError("soul/digest-mismatch", `Adopt digest mismatch for '${name}'`);
    const profileId = prior.priorManifest?.profileId ?? randomUUID();
    const manifest: SoulProfileManifest = { schemaVersion: 1, profileId, owner: name, state: "active" };
    const serializedManifest = manifestBytes(manifest);
    let next = await transition(txDir, journal, {
      phase: "staged",
      profileId,
      targetProfileId: profileId,
      targetSoulDigest: validated.sha256,
      targetManifestDigest: digest(serializedManifest),
      targetManifestState: "active",
    });
    await writeSoulManifestState(workspaceRoot, name, manifest, { expectedDigest: prior.priorManifestDigest });
    next = await transition(txDir, next, { phase: "published" });
    if (enable) await applyConfigSoul(access, name, next);
    next = await transition(txDir, next, { phase: "config-written" });
    const resolved = await resolveSoul(workspaceRoot, name);
    if (resolved.sha256 !== validated.sha256 || resolved.profileId !== profileId) throw new SoulError("soul/digest-mismatch", `Adopted soul tuple mismatch for '${name}'`);
    return { journal: next, profileId, sha256: resolved.sha256, chars: resolved.chars, bytes: resolved.bytes, selfSelected: true };
  }, enable);
}

export function enableSoulProfile(workspaceRoot: string, name: string, access: ProfileTxConfigAccess): Promise<ProfileMutationResult> {
  return runMutation(workspaceRoot, name, access, "enable", async ({ txDir, journal }) => {
    if (!journal.priorConfig.present) throw new SoulError("soul/path-invalid", `Agent '${name}' is not declared in tachyon.yml`);
    const resolved = await resolveSoul(workspaceRoot, name);
    let next = await transition(txDir, journal, {
      phase: "staged",
      profileId: resolved.profileId,
      targetProfileId: resolved.profileId,
      targetSoulDigest: resolved.sha256,
      targetManifestState: "active",
    });
    next = await transition(txDir, next, { phase: "published" });
    await applyConfigSoul(access, name, next);
    next = await transition(txDir, next, { phase: "config-written" });
    return { journal: next, profileId: resolved.profileId, sha256: resolved.sha256, chars: resolved.chars, bytes: resolved.bytes };
  });
}

export function disableSoulProfile(workspaceRoot: string, name: string, access: ProfileTxConfigAccess): Promise<ProfileMutationResult> {
  return runMutation(workspaceRoot, name, access, "disable", async ({ txDir, journal, prior }) => {
    if (!journal.priorConfig.present) throw new SoulError("soul/path-invalid", `Agent '${name}' is not declared in tachyon.yml`);
    let profileId = prior.priorProfileId;
    let targetManifestState = prior.priorManifestState;
    let targetManifestDigest = prior.priorManifestDigest;
    let manifest: SoulProfileManifest | undefined;
    if (prior.priorManifest || prior.priorSoulDigest) {
      profileId = prior.priorManifest?.profileId ?? randomUUID();
      manifest = { schemaVersion: 1, profileId, owner: name, state: "retained" };
      targetManifestState = "retained";
      targetManifestDigest = digest(manifestBytes(manifest));
    }
    let next = await transition(txDir, journal, {
      phase: "staged",
      profileId,
      targetProfileId: profileId,
      targetSoulDigest: prior.priorSoulDigest,
      targetManifestDigest,
      targetManifestState,
    });
    if (manifest) await writeSoulManifestState(workspaceRoot, name, manifest, { expectedDigest: prior.priorManifestDigest });
    next = await transition(txDir, next, { phase: "published" });
    await applyConfigSoul(access, name, next);
    next = await transition(txDir, next, { phase: "config-written" });
    return { journal: next, profileId, sha256: prior.priorSoulDigest ?? undefined };
  });
}

export async function refreshSoulProfileStatus(
  workspaceRoot: string,
  name: string,
  access: Pick<ProfileTxConfigAccess, "isSoulEnabled">,
): Promise<SoulProfileStatus> {
  validateSoulAgentName(name);
  const blocking = (await listDegradedTransactions(workspaceRoot, name)).length > 0;
  return inspectSoulProfile(workspaceRoot, name, { soulEnabled: access.isSoulEnabled(name), transactionDegraded: blocking, includePreview: true });
}

export async function listDegradedTransactions(workspaceRoot: string, principal?: string): Promise<ProfileTransactionJournal[]> {
  let root: string | undefined;
  try { root = await readTxRoot(workspaceRoot); }
  catch (error) { return [syntheticDegraded("unsafe-root", error instanceof Error ? error.message : String(error))]; }
  if (!root) return [];
  const out: ProfileTransactionJournal[] = [];
  for (const entry of await readdir(root)) {
    if (entry === "launch-reservations") continue;
    let txDir: string;
    try { txDir = await assertTxDir(root, entry); }
    catch (error) { out.push(syntheticDegraded(entry, error instanceof Error ? error.message : String(error))); continue; }
    const read = await readJournal(txDir, entry);
    const journal = read.ok ? read.journal : syntheticDegraded(entry, read.reason);
    if (!principal || journal.principal === "*" || journal.principal.toLowerCase() === principal.toLowerCase()) out.push(journal);
  }
  return out;
}

export async function principalBlockedByProfileTransaction(workspaceRoot: string, principal: string): Promise<boolean> {
  return (await listDegradedTransactions(workspaceRoot, principal)).length > 0;
}

async function reconcileOne(
  workspaceRoot: string,
  txDir: string,
  journal: ProfileTransactionJournal,
  access: ProfileTxConfigAccess,
): Promise<void> {
  const tuple = await readCurrentTuple(workspaceRoot, journal.principal, access);
  const targetComplete = tupleMatches(journal, tuple, "target");
  const priorComplete = tupleMatches(journal, tuple, "prior");
  if (targetComplete && (journal.phase === "published" || journal.phase === "config-written" || journal.phase === "committed" || journal.phase === "compensating")) {
    await removeTxDir(txDir);
    return;
  }
  if (priorComplete && journal.phase !== "committed") {
    await removeTxDir(txDir);
    return;
  }
  await compensate(workspaceRoot, journal.principal, access, txDir, journal);
}

export async function reconcileProfileTransactions(
  workspaceRoot: string,
  accessFactory: (principal: string) => ProfileTxConfigAccess,
): Promise<{ reconciled: string[]; degraded: string[] }> {
  let root: string | undefined;
  try { root = await readTxRoot(workspaceRoot); }
  catch { return { reconciled: [], degraded: ["unsafe-root"] }; }
  if (!root) return { reconciled: [], degraded: [] };
  const reconciled: string[] = [];
  const degraded: string[] = [];
  for (const entry of await readdir(root)) {
    if (entry === "launch-reservations") continue;
    let txDir: string;
    try { txDir = await assertTxDir(root, entry); }
    catch { degraded.push(entry); continue; }
    const discovered = await readJournal(txDir, entry);
    if (!discovered.ok || discovered.journal.principal === "*") {
      await writeJournal(txDir, syntheticDegraded(entry, discovered.ok ? "journal identity is unknown" : discovered.reason)).catch(() => undefined);
      degraded.push(entry);
      continue;
    }
    const principal = discovered.journal.principal;
    const admitted = await tryWithSoulProfileAdmission(workspaceRoot, principal, async () => {
      const reread = await readJournal(txDir, entry);
      if (!reread.ok || reread.journal.principal !== principal) {
        await writeJournal(txDir, syntheticDegraded(entry, reread.ok ? "journal identity changed during admission" : reread.reason)).catch(() => undefined);
        return "degraded" as const;
      }
      const journal = reread.journal;
      if (journal.phase === "degraded" || journal.degraded) return "degraded" as const;
      try {
        await reconcileOne(workspaceRoot, txDir, journal, accessFactory(principal));
        return "reconciled" as const;
      } catch (error) {
        const latest = await readJournal(txDir, entry);
        if (latest.ok && latest.journal.phase !== "degraded") {
          await writeJournal(txDir, markDegraded(latest.journal, error instanceof Error ? error.message : String(error))).catch(() => undefined);
        }
        return "degraded" as const;
      }
    });
    if (!admitted.acquired) continue;
    if (admitted.value === "reconciled") reconciled.push(entry);
    else degraded.push(entry);
  }
  return { reconciled, degraded };
}

export function hashAgentStanza(configText: string | undefined, name: string): AgentStanzaCasToken {
  return agentStanzaCasToken(configText, name);
}

export function journalContainsPath(journal: ProfileTransactionJournal, candidatePath: string): boolean {
  return JSON.stringify(journal).includes(candidatePath);
}
