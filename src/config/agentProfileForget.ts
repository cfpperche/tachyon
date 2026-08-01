import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentProfileForgetSnapshot } from "../agents/AgentManager.js";
import type { AgentProfileAuthorityRecord } from "./agentProfileAuthority.js";
import { agentProfileAuthorityFor, inspectAgentProfileLifecycle } from "./agentProfileLifecycle.js";
import {
  profileDigest,
  ownershipProfileMutation,
  replaceProfileExact,
} from "./agentProfileOwnership.js";
import {
  acquireAgentProfileRecoveryLocks,
  acquireAgentProfileTransactionLock,
  acquireAgentProfileTransactionLocks,
  agentProfileTransactionsRoot,
  type AgentProfileAuthorityPort,
} from "./agentProfileTransactions.js";
import { canonicalAgentProfilePointer, scanAgentProfilePointers } from "./agentProfilePointer.js";
import { AgentProfileRefusal } from "./agentProfileRefusal.js";
import { assertValidAgentName, asciiFoldAgentName } from "./nameValidation.js";
import { agentStanzaSourceSlice, deleteAgent as deleteAgentInYml } from "./YamlConfigEditor.js";

const SCHEMA_VERSION = 1 as const;
const FORGET_DIR = "forget";
const JOURNAL = "journal.json";
const PHASES = new Set<string>([
  "intent", "committing", "evolution-retired", "authority-retired", "locator-removed",
  "home-quarantined", "runtime-converged", "activated", "committed", "degraded",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AgentProfileForgetPhase =
  | "intent"
  | "committing"
  | "evolution-retired"
  | "authority-retired"
  | "locator-removed"
  | "home-quarantined"
  | "runtime-converged"
  | "activated"
  | "committed"
  | "degraded";

interface TreeEntry {
  path: string;
  kind: "directory" | "file";
  mode: number;
  sha256?: string;
}

export interface AgentProfileForgetJournal {
  schemaVersion: typeof SCHEMA_VERSION;
  txid: string;
  agentName: string;
  agentId: string;
  phase: AgentProfileForgetPhase;
  createdAt: string;
  sourceAuthority: AgentProfileAuthorityRecord;
  sourceConfigSha256: string;
  targetConfigSha256: string;
  sourceStanzaSha256: string;
  profileManifest: TreeEntry[];
  evolutionProfileId: string | null;
  liveSnapshot: AgentProfileForgetSnapshot;
  /**
   * What this transaction deliberately leaves on disk. It is the receipt an audit reads to tell a
   * retained artifact from live residue, so it must stay EXHAUSTIVE: anything neither listed here nor
   * removed by the transaction is unclassifiable, which is the t-33ae3f failure.
   */
  retainedBindings: readonly string[];
  /** Parent-side ownership edge removed in the same transaction as the child forget. */
  ownership?: {
    ownerAgentName: string;
    priorProfileSha256: string;
    targetProfileSha256: string;
    priorAuthority: AgentProfileAuthorityRecord;
    targetAuthority: AgentProfileAuthorityRecord;
  };
  degradedReason?: string;
}

/**
 * t-33ae3f — one list, so the declaration cannot drift from the behaviour. Whatever is added to the
 * retention set belongs here; whatever the transaction removes must NOT.
 */
export const AGENT_PROFILE_FORGET_RETAINED_BINDINGS = [
  "runtime homes",
  "runtime secrets",
  "worktrees",
  "session-owner rows",
  "continuity",
] as const;

export interface AgentProfileForgetConfigPort {
  read(): string;
  replace(expectedSha256: string, text: string): void;
}

export interface AgentProfileForgetEvolutionPort {
  readProfileId(agentName: string): Promise<string | undefined>;
  retire(agentName: string, expectedProfileId: string | null): Promise<void>;
}

export interface CommitAgentProfileForgetInput {
  workspaceRoot: string;
  agentName: string;
  expectedRevision: string;
  /** Current declared owner, when the child is listed in another canonical profile. */
  ownerAgentName?: string;
  authority: AgentProfileAuthorityPort;
  config: AgentProfileForgetConfigPort;
  evolution: AgentProfileForgetEvolutionPort;
  live: {
    prepare(agentName: string): Promise<AgentProfileForgetSnapshot>;
    converge(agentName: string, agentId: string, txid: string, snapshot: AgentProfileForgetSnapshot): Promise<void>;
  };
  activateState: () => void;
  onPhase?: (phase: AgentProfileForgetPhase) => void;
}

export interface AgentProfileForgetResult {
  txid: string;
  agentName: string;
  agentId: string;
}

class CustodyError extends Error {}

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeNew(file: string, bytes: string): void {
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}

function forgetRoot(workspaceRoot: string): string {
  return path.join(agentProfileTransactionsRoot(workspaceRoot), FORGET_DIR);
}

function ensureSafeDirectory(workspaceRoot: string, directory: string): void {
  const workspace = fs.realpathSync.native(path.resolve(workspaceRoot));
  const relative = path.relative(path.resolve(workspaceRoot), directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new CustodyError(`forget path escaped workspace: ${directory}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()
    || fs.realpathSync.native(directory) !== path.join(workspace, relative)) {
    throw new CustodyError(`unsafe canonical forget directory: ${directory}`);
  }
}

function ensureForgetRoot(workspaceRoot: string): string {
  const root = forgetRoot(workspaceRoot);
  ensureSafeDirectory(workspaceRoot, path.dirname(root));
  ensureSafeDirectory(workspaceRoot, root);
  return root;
}

function profileRoot(workspaceRoot: string, agentName: string): string {
  return path.join(path.resolve(workspaceRoot), ".tachyon", "agents", agentName);
}

export function retiredAgentProfileRoot(workspaceRoot: string, agentId: string, txid: string): string {
  return path.join(path.resolve(workspaceRoot), ".tachyon", "retired-agent-profiles", agentId, txid);
}

function treeManifest(root: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const walk = (directory: string, relative: string): void => {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CustodyError(`unsafe profile tree entry: ${relative || "."}`);
    entries.push({ path: relative || ".", kind: "directory", mode: stat.mode & 0o777 });
    for (const name of fs.readdirSync(directory).sort()) {
      const child = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const childStat = fs.lstatSync(child);
      if (childStat.isSymbolicLink()) throw new CustodyError(`profile tree contains symbolic link: ${childRelative}`);
      if (childStat.isDirectory()) walk(child, childRelative);
      else if (childStat.isFile()) entries.push({
        path: childRelative,
        kind: "file",
        mode: childStat.mode & 0o777,
        sha256: digest(fs.readFileSync(child)),
      });
      else throw new CustodyError(`profile tree contains unsupported entry: ${childRelative}`);
    }
  };
  walk(root, "");
  return entries;
}

function sameTree(root: string, expected: readonly TreeEntry[]): boolean {
  try { return isDeepStrictEqual(treeManifest(root), expected); }
  catch { return false; }
}

function writeJournal(txDir: string, journal: AgentProfileForgetJournal): void {
  const file = path.join(txDir, JOURNAL);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    writeNew(temporary, `${JSON.stringify(journal, null, 2)}\n`);
    fs.renameSync(temporary, file);
    syncDirectory(txDir);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
  }
}

function readJournal(txDir: string): AgentProfileForgetJournal {
  const value = JSON.parse(fs.readFileSync(path.join(txDir, JOURNAL), "utf8")) as AgentProfileForgetJournal;
  if (value.schemaVersion !== SCHEMA_VERSION || typeof value.txid !== "string" || typeof value.agentName !== "string"
    || !UUID.test(value.txid) || !UUID.test(value.agentId) || !PHASES.has(value.phase)
    || !Array.isArray(value.profileManifest)) {
    throw new CustodyError("invalid canonical profile forget journal");
  }
  return value;
}

function transition(
  txDir: string,
  journal: AgentProfileForgetJournal,
  phase: AgentProfileForgetPhase,
  onPhase?: (phase: AgentProfileForgetPhase) => void,
): AgentProfileForgetJournal {
  const next = { ...journal, phase };
  writeJournal(txDir, next);
  onPhase?.(phase);
  return next;
}

function plannedConfig(config: AgentProfileForgetConfigPort, agentName: string): {
  sourceSha: string;
  targetSha: string;
  sourceStanzaSha: string;
} {
  const source = config.read();
  const scan = scanAgentProfilePointers(source);
  if (scan.errors.length > 0) throw new Error(scan.errors.join("; "));
  if (scan.pointers.get(agentName)?.path !== canonicalAgentProfilePointer(agentName)) {
    throw new Error(`agent '${agentName}' is not backed by its canonical profile pointer`);
  }
  const stanza = agentStanzaSourceSlice(source, agentName);
  const target = deleteAgentInYml(source, agentName).text;
  return { sourceSha: digest(source), targetSha: digest(target), sourceStanzaSha: stanza.valueSha256 };
}

function configState(config: AgentProfileForgetConfigPort, journal: AgentProfileForgetJournal): "source" | "target" | "conflict" {
  const text = config.read();
  const sha = digest(text);
  if (sha === journal.targetConfigSha256) return "target";
  if (sha !== journal.sourceConfigSha256) return "conflict";
  try {
    const scan = scanAgentProfilePointers(text);
    if (scan.errors.length > 0 || scan.pointers.get(journal.agentName)?.path !== canonicalAgentProfilePointer(journal.agentName)) return "conflict";
    if (agentStanzaSourceSlice(text, journal.agentName).valueSha256 !== journal.sourceStanzaSha256) return "conflict";
    return "source";
  } catch { return "conflict"; }
}

function removeLocator(config: AgentProfileForgetConfigPort, journal: AgentProfileForgetJournal): void {
  const state = configState(config, journal);
  if (state === "target") return;
  if (state !== "source") throw new CustodyError("canonical profile locator changed outside the forget transaction");
  const source = config.read();
  const target = deleteAgentInYml(source, journal.agentName).text;
  if (digest(target) !== journal.targetConfigSha256) throw new CustodyError("canonical profile forget target config changed");
  config.replace(journal.sourceConfigSha256, target);
  if (configState(config, journal) !== "target") throw new Error("canonical profile locator removal did not converge");
}

async function retireAuthority(authority: AgentProfileAuthorityPort, journal: AgentProfileForgetJournal): Promise<void> {
  const current = await authority.read(journal.agentName);
  if (current === undefined) return;
  if (!isDeepStrictEqual(current, journal.sourceAuthority)) {
    throw new CustodyError("canonical profile authority changed outside the forget transaction");
  }
  try { await authority.retire(journal.agentName, journal.sourceAuthority); }
  catch (error) {
    const after = await authority.read(journal.agentName);
    if (after !== undefined) throw error;
  }
  if (await authority.read(journal.agentName) !== undefined) throw new Error("canonical profile authority retirement did not converge");
}

async function convergeOwnership(
  input: Omit<CommitAgentProfileForgetInput, "expectedRevision">,
  journal: AgentProfileForgetJournal,
): Promise<void> {
  const companion = journal.ownership;
  if (!companion) return;
  const currentProfileSha = profileDigest(input.workspaceRoot, companion.ownerAgentName);
  const currentAuthority = await input.authority.read(companion.ownerAgentName);
  const profileState = currentProfileSha === companion.priorProfileSha256
    ? "source"
    : currentProfileSha === companion.targetProfileSha256 ? "target" : "conflict";
  const authorityState = isDeepStrictEqual(currentAuthority, companion.priorAuthority)
    ? "source"
    : isDeepStrictEqual(currentAuthority, companion.targetAuthority) ? "target" : "conflict";
  if (profileState === "conflict" || authorityState === "conflict") {
    throw new CustodyError("ownership profile or authority changed outside the forget transaction");
  }
  if (profileState === "source") {
    const mutation = ownershipProfileMutation(input.workspaceRoot, companion.ownerAgentName, journal.agentName, undefined);
    if (mutation.priorSha256 !== companion.priorProfileSha256 || mutation.targetSha256 !== companion.targetProfileSha256) {
      throw new CustodyError("ownership profile target changed outside the forget transaction");
    }
    replaceProfileExact(input.workspaceRoot, companion.ownerAgentName, companion.priorProfileSha256, mutation.targetText);
  }
  if (authorityState === "source") {
    try {
      await input.authority.replace(companion.targetAuthority, companion.priorAuthority);
    } catch (error) {
      if (!isDeepStrictEqual(await input.authority.read(companion.ownerAgentName), companion.targetAuthority)) throw error;
    }
  }
  if (profileDigest(input.workspaceRoot, companion.ownerAgentName) !== companion.targetProfileSha256
    || !isDeepStrictEqual(await input.authority.read(companion.ownerAgentName), companion.targetAuthority)) {
    throw new Error("ownership forget did not converge");
  }
}

async function retireEvolution(evolution: AgentProfileForgetEvolutionPort, journal: AgentProfileForgetJournal): Promise<void> {
  try {
    await evolution.retire(journal.agentName, journal.evolutionProfileId);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "evolution/authority-invalid" || code === "evolution/profile-conflict") {
      throw new CustodyError(error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

function quarantineHome(workspaceRoot: string, journal: AgentProfileForgetJournal): void {
  const source = profileRoot(workspaceRoot, journal.agentName);
  const destination = retiredAgentProfileRoot(workspaceRoot, journal.agentId, journal.txid);
  if (!exists(source) && sameTree(destination, journal.profileManifest)) return;
  if (!sameTree(source, journal.profileManifest) || exists(destination)) {
    throw new CustodyError("canonical profile home changed outside the forget transaction");
  }
  const parent = path.dirname(destination);
  ensureSafeDirectory(workspaceRoot, parent);
  fs.renameSync(source, destination);
  syncDirectory(path.dirname(source));
  syncDirectory(parent);
  if (exists(source) || !sameTree(destination, journal.profileManifest)) {
    throw new Error("canonical profile quarantine did not converge");
  }
}

async function rollForward(
  input: Omit<CommitAgentProfileForgetInput, "expectedRevision">,
  txDir: string,
  initial: AgentProfileForgetJournal,
): Promise<AgentProfileForgetJournal> {
  let journal = initial;
  if (journal.phase === "committing") {
    await retireEvolution(input.evolution, journal);
    journal = transition(txDir, journal, "evolution-retired", input.onPhase);
  }
  if (journal.phase === "evolution-retired") {
    await retireAuthority(input.authority, journal);
    journal = transition(txDir, journal, "authority-retired", input.onPhase);
  }
  if (journal.phase === "authority-retired") {
    await convergeOwnership(input, journal);
    removeLocator(input.config, journal);
    journal = transition(txDir, journal, "locator-removed", input.onPhase);
  }
  if (journal.phase === "locator-removed") {
    quarantineHome(input.workspaceRoot, journal);
    journal = transition(txDir, journal, "home-quarantined", input.onPhase);
  }
  if (journal.phase === "home-quarantined") {
    await input.live.converge(journal.agentName, journal.agentId, journal.txid, journal.liveSnapshot);
    journal = transition(txDir, journal, "runtime-converged", input.onPhase);
  }
  if (journal.phase === "runtime-converged") {
    input.activateState();
    journal = transition(txDir, journal, "activated", input.onPhase);
  }
  if (journal.phase === "activated") journal = transition(txDir, journal, "committed", input.onPhase);
  return journal;
}

export async function commitAgentProfileForget(input: CommitAgentProfileForgetInput): Promise<AgentProfileForgetResult> {
  assertValidAgentName(input.agentName);
  if (input.ownerAgentName !== undefined) {
    assertValidAgentName(input.ownerAgentName);
    if (input.ownerAgentName === input.agentName) throw new Error("ownership owner must be distinct from the forgotten agent");
  }
  const txid = crypto.randomUUID();
  const release = input.ownerAgentName
    ? acquireAgentProfileTransactionLocks(input.workspaceRoot, [input.agentName, input.ownerAgentName], txid)
    : acquireAgentProfileTransactionLock(input.workspaceRoot, input.agentName, txid);
  let txDir: string | undefined;
  try {
    const snapshot = await inspectAgentProfileLifecycle({
      workspaceRoot: input.workspaceRoot,
      agentName: input.agentName,
      authority: input.authority,
      config: input.config,
    });
    // t-05dff5 — every precondition from here to `input.live.prepare` is an `AgentProfileRefusal`:
    // each one is a decision handed back to the human, not a transaction that broke. They are the
    // ONLY throws in this function that carry a code; the state-changed-under-us guards below and
    // everything inside `rollForward` stay plain errors, because "the profile moved while the intent
    // was installed" is not a gesture anyone can perform — it is a retry the machine owns.
    if (snapshot.revision !== input.expectedRevision) {
      throw new AgentProfileRefusal("agent-profile/revision-conflict", "agent profile revision changed before forget");
    }
    const sourceAuthority = await input.authority.read(input.agentName);
    if (!sourceAuthority || sourceAuthority.agentId !== snapshot.profile.agentId
      || sourceAuthority.canonicalSha256 !== snapshot.provenance.canonical.sha256) {
      throw new AgentProfileRefusal(
        "agent-profile/forget-authority-stale",
        `canonical authority for '${input.agentName}' is missing or stale`,
      );
    }
    const config = plannedConfig(input.config, input.agentName);
    const oldRoot = profileRoot(input.workspaceRoot, input.agentName);
    const profileManifest = treeManifest(oldRoot);
    const evolutionProfileId = await input.evolution.readProfileId(input.agentName);
    const hasEvolutionProfile = profileManifest.some((entry) => entry.path === "evolution/profile.json" && entry.kind === "file");
    if ((evolutionProfileId === undefined) !== !hasEvolutionProfile) {
      // Named rather than flattened even though no Studio button resolves it: the human who reads
      // "evolution storage and the profile tree disagree" knows WHERE to look and that retrying is
      // pointless, which is the whole difference between a refusal and "could not be completed".
      throw new AgentProfileRefusal(
        "agent-profile/forget-evolution-incomplete",
        `agent '${input.agentName}': Agent Evolution profile storage and the canonical profile tree disagree about whether a stored profile exists; canonical forget will not run until they match`,
      );
    }
    let ownership: AgentProfileForgetJournal["ownership"];
    if (input.ownerAgentName) {
      const mutation = ownershipProfileMutation(input.workspaceRoot, input.ownerAgentName, input.agentName, undefined);
      const priorAuthority = await input.authority.read(input.ownerAgentName);
      if (!priorAuthority || priorAuthority.agentId !== mutation.priorProfile.agentId
        || priorAuthority.canonicalSha256 !== mutation.priorSha256) {
        throw new Error(`canonical authority for ownership owner '${input.ownerAgentName}' is missing or stale`);
      }
      ownership = {
        ownerAgentName: input.ownerAgentName,
        priorProfileSha256: mutation.priorSha256,
        targetProfileSha256: mutation.targetSha256,
        priorAuthority,
        targetAuthority: agentProfileAuthorityFor(input.ownerAgentName, mutation.targetProfile, mutation.targetSha256, priorAuthority, txid),
      };
    }
    const liveSnapshot = await input.live.prepare(input.agentName);
    const root = ensureForgetRoot(input.workspaceRoot);
    txDir = path.join(root, txid);
    fs.mkdirSync(txDir, { mode: 0o700 });
    syncDirectory(root);
    let journal: AgentProfileForgetJournal = {
      schemaVersion: SCHEMA_VERSION,
      txid,
      agentName: input.agentName,
      agentId: snapshot.profile.agentId,
      phase: "intent",
      createdAt: new Date().toISOString(),
      sourceAuthority,
      sourceConfigSha256: config.sourceSha,
      targetConfigSha256: config.targetSha,
      sourceStanzaSha256: config.sourceStanzaSha,
      profileManifest,
      evolutionProfileId: evolutionProfileId ?? null,
      liveSnapshot,
      retainedBindings: AGENT_PROFILE_FORGET_RETAINED_BINDINGS,
      ...(ownership ? { ownership } : {}),
    };
    writeJournal(txDir, journal);
    input.onPhase?.("intent");
    const rechecked = await input.live.prepare(input.agentName);
    if (!isDeepStrictEqual(rechecked, liveSnapshot)) throw new Error("agent runtime state changed while forget intent was installed");
    if (configState(input.config, journal) !== "source" || !sameTree(oldRoot, profileManifest)
      || !isDeepStrictEqual(await input.authority.read(input.agentName), sourceAuthority)) {
      throw new Error("canonical profile state changed while forget intent was installed");
    }
    journal = transition(txDir, journal, "committing", input.onPhase);
    await rollForward(input, txDir, journal);
    return { txid, agentName: input.agentName, agentId: snapshot.profile.agentId };
  } catch (error) {
    if (txDir && exists(txDir)) {
      const journal = readJournal(txDir);
      if (journal.phase === "intent") {
        fs.rmSync(txDir, { recursive: true, force: true });
        syncDirectory(path.dirname(txDir));
      } else if (error instanceof CustodyError) {
        transition(txDir, { ...journal, degradedReason: error.message }, "degraded");
      }
    }
    throw error;
  } finally {
    release();
  }
}

export async function reconcileAgentProfileForgets(input: Omit<CommitAgentProfileForgetInput,
  "agentName" | "expectedRevision" | "onPhase">): Promise<{ reconciled: string[]; degraded: string[] }> {
  const root = forgetRoot(input.workspaceRoot);
  if (!exists(root)) return { reconciled: [], degraded: [] };
  const reconciled: string[] = [];
  const degraded: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    const txDir = path.join(root, entry);
    try {
      const journal = readJournal(txDir);
      if (journal.phase === "committed") continue;
      if (journal.phase === "degraded") { degraded.push(entry); continue; }
      const release = acquireAgentProfileRecoveryLocks(
        input.workspaceRoot,
        [journal.agentName, ...(journal.ownership ? [journal.ownership.ownerAgentName] : [])],
        journal.txid,
      );
      try {
        if (journal.phase === "intent") {
          fs.rmSync(txDir, { recursive: true, force: true });
          syncDirectory(root);
        } else {
          await rollForward({ ...input, agentName: journal.agentName }, txDir, journal);
        }
        reconciled.push(entry);
      } finally { release(); }
    } catch (error) {
      try {
        const journal = readJournal(txDir);
        if (error instanceof CustodyError && journal.phase !== "degraded") {
          transition(txDir, { ...journal, degradedReason: error.message }, "degraded");
        }
      } catch { /* malformed journal remains fail-closed */ }
      degraded.push(entry);
    }
  }
  return { reconciled, degraded };
}

export function agentProfileForgetBlocked(workspaceRoot: string, agentName: string): boolean {
  const root = forgetRoot(workspaceRoot);
  try {
    const key = asciiFoldAgentName(agentName);
    return fs.readdirSync(root).some((entry) => {
      try {
        const journal = readJournal(path.join(root, entry));
        return journal.phase !== "committed" && asciiFoldAgentName(journal.agentName) === key;
      } catch { return true; }
    });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Names whose external/name-only state is retained by a durable retirement receipt. */
export function agentProfileForgetRetainedNames(workspaceRoot: string): Set<string> {
  const retained = new Set<string>();
  const root = forgetRoot(workspaceRoot);
  try {
    for (const entry of fs.readdirSync(root)) {
      try { retained.add(readJournal(path.join(root, entry)).agentName); }
      catch { /* malformed journals block admission but cannot safely name an owner */ }
    }
  } catch { /* no forget receipts */ }
  return retained;
}

/** Corrupt receipts make name-only GC unsafe because their owner cannot be recovered. */
export function agentProfileForgetRetentionUncertain(workspaceRoot: string): boolean {
  const root = forgetRoot(workspaceRoot);
  try {
    for (const entry of fs.readdirSync(root)) {
      try { readJournal(path.join(root, entry)); }
      catch { return true; }
    }
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
