import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import type { AgentProfileAuthorityRecord } from "./agentProfileAuthority.js";
import { inspectAgentProfileLifecycle } from "./agentProfileLifecycle.js";
import type { CanonicalLiveRenameSnapshot } from "../agents/AgentManager.js";
import {
  acquireAgentProfileRecoveryLocks,
  acquireAgentProfileTransactionLocks,
  agentProfileTransactionsRoot,
  type AgentProfileAuthorityPort,
} from "./agentProfileTransactions.js";
import { canonicalAgentProfilePointer, scanAgentProfilePointers } from "./agentProfilePointer.js";
import { assertValidAgentName, asciiFoldAgentName } from "./nameValidation.js";
import { agentStanzaSourceSlice, renameAgent as renameAgentInYml } from "./YamlConfigEditor.js";

const SCHEMA_VERSION = 1 as const;
const RENAME_DIR = "rename";
const JOURNAL = "journal.json";

export type AgentProfileRenamePhase =
  | "intent"
  | "profile-moved"
  | "authority-moved"
  | "locator-written"
  | "evolution-moved"
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
  sourceStanzaSha256: string;
  targetStanzaSha256: string;
  evolutionProfileId: string | null;
  liveSnapshot: CanonicalLiveRenameSnapshot | null;
  degradedReason?: string;
}

export interface AgentProfileRenameConfigPort {
  read(): string;
  replace(expectedSha256: string, text: string): void;
}

export interface AgentProfileRenameEvolutionPort {
  readProfileId(agentName: string): Promise<string | undefined>;
  rename(oldAgentName: string, newAgentName: string): Promise<boolean>;
}

export interface CommitAgentProfileRenameInput {
  workspaceRoot: string;
  oldAgentName: string;
  newAgentName: string;
  expectedRevision: string;
  authority: AgentProfileAuthorityPort;
  config: AgentProfileRenameConfigPort;
  evolution: AgentProfileRenameEvolutionPort;
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

function manifestPart(entries: TreeEntry[], part: "evolution" | "profile"): TreeEntry[] {
  return entries.filter((entry) => entry.path === "."
    || (part === "evolution" ? entry.path === "evolution" || entry.path.startsWith("evolution/")
      : entry.path !== "evolution" && !entry.path.startsWith("evolution/")));
}

function sameManifestPart(root: string, expected: TreeEntry[], part: "evolution" | "profile"): boolean {
  try { return isDeepStrictEqual(manifestPart(treeManifest(root), part), manifestPart(expected, part)); }
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
  evolutionPresent: boolean,
): void {
  const parent = path.dirname(from);
  requireSafeDirectory(workspaceRoot, parent);
  if (path.dirname(to) !== parent) throw new Error("profile rename must remain inside the canonical agents directory");
  if (!sameTree(from, manifest) || exists(to)) throw new Error("profile rename source or destination changed");
  fs.renameSync(from, to);
  syncDirectory(parent);
  if (!sameTree(to, manifest) || exists(from)) throw new Error("profile directory move did not converge");
  if (evolutionPresent) {
    const rootMode = manifest.find((entry) => entry.path === ".")?.mode ?? 0o700;
    fs.mkdirSync(from, { mode: rootMode });
    fs.chmodSync(from, rootMode);
    fs.renameSync(path.join(to, "evolution"), path.join(from, "evolution"));
    syncDirectory(from);
    syncDirectory(to);
    syncDirectory(parent);
    if (!sameManifestPart(from, manifest, "evolution") || !sameManifestPart(to, manifest, "profile")) {
      throw new Error("profile and Evolution homes did not split safely for rename");
    }
  }
}

function renamedConfig(text: string, oldName: string, newName: string): { text: string; sourceSha: string; targetSha: string } {
  const source = agentStanzaSourceSlice(text, oldName);
  const scan = scanAgentProfilePointers(text);
  if (scan.errors.length > 0) throw new Error(scan.errors.join("; "));
  if (scan.pointers.get(oldName)?.path !== canonicalAgentProfilePointer(oldName)) {
    throw new Error(`agent '${oldName}' is not backed by its canonical profile pointer`);
  }
  if (scan.pointers.has(newName)) throw new Error(`agent '${newName}' already has a profile pointer`);
  const renamed = renameAgentInYml(text, oldName, newName).text;
  const doc = parseDocument(renamed, { uniqueKeys: true });
  if (doc.errors.length > 0) throw new Error(`tachyon.yml is not parseable: ${doc.errors[0]!.message}`);
  doc.setIn(["agents", newName, "profile"], canonicalAgentProfilePointer(newName));
  const targetText = String(doc);
  const target = agentStanzaSourceSlice(targetText, newName);
  return { text: targetText, sourceSha: source.valueSha256, targetSha: target.valueSha256 };
}

function locatorState(
  text: string,
  journal: Pick<AgentProfileRenameJournal, "oldAgentName" | "newAgentName" | "sourceStanzaSha256" | "targetStanzaSha256">,
): "source" | "target" | "conflict" {
  const scan = scanAgentProfilePointers(text);
  if (scan.errors.length > 0) return "conflict";
  const sourcePointer = scan.pointers.get(journal.oldAgentName)?.path;
  const targetPointer = scan.pointers.get(journal.newAgentName)?.path;
  try {
    if (sourcePointer === canonicalAgentProfilePointer(journal.oldAgentName) && targetPointer === undefined
      && agentStanzaSourceSlice(text, journal.oldAgentName).valueSha256 === journal.sourceStanzaSha256) return "source";
    if (sourcePointer === undefined && targetPointer === canonicalAgentProfilePointer(journal.newAgentName)
      && agentStanzaSourceSlice(text, journal.newAgentName).valueSha256 === journal.targetStanzaSha256) return "target";
  } catch { return "conflict"; }
  return "conflict";
}

function writeTargetLocator(input: Pick<CommitAgentProfileRenameInput, "config">, journal: AgentProfileRenameJournal): void {
  const current = input.config.read();
  const state = locatorState(current, journal);
  if (state === "target") return;
  if (state !== "source") throw new Error("profile rename locator changed outside the transaction");
  const next = renamedConfig(current, journal.oldAgentName, journal.newAgentName);
  if (next.sourceSha !== journal.sourceStanzaSha256 || next.targetSha !== journal.targetStanzaSha256) {
    throw new Error("profile rename locator target is not deterministic");
  }
  input.config.replace(digest(current), next.text);
  if (locatorState(input.config.read(), journal) !== "target") throw new Error("profile rename locator write was not durable");
}

async function convergeEvolution(input: Pick<CommitAgentProfileRenameInput, "evolution">, journal: AgentProfileRenameJournal): Promise<void> {
  const oldProfileId = await input.evolution.readProfileId(journal.oldAgentName);
  const newProfileId = await input.evolution.readProfileId(journal.newAgentName);
  if (journal.evolutionProfileId === null) {
    if (oldProfileId !== undefined || newProfileId !== undefined) throw new Error("Agent Evolution appeared during profile rename");
    return;
  }
  if (oldProfileId === undefined && newProfileId === journal.evolutionProfileId) return;
  if (oldProfileId !== journal.evolutionProfileId || newProfileId !== undefined) {
    throw new Error("Agent Evolution state conflicts with profile rename");
  }
  if (!await input.evolution.rename(journal.oldAgentName, journal.newAgentName)) {
    throw new Error("Agent Evolution rename did not find its recorded source");
  }
  if (await input.evolution.readProfileId(journal.oldAgentName) !== undefined
    || await input.evolution.readProfileId(journal.newAgentName) !== journal.evolutionProfileId) {
    throw new Error("Agent Evolution rename did not converge");
  }
}

function readJournal(txDir: string): AgentProfileRenameJournal {
  const value = JSON.parse(fs.readFileSync(path.join(txDir, JOURNAL), "utf8")) as Partial<AgentProfileRenameJournal>;
  if (value.schemaVersion !== SCHEMA_VERSION || typeof value.txid !== "string"
    || typeof value.oldAgentName !== "string" || typeof value.newAgentName !== "string"
    || !Array.isArray(value.profileManifest) || !value.sourceAuthority || !value.targetAuthority
    || typeof value.sourceStanzaSha256 !== "string" || typeof value.targetStanzaSha256 !== "string") {
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

async function rollForward(input: CommitAgentProfileRenameInput, txDir: string, journal: AgentProfileRenameJournal): Promise<AgentProfileRenameJournal> {
  const oldRoot = profileRoot(input.workspaceRoot, journal.oldAgentName);
  const newRoot = profileRoot(input.workspaceRoot, journal.newAgentName);
  if (!sameManifestPart(newRoot, journal.profileManifest, "profile")) throw new Error("profile rename target tree changed");
  writeTargetLocator(input, journal);
  if (journal.phase !== "locator-written" && journal.phase !== "evolution-moved" && journal.phase !== "live-converged"
    && journal.phase !== "activated" && journal.phase !== "committed") {
    journal = transition(txDir, journal, "locator-written", input.onPhase);
  }
  await convergeEvolution(input, journal);
  if (journal.phase !== "evolution-moved" && journal.phase !== "live-converged" && journal.phase !== "activated" && journal.phase !== "committed") {
    journal = transition(txDir, journal, "evolution-moved", input.onPhase);
  }
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
  if (journal.evolutionProfileId !== null && sameManifestPart(oldRoot, journal.profileManifest, "evolution")
    && sameManifestPart(newRoot, journal.profileManifest, "profile")) {
    fs.renameSync(path.join(oldRoot, "evolution"), path.join(newRoot, "evolution"));
    fs.rmdirSync(oldRoot);
    syncDirectory(path.dirname(oldRoot));
    if (!sameTree(newRoot, journal.profileManifest)) throw new Error("profile rename split home could not be reassembled");
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
  const txid = crypto.randomUUID();
  const release = acquireAgentProfileTransactionLocks(input.workspaceRoot, [input.oldAgentName, input.newAgentName], txid);
  let txDir: string | undefined;
  try {
    const snapshot = await inspectAgentProfileLifecycle({
      workspaceRoot: input.workspaceRoot,
      agentName: input.oldAgentName,
      authority: input.authority,
      config: input.config,
    });
    if (snapshot.revision !== input.expectedRevision) throw new Error("agent profile revision changed before rename");
    const sourceAuthority = await input.authority.read(input.oldAgentName);
    if (!sourceAuthority || sourceAuthority.agentId !== snapshot.profile.agentId
      || sourceAuthority.canonicalSha256 !== snapshot.provenance.canonical.sha256) {
      throw new Error(`canonical authority for '${input.oldAgentName}' is missing or stale`);
    }
    if (await input.authority.read(input.newAgentName)) throw new Error(`canonical authority for '${input.newAgentName}' already exists`);
    const configTarget = renamedConfig(input.config.read(), input.oldAgentName, input.newAgentName);
    const oldEvolution = await input.evolution.readProfileId(input.oldAgentName);
    if (await input.evolution.readProfileId(input.newAgentName) !== undefined) throw new Error(`Agent Evolution Profile already exists for '${input.newAgentName}'`);
    const oldRoot = profileRoot(input.workspaceRoot, input.oldAgentName);
    const newRoot = profileRoot(input.workspaceRoot, input.newAgentName);
    if (exists(newRoot)) throw new Error(`canonical profile home for '${input.newAgentName}' already exists`);
    const profileManifest = treeManifest(oldRoot);
    const liveSnapshot = input.live ? await input.live.prepare(input.oldAgentName, input.newAgentName) : null;
    const targetAuthority = { ...sourceAuthority, agentName: input.newAgentName };
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
      sourceStanzaSha256: configTarget.sourceSha,
      targetStanzaSha256: configTarget.targetSha,
      evolutionProfileId: oldEvolution ?? null,
      liveSnapshot,
    };
    writeJournal(txDir, journal);
    input.onPhase?.("intent");
    const hasEvolutionTree = profileManifest.some((entry) => entry.path === "evolution");
    const hasEvolutionProfile = profileManifest.some((entry) => entry.path === "evolution/profile.json");
    if ((oldEvolution === undefined && hasEvolutionTree) || (oldEvolution !== undefined && !hasEvolutionProfile)) {
      throw new Error("Agent Evolution profile storage is incomplete");
    }
    moveProfileDirectory(input.workspaceRoot, oldRoot, newRoot, profileManifest, oldEvolution !== undefined);
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
      const release = acquireAgentProfileRecoveryLocks(input.workspaceRoot, [journal.oldAgentName, journal.newAgentName], journal.txid);
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
