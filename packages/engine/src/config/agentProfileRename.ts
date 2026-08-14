import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentProfileAuthorityRecord } from "./agentProfileAuthority.js";
import { agentProfileAuthorityFor, inspectAgentProfileLifecycle } from "./agentProfileLifecycle.js";
import {
  profileDigest,
  ownershipProfileMutation,
  replaceProfileExact,
} from "./agentProfileOwnership.js";
import type { CanonicalLiveRenameSnapshot } from "../agents/AgentManager.js";
import {
  acquireAgentProfileRecoveryLocks,
  acquireAgentProfileTransactionLocks,
  agentProfileTransactionsRoot,
  type AgentProfileAuthorityPort,
} from "./agentProfileTransactions.js";
import { AgentProfileRefusal } from "@tachyon/shared/config/agentProfileRefusal.js";
import { assertValidAgentName, asciiFoldAgentName } from "./nameValidation.js";

const SCHEMA_VERSION = 1 as const;
const RENAME_DIR = "rename";
const JOURNAL = "journal.json";

export type AgentProfileRenamePhase =
  | "intent"
  | "profile-moved"
  | "authority-moved"
  /**
   * t-ae221c — never entered again; kept readable so an in-flight journal from an older build still
   * parses and rolls forward instead of degrading. The rename moved a directory AND rewrote the
   * agent's `tachyon.yml` stanza; renaming the directory now renames the agent, so the second write
   * has nothing left to say.
   */
  | "locator-written"
  | "live-converged"
  | "activated"
  | "committed"
  | "degraded";

interface TreeEntry {
  path: string;
  kind: "directory" | "file";
  mode: number;
  sha256?: string;
}

export interface AgentProfileRenameJournal {
  schemaVersion: typeof SCHEMA_VERSION;
  txid: string;
  oldAgentName: string;
  newAgentName: string;
  phase: AgentProfileRenamePhase;
  createdAt: string;
  profileManifest: TreeEntry[];
  sourceAuthority: AgentProfileAuthorityRecord;
  targetAuthority: AgentProfileAuthorityRecord;
  /** t-ae221c — legacy `tachyon.yml` stanza digests. Read but never written, and never acted on. */
  sourceStanzaSha256?: string;
  targetStanzaSha256?: string;
  liveSnapshot: CanonicalLiveRenameSnapshot | null;
  /** Parent-side ownership edge updated in the same transaction as the child rename. */
  ownership?: {
    ownerAgentName: string;
    priorProfileSha256: string;
    targetProfileSha256: string;
    priorAuthority: AgentProfileAuthorityRecord;
    targetAuthority: AgentProfileAuthorityRecord;
  };
  degradedReason?: string;
}

export interface CommitAgentProfileRenameInput {
  workspaceRoot: string;
  oldAgentName: string;
  newAgentName: string;
  expectedRevision: string;
  /** Current declared owner, when the child is listed in another canonical profile. */
  ownerAgentName?: string;
  authority: AgentProfileAuthorityPort;
  live?: {
    prepare(oldAgentName: string, newAgentName: string): Promise<CanonicalLiveRenameSnapshot>;
    converge(oldAgentName: string, newAgentName: string, snapshot: CanonicalLiveRenameSnapshot): Promise<void>;
  };
  activateState: () => void;
  onPhase?: (phase: AgentProfileRenamePhase) => void;
}

export interface AgentProfileRenameResult {
  txid: string;
  oldAgentName: string;
  newAgentName: string;
  agentId: string;
}

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
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

function writeJournal(txDir: string, journal: AgentProfileRenameJournal): void {
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

function transition(
  txDir: string,
  journal: AgentProfileRenameJournal,
  phase: AgentProfileRenamePhase,
  onPhase?: (phase: AgentProfileRenamePhase) => void,
): AgentProfileRenameJournal {
  const next = { ...journal, phase };
  writeJournal(txDir, next);
  onPhase?.(phase);
  return next;
}

function renameRoot(workspaceRoot: string): string {
  return path.join(agentProfileTransactionsRoot(workspaceRoot), RENAME_DIR);
}

function ensureRenameRoot(workspaceRoot: string): string {
  const root = renameRoot(workspaceRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  const workspace = fs.realpathSync.native(path.resolve(workspaceRoot));
  const expected = path.join(workspace, path.relative(path.resolve(workspaceRoot), root));
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(root) !== expected) {
    throw new Error(`unsafe profile rename transaction root: ${root}`);
  }
  return root;
}

function requireSafeDirectory(workspaceRoot: string, directory: string): void {
  const workspace = fs.realpathSync.native(path.resolve(workspaceRoot));
  const expected = path.join(workspace, path.relative(path.resolve(workspaceRoot), directory));
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(directory) !== expected) {
    throw new Error(`unsafe profile rename directory: ${directory}`);
  }
}

function profileRoot(workspaceRoot: string, agentName: string): string {
  return path.join(path.resolve(workspaceRoot), ".tachyon", "agents", agentName);
}

function treeManifest(root: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const walk = (directory: string, relative: string): void => {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe profile tree entry: ${relative || "."}`);
    entries.push({ path: relative || ".", kind: "directory", mode: stat.mode & 0o777 });
    for (const name of fs.readdirSync(directory).sort()) {
      const child = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const childStat = fs.lstatSync(child);
      if (childStat.isSymbolicLink()) throw new Error(`profile tree contains symbolic link: ${childRelative}`);
      if (childStat.isDirectory()) walk(child, childRelative);
      else if (childStat.isFile()) entries.push({
        path: childRelative,
        kind: "file",
        mode: childStat.mode & 0o777,
        sha256: digest(fs.readFileSync(child)),
      });
      else throw new Error(`profile tree contains unsupported entry: ${childRelative}`);
    }
  };
  walk(root, "");
  return entries;
}

function sameTree(root: string, expected: TreeEntry[]): boolean {
  try { return isDeepStrictEqual(treeManifest(root), expected); }
  catch { return false; }
}

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function moveProfileDirectory(
  workspaceRoot: string,
  from: string,
  to: string,
  manifest: TreeEntry[],
): void {
  const parent = path.dirname(from);
  requireSafeDirectory(workspaceRoot, parent);
  if (path.dirname(to) !== parent) throw new Error("profile rename must remain inside the canonical agents directory");
  if (!sameTree(from, manifest) || exists(to)) throw new Error("profile rename source or destination changed");
  fs.renameSync(from, to);
  syncDirectory(parent);
  if (!sameTree(to, manifest) || exists(from)) throw new Error("profile directory move did not converge");
}

function readJournal(txDir: string): AgentProfileRenameJournal {
  const value = JSON.parse(fs.readFileSync(path.join(txDir, JOURNAL), "utf8")) as Partial<AgentProfileRenameJournal>;
  if (value.schemaVersion !== SCHEMA_VERSION || typeof value.txid !== "string"
    || typeof value.oldAgentName !== "string" || typeof value.newAgentName !== "string"
    || !Array.isArray(value.profileManifest) || !value.sourceAuthority || !value.targetAuthority) {
    throw new Error("invalid agent profile rename journal");
  }
  return value as AgentProfileRenameJournal;
}

async function authorityState(authority: AgentProfileAuthorityPort, journal: AgentProfileRenameJournal): Promise<"source" | "target" | "conflict"> {
  const source = await authority.read(journal.oldAgentName);
  const target = await authority.read(journal.newAgentName);
  if (isDeepStrictEqual(source, journal.sourceAuthority) && target === undefined) return "source";
  if (source === undefined && isDeepStrictEqual(target, journal.targetAuthority)) return "target";
  return "conflict";
}

async function convergeOwnership(input: CommitAgentProfileRenameInput, journal: AgentProfileRenameJournal): Promise<void> {
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
    throw new Error("ownership profile or authority changed outside the rename transaction");
  }
  if (profileState === "source") {
    const mutation = ownershipProfileMutation(
      input.workspaceRoot,
      companion.ownerAgentName,
      journal.oldAgentName,
      journal.newAgentName,
    );
    if (mutation.priorSha256 !== companion.priorProfileSha256 || mutation.targetSha256 !== companion.targetProfileSha256) {
      throw new Error("ownership profile target changed outside the rename transaction");
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
    throw new Error("ownership rename did not converge");
  }
}

async function rollForward(input: CommitAgentProfileRenameInput, txDir: string, journal: AgentProfileRenameJournal): Promise<AgentProfileRenameJournal> {
  const oldRoot = profileRoot(input.workspaceRoot, journal.oldAgentName);
  const newRoot = profileRoot(input.workspaceRoot, journal.newAgentName);
  if (!sameTree(newRoot, journal.profileManifest)) throw new Error("profile rename target tree changed");
  await convergeOwnership(input, journal);
  if (exists(oldRoot)) {
    if (fs.readdirSync(oldRoot).length !== 0) throw new Error("profile rename source home retained unexpected data");
    fs.rmdirSync(oldRoot);
    syncDirectory(path.dirname(oldRoot));
  }
  if (journal.liveSnapshot) {
    if (!input.live) throw new Error("profile rename recovery requires live convergence support");
    await input.live.converge(journal.oldAgentName, journal.newAgentName, journal.liveSnapshot);
    if (journal.phase !== "live-converged" && journal.phase !== "activated" && journal.phase !== "committed") {
      journal = transition(txDir, journal, "live-converged", input.onPhase);
    }
  }
  input.activateState();
  journal = transition(txDir, journal, "activated", input.onPhase);
  journal = transition(txDir, journal, "committed", input.onPhase);
  fs.rmSync(txDir, { recursive: true, force: true });
  syncDirectory(path.dirname(txDir));
  return journal;
}

function compensateProfile(workspaceRoot: string, journal: AgentProfileRenameJournal): void {
  const oldRoot = profileRoot(workspaceRoot, journal.oldAgentName);
  const newRoot = profileRoot(workspaceRoot, journal.newAgentName);
  if (sameTree(oldRoot, journal.profileManifest) && !exists(newRoot)) return;
  if (!exists(oldRoot) && sameTree(newRoot, journal.profileManifest)) {
    fs.renameSync(newRoot, oldRoot);
    syncDirectory(path.dirname(oldRoot));
    if (sameTree(oldRoot, journal.profileManifest) && !exists(newRoot)) return;
  }
  throw new Error("profile rename cannot safely restore the source tree");
}

export async function commitAgentProfileRename(input: CommitAgentProfileRenameInput): Promise<AgentProfileRenameResult> {
  assertValidAgentName(input.oldAgentName);
  assertValidAgentName(input.newAgentName);
  if (input.oldAgentName === input.newAgentName) throw new Error("profile rename source and destination must differ");
  if (!input.authority.move) throw new Error("profile authority does not support atomic rename");
  if (input.ownerAgentName !== undefined) {
    assertValidAgentName(input.ownerAgentName);
    if (input.ownerAgentName === input.oldAgentName || input.ownerAgentName === input.newAgentName) {
      throw new Error("ownership owner must be distinct from the renamed agent");
    }
  }
  const txid = crypto.randomUUID();
  const release = acquireAgentProfileTransactionLocks(
    input.workspaceRoot,
    [input.oldAgentName, input.newAgentName, ...(input.ownerAgentName ? [input.ownerAgentName] : [])],
    txid,
  );
  let txDir: string | undefined;
  try {
    const snapshot = await inspectAgentProfileLifecycle({
      workspaceRoot: input.workspaceRoot,
      agentName: input.oldAgentName,
      authority: input.authority,
    });
    if (snapshot.revision !== input.expectedRevision) {
      throw new AgentProfileRefusal("agent-profile/revision-conflict", "agent profile revision changed before rename");
    }
    const sourceAuthority = await input.authority.read(input.oldAgentName);
    if (!sourceAuthority || sourceAuthority.agentId !== snapshot.profile.agentId
      || sourceAuthority.canonicalSha256 !== snapshot.provenance.canonical.sha256) {
      throw new Error(`canonical authority for '${input.oldAgentName}' is missing or stale`);
    }
    if (await input.authority.read(input.newAgentName)) throw new Error(`canonical authority for '${input.newAgentName}' already exists`);
    const oldRoot = profileRoot(input.workspaceRoot, input.oldAgentName);
    const newRoot = profileRoot(input.workspaceRoot, input.newAgentName);
    // t-ae221c — THE destination-conflict check. It used to be one of two: this one, and a scan
    // asking whether `tachyon.yml` already carried a pointer for the new name. The directory IS the
    // roster now, so a free name and a free directory are the same fact.
    if (exists(newRoot)) throw new Error(`canonical profile home for '${input.newAgentName}' already exists`);
    const profileManifest = treeManifest(oldRoot);
    const liveSnapshot = input.live ? await input.live.prepare(input.oldAgentName, input.newAgentName) : null;
    const targetAuthority = { ...sourceAuthority, agentName: input.newAgentName };
    let ownership: AgentProfileRenameJournal["ownership"];
    if (input.ownerAgentName) {
      const mutation = ownershipProfileMutation(input.workspaceRoot, input.ownerAgentName, input.oldAgentName, input.newAgentName);
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
    const root = ensureRenameRoot(input.workspaceRoot);
    txDir = path.join(root, txid);
    fs.mkdirSync(txDir, { mode: 0o700 });
    syncDirectory(root);
    let journal: AgentProfileRenameJournal = {
      schemaVersion: SCHEMA_VERSION,
      txid,
      oldAgentName: input.oldAgentName,
      newAgentName: input.newAgentName,
      phase: "intent",
      createdAt: new Date().toISOString(),
      profileManifest,
      sourceAuthority,
      targetAuthority,
      liveSnapshot,
      ...(ownership ? { ownership } : {}),
    };
    writeJournal(txDir, journal);
    input.onPhase?.("intent");
    moveProfileDirectory(input.workspaceRoot, oldRoot, newRoot, profileManifest);
    journal = transition(txDir, journal, "profile-moved", input.onPhase);
    try {
      await input.authority.move(input.oldAgentName, input.newAgentName, sourceAuthority, targetAuthority);
    } catch (error) {
      if (await authorityState(input.authority, journal) !== "target") throw error;
    }
    if (await authorityState(input.authority, journal) !== "target") throw new Error("profile authority rename did not converge");
    journal = transition(txDir, journal, "authority-moved", input.onPhase);
    await rollForward(input, txDir, journal);
    return { txid, oldAgentName: input.oldAgentName, newAgentName: input.newAgentName, agentId: snapshot.profile.agentId };
  } catch (error) {
    if (txDir && exists(txDir)) {
      const journal = readJournal(txDir);
      const state = await authorityState(input.authority, journal);
      if (state === "source") {
        try {
          compensateProfile(input.workspaceRoot, journal);
          fs.rmSync(txDir, { recursive: true, force: true });
        } catch (rollbackError) {
          transition(txDir, journal, "degraded");
          throw new AggregateError([error, rollbackError], "profile rename and compensation both failed");
        }
      } else if (state === "conflict") {
        transition(txDir, { ...journal, degradedReason: "authority pair changed outside transaction" }, "degraded");
      }
    }
    throw error;
  } finally {
    release();
  }
}

export async function reconcileAgentProfileRenames(input: Omit<CommitAgentProfileRenameInput,
  "oldAgentName" | "newAgentName" | "expectedRevision" | "onPhase">): Promise<{ reconciled: string[]; degraded: string[] }> {
  const root = renameRoot(input.workspaceRoot);
  if (!exists(root)) return { reconciled: [], degraded: [] };
  const reconciled: string[] = [];
  const degraded: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    const txDir = path.join(root, entry);
    try {
      requireSafeDirectory(input.workspaceRoot, txDir);
      let journal = readJournal(txDir);
      if (journal.phase === "degraded") { degraded.push(entry); continue; }
      const release = acquireAgentProfileRecoveryLocks(
        input.workspaceRoot,
        [journal.oldAgentName, journal.newAgentName, ...(journal.ownership ? [journal.ownership.ownerAgentName] : [])],
        journal.txid,
      );
      try {
        const state = await authorityState(input.authority, journal);
        if (state === "source") {
          compensateProfile(input.workspaceRoot, journal);
          fs.rmSync(txDir, { recursive: true, force: true });
        } else if (state === "target") {
          journal = await rollForward({ ...input, oldAgentName: journal.oldAgentName, newAgentName: journal.newAgentName,
            expectedRevision: "recovery" }, txDir, journal);
          void journal;
        } else {
          throw new Error("profile rename authority pair is ambiguous");
        }
        reconciled.push(entry);
      } finally { release(); }
    } catch {
      degraded.push(entry);
    }
  }
  return { reconciled, degraded };
}

export function agentProfileRenameBlocked(workspaceRoot: string, agentName: string): boolean {
  const root = renameRoot(workspaceRoot);
  try {
    return fs.readdirSync(root).some((entry) => {
      try {
        const journal = readJournal(path.join(root, entry));
        const key = asciiFoldAgentName(agentName);
        return asciiFoldAgentName(journal.oldAgentName) === key || asciiFoldAgentName(journal.newAgentName) === key;
      } catch { return true; }
    });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
