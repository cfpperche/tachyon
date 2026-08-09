import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument, stringify } from "yaml";
import { isValidAgentName } from "./nameValidation.js";
import {
  agentProfileRelativePathError,
  agentProfileSchemaV1,
  type AgentProfileReferenceV1,
  type AgentProfileV1,
} from "./agentProfileSchema.js";
import type { AgentProfileAuthorityRecord } from "./agentProfileAuthority.js";
import {
  acquireAgentProfileTransactionLock,
  acquireAgentProfileTransactionLocks,
  acquireAgentProfileRecoveryLock,
  acquireAgentProfileRecoveryLocks,
  agentProfileTransactionsRoot,
  currentProfileDigest,
  publishAgentProfile,
  removeAgentProfileIfExact,
  type AgentProfileAuthorityPort,
} from "./agentProfileTransactions.js";
import { AgentProfileRefusal } from "./agentProfileRefusal.js";
import { closeCanonicalAgentProfile, readAgentProfileReference, readCanonicalAgentProfile, verifiedDescriptorPath, type CanonicalAgentProfileSource } from "./agentProfileReader.js";
import {
  WORKSPACE_SETUP_PATH,
  WORKSPACE_SETUP_REFERENCE_ID,
  parseWorkspaceCommandLines,
} from "./agentWorkspaceCommands.js";
import { isSupersededRuntimeInspector, profileRuntimeInspectorFor } from "./agentProfileProjection.js";

const SCHEMA_VERSION = 1 as const;
const CANONICALIZATION_VERSION = 1 as const;
const LIFECYCLE_DIR = "lifecycle";
const JOURNAL = "journal.json";
const STAGED = "staged-agent.yml";
const BACKUP = "backup-agent.yml";
const COMPANION_BACKUP = "backup-companion-agent.yml";
const ARTIFACTS = "artifacts";
/** t-afc86e — prior bytes of any artifact this transaction REPLACES, so a rollback can restore them. */
const ARTIFACT_BACKUPS = "artifact-backups";
const DIGEST_RE = /^[a-f0-9]{64}$/;
const CREATE_ARTIFACT_NAMES = new Set(["SOUL.md", "instructions.md", WORKSPACE_SETUP_PATH]);
/**
 * `t-d185e1` — profile-local documents an EDIT may publish.
 *
 * Deliberately its own set, and deliberately tiny. Enabling Evolution on an already-declared canonical
 * agent needs a companion file (`evolution-selector.json`) written in the SAME transaction as the
 * patch that pins it: the projection only grants `selfEvolution` when the pinned sha256 matches the
 * bytes on disk, so publishing them separately would leave a window where the profile references a
 * digest nothing satisfies — and the authority is re-signed over the profile, not over the artifact.
 *
 * Keeping create's set separate stops an edit from re-publishing `SOUL.md` behind the soul
 * transaction's back, which owns that document under a different contract.
 */
/*
 * t-afc86e adds the two workspace-command documents to BOTH sets. They are authored by the same
 * gesture that writes the rest of the form, so an edit must be able to republish them — the reason
 * `SOUL.md` is create-only does not apply: nothing else owns these bytes under another contract.
 */
const EDIT_ARTIFACT_NAMES = new Set(["evolution-selector.json", WORKSPACE_SETUP_PATH]);
const ARTIFACT_NAMES_FOR = { create: CREATE_ARTIFACT_NAMES, edit: EDIT_ARTIFACT_NAMES } as const;
const ALL_ARTIFACT_NAMES = new Set([...CREATE_ARTIFACT_NAMES, ...EDIT_ARTIFACT_NAMES]);
const CREATE_ARTIFACT_MAX_BYTES = 64 * 1024;

/**
 * t-afc86e — one artifact this transaction publishes, and what was there before it.
 *
 * `priorSha256` absent means the transaction CREATED the file; present means it REPLACED one, and
 * carries the digest a rollback must restore. Recording it in the journal rather than re-reading the
 * directory at compensation time is what makes recovery work after a crash: the process that rolls
 * back may not be the process that published.
 */
export interface LifecycleArtifactRecord {
  path: string;
  sha256: string;
  priorSha256?: string;
}

export type AgentProfileLifecycleOperation = "create" | "edit" | "set-enabled";
export type AgentProfileLifecyclePhase =
  | "intent"
  | "staged"
  | "profile-published"
  | "authority-published"
  /**
   * t-ae221c — never entered again. `create` used to write a pointer into `tachyon.yml` after the
   * authority landed; the roster now comes from `.tachyon/agents/`, so there is no second file and
   * no phase between the authority and activation.
   *
   * Kept READABLE on purpose. A journal is deleted when its transaction commits, so the only ones
   * that survive an upgrade are the in-flight ones — and a journal this build refuses to parse goes
   * to `degraded`, which every reconcile skips FOREVER (the O6 failure in the orphan hunt). Accepting
   * the old name costs one string and lets that transaction finish.
   */
  | "locator-written"
  | "activated"
  | "committed"
  | "compensating"
  | "degraded";

export interface AgentProfileLifecycleJournal {
  schemaVersion: typeof SCHEMA_VERSION;
  txid: string;
  operation: AgentProfileLifecycleOperation;
  agentName: string;
  phase: AgentProfileLifecyclePhase;
  createdAt: string;
  expectedRevision: string | null;
  priorProfileSha256: string | null;
  targetProfileSha256: string;
  priorAuthority: AgentProfileAuthorityRecord | null;
  targetAuthority: AgentProfileAuthorityRecord;
  /**
   * t-ae221c — written by builds where `create` also wrote a pointer into `tachyon.yml`. This build
   * writes neither, and ignores both when it recovers an older journal: the pointer it would restore
   * is now an inert legacy block that loads with a warning, so leaving it is not a loss.
   *
   * Optional rather than gone so an in-flight journal still PARSES; see `locator-written` above.
   */
  priorConfigSha256?: string;
  targetConfigSha256?: string;
  targetArtifacts?: LifecycleArtifactRecord[];
  /**
   * SDD 482 phase 4 (`t-5e1113`) — a SECOND agent whose profile this same transaction edits.
   *
   * Present only for the ratified create-and-adopt: creating a Saved Agent and recording the proposer
   * as its declared owner. Ownership is parent-side (spec 352), so the edge lives in the PROPOSER's
   * profile — a different subject from the agent being created. Two transactions would leave a window
   * where the agent exists unowned; one journal, one txid and one pair of locks removes it.
   *
   * Both authorities carry `revision: lifecycle-<txid>` as a result. That is ratified, not incidental:
   * one transaction has one identity, and an auditor reading two records with the same revision is
   * seeing the truth rather than a collision.
   */
  companion?: {
    agentName: string;
    priorProfileSha256: string;
    targetProfileSha256: string;
    priorAuthority: AgentProfileAuthorityRecord;
    targetAuthority: AgentProfileAuthorityRecord;
  };
  degradedReason?: string;
}

export interface AgentProfileLifecycleSnapshot {
  schemaVersion: 1;
  canonicalizationVersion: typeof CANONICALIZATION_VERSION;
  agentName: string;
  agentId: string;
  revision: string;
  profile: AgentProfileV1;
  /**
   * t-afc86e — the BYTES behind the Studio-owned workspace-command references, digest-checked while
   * the profile directory was open.
   *
   * This is not convenience data, it is what makes the fields editable at all. `profile` carries only
   * the reference IDS, so a form built from the snapshot alone would render an empty setup box for
   * an agent that has setup commands — and the next save would write that emptiness back.
   *
   * Absent when the profile declares no such reference, or when it names one this Studio does not
   * own (`bindings.foreignWorkspaceCommands` on the projected snapshot).
   */
  workspaceCommands?: { setup?: string[] };
  provenance: {
    canonical: { scope: "profile"; writable: true; sha256: string };
    authority: { scope: "host"; writable: false; revision: string; grants: number; /** Content-free IDs of grants eligible for Studio selection. */ capabilityReferenceIds?: string[] };
    learned: { scope: "profile"; writable: false; present: boolean };
    projection: { scope: "runtime"; writable: false; active: boolean };
  };
}

export type AgentProfileCanonicalPatch = Partial<Omit<AgentProfileV1, "schemaVersion" | "agentId">>;

export interface CommitAgentProfileLifecycleInput {
  workspaceRoot: string;
  agentName: string;
  operation: AgentProfileLifecycleOperation;
  expectedRevision?: string;
  patch?: AgentProfileCanonicalPatch;
  enabled?: boolean;
  createProfile?: Omit<AgentProfileV1, "schemaVersion" | "agentId">;
  createProfileLocalReferences?: Array<Omit<AgentProfileReferenceV1, "scope" | "owner">>;
  /**
   * Bounded profile-local authored files published in this transaction. `create` carries the V1
   * bundle's documents; `edit` carries only the Evolution selector (`t-d185e1`). Never on
   * `set-enabled`, which changes a flag and no bytes.
   */
  artifacts?: Array<{ path: string; text: string; sha256: string }>;
  /**
   * SDD 482 phase 4 — edit a SECOND agent's ownership inside this same transaction.
   *
   * Narrow on purpose: only `ownership`, only an agent that already has canonical state. A general
   * "apply this patch to another agent too" would be a second write path wearing a parameter, and the
   * point of putting it here is that there is exactly one phase machine for durable authority.
   */
  companion?: { agentName: string; ownership: AgentProfileV1["ownership"] };
  /**
   * t-5498a6 — the capability grants this transaction establishes, replacing whatever the prior
   * authority held.
   *
   * Grants used to be carried through from `prior` untouched and there was no way to mint one, which
   * is why every profile in a Tachyon workspace granted zero capabilities: not a decision anybody
   * made, just the only reachable state. It belongs HERE rather than in a second write path because a
   * grant and the reference it authorizes are one fact — persisting them separately would allow a
   * crash to leave a grant with no reference, or a selection the authority never blessed.
   *
   * Absent means "carry the prior grants", which is what every existing caller wants and gets.
   */
  capabilityGrants?: readonly NonNullable<AgentProfileAuthorityRecord["capabilityGrants"]>[number][];
  authority: AgentProfileAuthorityPort;
  onPhase?: (phase: AgentProfileLifecyclePhase) => void;
  /** Host activation runs while the journal and lock still make launch fail closed. */
  activateState: (state: "target" | "prior" | "blocked") => void;
}

export interface AgentProfileLifecycleCommitResult {
  txid: string;
  operation: AgentProfileLifecycleOperation;
  revision: string;
  snapshot: AgentProfileLifecycleSnapshot;
}

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sameAuthority(left: AgentProfileAuthorityRecord | undefined | null, right: AgentProfileAuthorityRecord | undefined | null): boolean {
  return isDeepStrictEqual(left ?? null, right ?? null);
}

/**
 * t-ae221c — the revision is the profile and the authority, and there is nothing else in it.
 *
 * It used to fold in the sha of the agent's `tachyon.yml` stanza. That third input was the ONLY
 * reason `inspectAgentProfileLifecycle` — and through it every CAS in rename and forget — had to
 * read the config file at all. The stanza was a derived constant (`profile:` accepted exactly one
 * string), so a revision that changed when it changed was a revision that could only change when
 * somebody hand-edited a value the loader would have refused anyway.
 */
function revisionOf(profileSha256: string, authority: AgentProfileAuthorityRecord): string {
  return digest(JSON.stringify({
    canonicalizationVersion: CANONICALIZATION_VERSION,
    profileSha256,
    authority,
  }));
}

function lifecycleRoot(workspaceRoot: string): string {
  return path.join(agentProfileTransactionsRoot(workspaceRoot), LIFECYCLE_DIR);
}

function ensureSafeDirectory(workspaceRoot: string, directory: string): void {
  const workspace = fs.realpathSync.native(path.resolve(workspaceRoot));
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  const expected = path.join(workspace, path.relative(path.resolve(workspaceRoot), directory));
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(directory) !== expected) {
    throw new Error(`unsafe lifecycle transaction directory: ${directory}`);
  }
}

function requireSafeDirectory(workspaceRoot: string, directory: string): void {
  const workspace = fs.realpathSync.native(path.resolve(workspaceRoot));
  const stat = fs.lstatSync(directory);
  const expected = path.join(workspace, path.relative(path.resolve(workspaceRoot), directory));
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(directory) !== expected) {
    throw new Error(`unsafe lifecycle transaction directory: ${directory}`);
  }
}

function ensureLifecycleRoot(workspaceRoot: string): string {
  // Acquiring the principal lock already created and validated the shared transaction root.
  const root = lifecycleRoot(workspaceRoot);
  try { ensureSafeDirectory(workspaceRoot, root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    requireSafeDirectory(workspaceRoot, root);
  }
  return root;
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

function writeNew(file: string, bytes: string | Buffer): void {
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}

function replacePrivate(file: string, bytes: string | Buffer): void {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    writeNew(temporary, bytes);
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function writeJournal(txDir: string, journal: AgentProfileLifecycleJournal): void {
  replacePrivate(path.join(txDir, JOURNAL), `${JSON.stringify(journal, null, 2)}\n`);
}

function readPrivateFile(file: string, maxBytes = 16 * 1024 * 1024): Buffer {
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error(`invalid lifecycle private file: ${file}`);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error(`lifecycle private file changed during read: ${file}`);
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

function transition(
  txDir: string,
  journal: AgentProfileLifecycleJournal,
  phase: AgentProfileLifecyclePhase,
  onPhase?: (phase: AgentProfileLifecyclePhase) => void,
): AgentProfileLifecycleJournal {
  const next = { ...journal, phase };
  writeJournal(txDir, next);
  onPhase?.(phase);
  return next;
}

function readJournal(txDir: string): AgentProfileLifecycleJournal {
  const file = path.join(txDir, JOURNAL);
  const value = JSON.parse(readPrivateFile(file, 1024 * 1024).toString("utf8")) as Partial<AgentProfileLifecycleJournal>;
  if (value.schemaVersion !== SCHEMA_VERSION || value.txid !== path.basename(txDir)
    || !["create", "edit", "set-enabled"].includes(value.operation ?? "")
    || !["intent", "staged", "profile-published", "authority-published", "locator-written", "activated", "committed", "compensating", "degraded"].includes(value.phase ?? "")
    || typeof value.agentName !== "string" || !isValidAgentName(value.agentName)
    || (value.expectedRevision !== null && (typeof value.expectedRevision !== "string" || !DIGEST_RE.test(value.expectedRevision)))
    || (value.priorProfileSha256 !== null && (typeof value.priorProfileSha256 !== "string" || !DIGEST_RE.test(value.priorProfileSha256)))
    || typeof value.targetProfileSha256 !== "string" || !DIGEST_RE.test(value.targetProfileSha256)
    // t-ae221c — accepted when present (an in-flight journal from a build that wrote a pointer) and
    // never required, because this build writes neither.
    || (value.priorConfigSha256 !== undefined && (typeof value.priorConfigSha256 !== "string" || !DIGEST_RE.test(value.priorConfigSha256)))
    || (value.targetConfigSha256 !== undefined && (typeof value.targetConfigSha256 !== "string" || !DIGEST_RE.test(value.targetConfigSha256)))
    || !value.targetAuthority || typeof value.createdAt !== "string"
    || (value.targetArtifacts !== undefined && (!Array.isArray(value.targetArtifacts)
      || value.targetArtifacts.some((artifact) => !artifact || typeof artifact.path !== "string"
        || !ALL_ARTIFACT_NAMES.has(artifact.path)
        || typeof artifact.sha256 !== "string" || !DIGEST_RE.test(artifact.sha256))))) {
    throw new Error("invalid lifecycle journal schema");
  }
  return value as AgentProfileLifecycleJournal;
}

function validateCreateArtifacts(input: CommitAgentProfileLifecycleInput): Array<{ path: string; text: string; sha256: string }> {
  if (input.artifacts === undefined) return [];
  const allowed = input.operation === "create" || input.operation === "edit"
    ? ARTIFACT_NAMES_FOR[input.operation]
    : undefined;
  if (!allowed) throw new Error("lifecycle artifacts are allowed only for profile creation or edit");
  if (input.artifacts.length > allowed.size) throw new Error("too many lifecycle artifacts");
  const seen = new Set<string>();
  return input.artifacts.map((artifact) => {
    const pathError = agentProfileRelativePathError(artifact.path);
    if (pathError || !allowed.has(artifact.path)) {
      throw new Error(`invalid lifecycle create artifact '${artifact.path}': ${pathError ?? "unsupported portable document name"}`);
    }
    if (seen.has(artifact.path.toLowerCase())) throw new Error(`duplicate lifecycle create artifact '${artifact.path}'`);
    seen.add(artifact.path.toLowerCase());
    if (Buffer.byteLength(artifact.text, "utf8") > CREATE_ARTIFACT_MAX_BYTES) {
      throw new Error(`lifecycle create artifact '${artifact.path}' exceeds ${CREATE_ARTIFACT_MAX_BYTES} UTF-8 bytes`);
    }
    const actual = digest(artifact.text);
    if (actual !== artifact.sha256) throw new Error(`lifecycle create artifact '${artifact.path}' digest mismatch`);
    return { ...artifact };
  });
}

/**
 * Publish this transaction's artifacts into the profile directory.
 *
 * t-afc86e made these REPLACEABLE. Until then every artifact was new by construction — `SOUL.md` on
 * create, the Evolution selector on a one-time enable — so `writeNew` was the whole story and a
 * second publish of the same path threw. That is exactly what setup does on its second save:
 * the human edits the command, and the transaction has to overwrite bytes it published last time.
 *
 * The replacement is still CAS-guarded. `priorSha256` is what the file held when this transaction was
 * staged; finding anything else means someone wrote to the profile directory underneath us, and that
 * is a refusal rather than a silent overwrite — the prior bytes are what compensation would restore,
 * so losing track of them would make the rollback a lie.
 */
function publishArtifacts(workspaceRoot: string, agentName: string, txDir: string, artifacts: readonly LifecycleArtifactRecord[]): void {
  if (artifacts.length === 0) return;
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) throw new Error(`canonical profile for '${agentName}' is missing while publishing artifacts`);
  try {
    const root = verifiedDescriptorPath(source.profileDirectoryFd, source.source);
    for (const artifact of artifacts) {
      const staged = readPrivateFile(path.join(txDir, ARTIFACTS, artifact.path));
      if (digest(staged) !== artifact.sha256) throw new Error(`staged lifecycle artifact '${artifact.path}' digest mismatch`);
      const file = path.join(root, artifact.path);
      if (artifact.priorSha256 === undefined) {
        writeNew(file, staged);
        continue;
      }
      // Reading it through the fd-relative reader is the CAS: it refuses on a digest that is not the
      // one staging recorded, and on a path that has become something other than a regular file.
      readAgentProfileReference(source, artifact.path, artifact.priorSha256);
      replacePrivate(file, staged);
    }
  } finally { closeCanonicalAgentProfile(source); }
}

/**
 * t-afc86e — pair each staged artifact with the digest of whatever the profile directory already
 * holds at that path, or nothing when the path is free.
 *
 * A `create` never has a prior (the directory does not exist yet), which is stated rather than
 * probed: reading a directory that is about to be created would be a different failure to explain.
 */
function artifactRecordsFor(
  workspaceRoot: string,
  agentName: string,
  profileExists: boolean,
  artifacts: readonly { path: string; text: string; sha256: string }[],
): LifecycleArtifactRecord[] {
  if (artifacts.length === 0) return [];
  if (!profileExists) return artifacts.map(({ path: file, sha256 }) => ({ path: file, sha256 }));
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) return artifacts.map(({ path: file, sha256 }) => ({ path: file, sha256 }));
  try {
    const root = verifiedDescriptorPath(source.profileDirectoryFd, source.source);
    return artifacts.map(({ path: file, sha256 }) => {
      let bytes: Buffer;
      try { bytes = readPrivateFile(path.join(root, file)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, sha256 };
        throw error;
      }
      return { path: file, sha256, priorSha256: digest(bytes) };
    });
  } finally { closeCanonicalAgentProfile(source); }
}

/** The bytes currently at a REPLACED artifact's path, checked against the digest staging recorded. */
function readExistingArtifact(workspaceRoot: string, agentName: string, record: LifecycleArtifactRecord): Buffer {
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) throw new Error(`canonical profile for '${agentName}' is missing while staging artifact backups`);
  try {
    return Buffer.from(readAgentProfileReference(source, record.path, record.priorSha256!).bytes);
  } finally { closeCanonicalAgentProfile(source); }
}

/**
 * Undo `publishArtifacts`: restore what was there before, or remove what was not there at all.
 *
 * The asymmetry is the point. An artifact this transaction CREATED is removed, because the
 * rolled-back profile no longer pins it and nothing would ever verify or delete those bytes again.
 * An artifact it REPLACED is restored from the staged backup, because removing it would turn a
 * failed edit into a deletion of content the human never asked to lose.
 */
function restoreArtifactsExact(
  workspaceRoot: string,
  agentName: string,
  txDir: string,
  artifacts: readonly LifecycleArtifactRecord[],
): void {
  if (artifacts.length === 0) return;
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) return;
  try {
    const root = verifiedDescriptorPath(source.profileDirectoryFd, source.source);
    for (const artifact of artifacts) {
      const file = path.join(root, artifact.path);
      try { fs.lstatSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      readAgentProfileReference(source, artifact.path, artifact.sha256);
      if (artifact.priorSha256 === undefined) {
        fs.unlinkSync(file);
        continue;
      }
      const backup = readPrivateFile(path.join(txDir, ARTIFACT_BACKUPS, artifact.path));
      if (digest(backup) !== artifact.priorSha256) throw new Error(`lifecycle artifact backup '${artifact.path}' digest mismatch`);
      replacePrivate(file, backup);
    }
  } finally { closeCanonicalAgentProfile(source); }
}

function artifactsMatch(workspaceRoot: string, agentName: string, artifacts: readonly { path: string; sha256: string }[]): boolean {
  if (artifacts.length === 0) return true;
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) return false;
  try {
    return artifacts.every((artifact) => {
      try { return readAgentProfileReference(source, artifact.path, artifact.sha256).sha256 === artifact.sha256; }
      catch { return false; }
    });
  } finally { closeCanonicalAgentProfile(source); }
}

function savedAgentProfile(workspaceRoot: string, agentName: string): {
  profile: AgentProfileV1;
  text: string;
  sha256: string;
  workspaceCommands?: { setup?: string[] };
} | undefined {
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) return undefined;
  try {
    const doc = parseDocument(source.text, { uniqueKeys: true });
    if (doc.errors.length > 0) throw new Error(`canonical profile YAML is invalid: ${doc.errors[0]!.message}`);
    const parsed = agentProfileSchemaV1.safeParse(doc.toJS());
    if (!parsed.success) throw new Error(`canonical profile schema is invalid: ${parsed.error.issues[0]!.message}`);
    // t-afc86e — read the workspace-command bytes HERE, inside the same open directory handle that
    // produced `source.sha256`. Reading them later, from a path, would be a second open against a
    // directory that may have moved underneath — the exact race `readAgentProfileReference`'s
    // fd-relative walk exists to close.
    const workspaceCommands = readStudioWorkspaceCommands(source, parsed.data);
    return {
      profile: parsed.data,
      text: source.text,
      sha256: source.sha256,
      ...(workspaceCommands ? { workspaceCommands } : {}),
    };
  } finally {
    closeCanonicalAgentProfile(source);
  }
}

/**
 * t-afc86e — the bytes behind the two references Agent Studio OWNS, or undefined when the profile
 * declares neither.
 *
 * Ownership is the fixed reference id. Any other setup reference belongs to whoever published it and
 * is deliberately not read here: the Studio must not display or overwrite a value it does not own.
 *
 * A digest mismatch throws, which fails the whole inspect. That is correct and deliberate: the
 * alternative is opening a form on bytes that disagree with what the profile pins, and saving from
 * it would launder the mismatch into a fresh pin.
 */
function readStudioWorkspaceCommands(
  source: CanonicalAgentProfileSource,
  profile: AgentProfileV1,
): { setup?: string[] } | undefined {
  const owned = (id: string | undefined, expected: string, kind: "worktree-setup") => {
    if (id !== expected) return undefined;
    const reference = profile.references?.find((candidate) => candidate.id === expected);
    if (!reference || reference.kind !== kind || reference.scope !== "profile"
      || reference.owner !== profile.agentId || reference.mode !== "pinned" || !reference.sha256) {
      return undefined;
    }
    return readAgentProfileReference(source, reference.path, reference.sha256).text;
  };
  const setupIds = profile.workspace?.worktree?.setup ?? [];
  const setupText = setupIds.length === 1
    ? owned(setupIds[0], WORKSPACE_SETUP_REFERENCE_ID, "worktree-setup")
    : undefined;
  if (setupText === undefined) return undefined;
  return {
    ...(setupText !== undefined ? { setup: parseWorkspaceCommandLines(setupText) } : {}),
  };
}

function replaceAgentProfileExact(workspaceRoot: string, agentName: string, expectedSha256: string, text: string): void {
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) throw new Error(`canonical profile for '${agentName}' is missing`);
  try {
    if (source.sha256 !== expectedSha256) throw new Error(`canonical profile for '${agentName}' changed (CAS mismatch)`);
    const base = verifiedDescriptorPath(source.profileDirectoryFd, source.source);
    replacePrivate(`${base}/agent.yml`, text);
  } finally {
    closeCanonicalAgentProfile(source);
  }
}

export async function inspectAgentProfileLifecycle(input: {
  workspaceRoot: string;
  agentName: string;
  authority: AgentProfileAuthorityPort;
}): Promise<AgentProfileLifecycleSnapshot> {
  const canonical = savedAgentProfile(input.workspaceRoot, input.agentName);
  if (!canonical) throw new Error(`canonical profile for '${input.agentName}' is missing`);
  const authority = await input.authority.read(input.agentName);
  if (!authority || authority.agentId !== canonical.profile.agentId || authority.canonicalSha256 !== canonical.sha256) {
    throw new Error(`canonical authority for '${input.agentName}' is missing or stale`);
  }
  const revision = revisionOf(canonical.sha256, authority);
  return {
    schemaVersion: 1,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    agentName: input.agentName,
    agentId: canonical.profile.agentId,
    revision,
    profile: structuredClone(canonical.profile),
    ...(canonical.workspaceCommands ? { workspaceCommands: structuredClone(canonical.workspaceCommands) } : {}),
    provenance: {
      canonical: { scope: "profile", writable: true, sha256: canonical.sha256 },
      authority: {
        scope: "host",
        writable: false,
        revision: authority.revision,
        grants: authority.capabilityGrants?.length ?? 0,
        capabilityReferenceIds: (authority.capabilityGrants ?? []).map((grant) => grant.referenceId).sort(),
      },
      learned: { scope: "profile", writable: false, present: canonical.profile.prompt?.evolution !== undefined },
      projection: { scope: "runtime", writable: false, active: canonical.profile.lifecycle?.enabled !== false },
    },
  };
}

function targetProfile(input: CommitAgentProfileLifecycleInput, current?: AgentProfileV1): AgentProfileV1 {
  if (input.operation === "create") {
    if (!input.createProfile) throw new Error("createProfile is required for create");
    const agentId = crypto.randomUUID();
    const local = (input.createProfileLocalReferences ?? []).map((reference) => ({
      ...reference,
      scope: "profile" as const,
      owner: agentId,
    }));
    return agentProfileSchemaV1.parse({
      schemaVersion: 1,
      agentId,
      ...input.createProfile,
      ...((input.createProfile.references?.length ?? 0) > 0 || local.length > 0
        ? { references: [...(input.createProfile.references ?? []), ...local] }
        : {}),
    });
  }
  if (input.createProfileLocalReferences !== undefined) throw new Error("createProfileLocalReferences are allowed only for profile creation");
  if (!current) throw new Error(`canonical profile for '${input.agentName}' is missing`);
  if (input.operation === "set-enabled") {
    if (typeof input.enabled !== "boolean") throw new Error("enabled is required for set-enabled");
    return agentProfileSchemaV1.parse({
      ...current,
      lifecycle: { ...(current.lifecycle ?? {}), enabled: input.enabled },
    });
  }
  if (!input.patch || Object.keys(input.patch).length === 0) throw new Error("a non-empty canonical patch is required for edit");
  const target = agentProfileSchemaV1.parse({ ...current, ...structuredClone(input.patch), schemaVersion: 1, agentId: current.agentId });
  if (target.runtime.adapter !== current.runtime.adapter) {
    throw new Error("runtime adapter changes require an explicit authority migration");
  }
  return target;
}

/** Build the authority record for a canonical profile mutation under the transaction's txid. */
export function agentProfileAuthorityFor(
  agentName: string,
  profile: AgentProfileV1,
  sha256: string,
  prior: AgentProfileAuthorityRecord | undefined,
  txid: string,
  capabilityGrants?: readonly NonNullable<AgentProfileAuthorityRecord["capabilityGrants"]>[number][],
): AgentProfileAuthorityRecord {
  const inspector = profileRuntimeInspectorFor(profile.runtime.adapter);
  if (!prior && !inspector) throw new Error(`unsupported profile runtime adapter '${profile.runtime.adapter}'`);
  // t-26f508 (review) — preserving the prior inspector is what keeps an edit from silently
  // re-attesting to a contract the human never saw, and it is also why a bump used to be a one-way
  // door. Adoption is scoped to exactly that door: a prior descriptor listed as SUPERSEDED (strictly
  // stricter successor, same id) is replaced by the current one, so a profile created under the old
  // contract re-attests on its next lifecycle transaction instead of naming a stale inspector
  // forever. Anything else still carries `prior` through untouched.
  const adopt = prior && inspector && isSupersededRuntimeInspector(profile.runtime.adapter, prior.runtimeInspector);
  return {
    schemaVersion: 1,
    agentName,
    agentId: profile.agentId,
    revision: `lifecycle-${txid}`,
    canonicalSha256: sha256,
    runtimeInspector: prior && !adopt ? { ...prior.runtimeInspector } : { ...inspector! },
    // t-5498a6 — an explicit grant set REPLACES the carried-through one, including with an empty
    // array: that is how a revocation lands. Falling back to `prior` on empty would make the last
    // revocation of a profile silently fail to take, which is the one direction a capability must
    // never move by accident.
    ...(capabilityGrants
      ? (capabilityGrants.length > 0 ? { capabilityGrants: capabilityGrants.map((grant) => ({ ...grant })) } : {})
      : (prior?.capabilityGrants ? { capabilityGrants: prior.capabilityGrants.map((grant) => ({ ...grant })) } : {})),
  };
}

async function compensate(input: CommitAgentProfileLifecycleInput, txDir: string, journal: AgentProfileLifecycleJournal): Promise<void> {
  journal = transition(txDir, journal, "compensating", input.onPhase);
  try {
    // The COMPANION unwinds first: it was published last within its phase, so restoring in reverse
    // keeps every intermediate state one this machine can re-enter. Its prior profile always exists
    // (a companion must already have canonical state), so there is no create-shaped removal branch.
    if (journal.companion) {
      const c = journal.companion;
      const companionSha = currentProfileDigest(input.workspaceRoot, c.agentName);
      if (companionSha === c.targetProfileSha256) {
        const backup = readPrivateFile(path.join(txDir, COMPANION_BACKUP));
        if (digest(backup) !== c.priorProfileSha256) throw new Error("companion profile backup digest mismatch");
        replaceAgentProfileExact(input.workspaceRoot, c.agentName, c.targetProfileSha256, backup.toString("utf8"));
      } else if (companionSha !== c.priorProfileSha256) {
        throw new Error("companion profile changed outside lifecycle transaction");
      }
      const companionAuthority = await input.authority.read(c.agentName);
      if (sameAuthority(companionAuthority, c.targetAuthority)) {
        await input.authority.replace(c.priorAuthority, c.targetAuthority);
      } else if (!sameAuthority(companionAuthority, c.priorAuthority)) {
        throw new Error("companion authority changed outside lifecycle transaction");
      }
    }
    const profileSha = currentProfileDigest(input.workspaceRoot, input.agentName);
    if (profileSha === journal.targetProfileSha256) {
      if (journal.priorProfileSha256 === null) {
        restoreArtifactsExact(input.workspaceRoot, input.agentName, txDir, journal.targetArtifacts ?? []);
        removeAgentProfileIfExact(input.workspaceRoot, input.agentName, journal.targetProfileSha256);
      }
      else {
        // t-d185e1 — an EDIT can publish an artifact too. Restoring only the profile would strand a
        // created one: the rolled-back profile no longer pins it, so nothing would ever verify or
        // remove those bytes again. t-afc86e — and an artifact the edit REPLACED is put back from its
        // staged backup rather than removed, or a failed edit would delete content nobody asked to
        // lose.
        restoreArtifactsExact(input.workspaceRoot, input.agentName, txDir, journal.targetArtifacts ?? []);
        const backup = readPrivateFile(path.join(txDir, BACKUP));
        if (digest(backup) !== journal.priorProfileSha256) throw new Error("profile backup digest mismatch");
        replaceAgentProfileExact(input.workspaceRoot, input.agentName, journal.targetProfileSha256, backup.toString("utf8"));
      }
    } else if (profileSha !== journal.priorProfileSha256) throw new Error("profile changed outside lifecycle transaction");

    const authority = await input.authority.read(input.agentName);
    if (sameAuthority(authority, journal.targetAuthority)) {
      if (journal.priorAuthority) await input.authority.replace(journal.priorAuthority, journal.targetAuthority);
      else await input.authority.retire(input.agentName, journal.targetAuthority);
    } else if (!sameAuthority(authority, journal.priorAuthority)) throw new Error("authority changed outside lifecycle transaction");

    // t-ae221c — `tachyon.yml` is not part of the tuple any more, so there is nothing to restore
    // here and no `backup-tachyon.yml` to restore it from. The profile and the authority above ARE
    // the durable state; when both are back, the rollback has already succeeded.
    //
    // The t-07d05c tolerance went with it. It existed because rolling back the FIRST canonical agent
    // rewrote the config back to a roster with no agents, and a host reload of that shape could fail
    // after the durable restore was complete. This transaction no longer touches the file, so the
    // reload sees exactly the bytes it read before the transaction started; an empty roster is a
    // valid load (t-f67185) and reaching it needs no exception.
    input.activateState("prior");
    fs.rmSync(txDir, { recursive: true, force: true });
  } catch (error) {
    const degraded = { ...journal, phase: "degraded" as const, degradedReason: error instanceof Error ? error.message : String(error) };
    writeJournal(txDir, degraded);
    try { input.activateState("blocked"); } catch { /* journal remains the durable launch block */ }
    throw new Error(`agent profile lifecycle transaction degraded for '${input.agentName}': ${degraded.degradedReason}`);
  }
}

export async function commitAgentProfileLifecycle(input: CommitAgentProfileLifecycleInput): Promise<AgentProfileLifecycleCommitResult> {
  if (!isValidAgentName(input.agentName)) throw new Error("invalid agent name");
  const txid = crypto.randomUUID();
  // Both subjects under ONE txid. `acquireAgentProfileTransactionLocks` is the same helper the rename
  // transaction uses for its two names, so the ordering/deadlock question was answered before this.
  const release = input.companion
    ? acquireAgentProfileTransactionLocks(input.workspaceRoot, [input.agentName, input.companion.agentName], txid)
    : acquireAgentProfileTransactionLock(input.workspaceRoot, input.agentName, txid);
  let txDir: string | undefined;
  try {
    const canonical = savedAgentProfile(input.workspaceRoot, input.agentName);
    const priorAuthority = await input.authority.read(input.agentName);
    if (input.operation === "create") {
      // t-ae221c — one existence check, against the one record. The second one asked whether
      // `tachyon.yml` already carried a pointer, which could only disagree with this by being wrong.
      if (canonical) throw new Error(`agent '${input.agentName}' already has canonical state`);
    } else {
      if (!canonical || !priorAuthority) throw new Error(`agent '${input.agentName}' has incomplete canonical state`);
      const current = await inspectAgentProfileLifecycle(input);
      if (!input.expectedRevision || input.expectedRevision !== current.revision) {
        throw new AgentProfileRefusal("agent-profile/revision-conflict", `agent '${input.agentName}' profile revision conflict`);
      }
    }
    const createArtifacts = validateCreateArtifacts(input);
    const profile = targetProfile(input, canonical?.profile);
    const profileText = stringify(profile);
    const targetSha = digest(profileText);
    const targetAuthority = agentProfileAuthorityFor(
      input.agentName,
      profile,
      targetSha,
      input.operation === "create" ? undefined : priorAuthority,
      txid,
      input.capabilityGrants,
    );
    // The companion's target, built under the SAME lock as the main subject — which is also why its
    // CAS is a read here rather than an `expectedRevision` the caller carried in from earlier: there
    // is no interval between reading it and using it.
    let companion: {
      agentName: string;
      text: string;
      priorText: string;
      priorSha: string;
      targetSha: string;
      priorAuthority: AgentProfileAuthorityRecord;
      targetAuthority: AgentProfileAuthorityRecord;
    } | undefined;
    if (input.companion) {
      if (!isValidAgentName(input.companion.agentName)) throw new Error("invalid companion agent name");
      if (input.companion.agentName === input.agentName) throw new Error("companion must be a different agent");
      const companionCanonical = savedAgentProfile(input.workspaceRoot, input.companion.agentName);
      const companionPriorAuthority = await input.authority.read(input.companion.agentName);
      if (!companionCanonical || !companionPriorAuthority) {
        throw new Error(`agent '${input.companion.agentName}' has incomplete canonical state`);
      }
      const companionProfile: AgentProfileV1 = input.companion.ownership
        ? { ...companionCanonical.profile, ownership: input.companion.ownership }
        : (() => { const { ownership: _drop, ...rest } = companionCanonical.profile; return rest as AgentProfileV1; })();
      const companionText = stringify(companionProfile);
      const companionSha = digest(companionText);
      companion = {
        agentName: input.companion.agentName,
        text: companionText,
        priorText: companionCanonical.text,
        priorSha: companionCanonical.sha256,
        targetSha: companionSha,
        priorAuthority: companionPriorAuthority,
        // Same txid, so both records carry `revision: lifecycle-<txid>` — ratified 2026-07-29.
        targetAuthority: agentProfileAuthorityFor(input.companion.agentName, companionProfile, companionSha, companionPriorAuthority, txid),
      };
    }
    const root = ensureLifecycleRoot(input.workspaceRoot);
    txDir = path.join(root, txid);
    ensureSafeDirectory(input.workspaceRoot, txDir);
    writeNew(path.join(txDir, STAGED), profileText);
    // t-afc86e — stage the NEW bytes and, for any artifact that already exists, the OLD ones. Both
    // reads happen here, before anything is published, so the journal's `priorSha256` is a fact about
    // the tree this transaction started from rather than about whatever a later rollback happens to
    // find.
    const artifactRecords = artifactRecordsFor(input.workspaceRoot, input.agentName, canonical !== undefined, createArtifacts);
    if (createArtifacts.length > 0) {
      fs.mkdirSync(path.join(txDir, ARTIFACTS), { mode: 0o700 });
      for (const artifact of createArtifacts) writeNew(path.join(txDir, ARTIFACTS, artifact.path), artifact.text);
      const replaced = artifactRecords.filter((record) => record.priorSha256 !== undefined);
      if (replaced.length > 0) {
        fs.mkdirSync(path.join(txDir, ARTIFACT_BACKUPS), { mode: 0o700 });
        for (const record of replaced) {
          writeNew(path.join(txDir, ARTIFACT_BACKUPS, record.path), readExistingArtifact(input.workspaceRoot, input.agentName, record));
        }
      }
    }
    if (canonical) writeNew(path.join(txDir, BACKUP), canonical.text);
    if (companion) writeNew(path.join(txDir, COMPANION_BACKUP), companion.priorText);
    let journal: AgentProfileLifecycleJournal = {
      schemaVersion: SCHEMA_VERSION,
      txid,
      operation: input.operation,
      agentName: input.agentName,
      phase: "intent",
      createdAt: new Date().toISOString(),
      expectedRevision: input.expectedRevision ?? null,
      priorProfileSha256: canonical?.sha256 ?? null,
      targetProfileSha256: targetSha,
      priorAuthority: priorAuthority ? structuredClone(priorAuthority) : null,
      targetAuthority,
      ...(artifactRecords.length > 0 ? { targetArtifacts: artifactRecords } : {}),
      ...(companion ? {
        companion: {
          agentName: companion.agentName,
          priorProfileSha256: companion.priorSha,
          targetProfileSha256: companion.targetSha,
          priorAuthority: structuredClone(companion.priorAuthority),
          targetAuthority: companion.targetAuthority,
        },
      } : {}),
    };
    writeJournal(txDir, journal);
    try {
      journal = transition(txDir, journal, "staged", input.onPhase);
      if (canonical) replaceAgentProfileExact(input.workspaceRoot, input.agentName, canonical.sha256, profileText);
      else publishAgentProfile(input.workspaceRoot, input.agentName, profileText);
      publishArtifacts(input.workspaceRoot, input.agentName, txDir, journal.targetArtifacts ?? []);
      // The phase covers BOTH subjects, so compensation at this phase already knows to restore both.
      if (companion) replaceAgentProfileExact(input.workspaceRoot, companion.agentName, companion.priorSha, companion.text);
      journal = transition(txDir, journal, "profile-published", input.onPhase);
      if (priorAuthority) await input.authority.replace(targetAuthority, priorAuthority);
      else await input.authority.publish(targetAuthority, undefined);
      if (companion) await input.authority.replace(companion.targetAuthority, companion.priorAuthority);
      journal = transition(txDir, journal, "authority-published", input.onPhase);
      const snapshot = await inspectAgentProfileLifecycle(input);
      if (snapshot.profile.agentId !== profile.agentId || currentProfileDigest(input.workspaceRoot, input.agentName) !== targetSha) {
        throw new Error("lifecycle target tuple did not converge");
      }
      // The companion is part of the tuple, so a half-converged pair fails here rather than committing
      // and leaving the ownership edge silently absent.
      if (companion && currentProfileDigest(input.workspaceRoot, companion.agentName) !== companion.targetSha) {
        throw new Error("lifecycle companion tuple did not converge");
      }
      input.activateState("target");
      journal = transition(txDir, journal, "activated", input.onPhase);
      journal = transition(txDir, journal, "committed", input.onPhase);
      fs.rmSync(txDir, { recursive: true, force: true });
      return { txid, operation: input.operation, revision: snapshot.revision, snapshot };
    } catch (error) {
      const reread = readJournal(txDir);
      if (reread.phase !== "committed") await compensate(input, txDir, reread);
      throw error;
    }
  } finally {
    release();
  }
}

export async function reconcileAgentProfileLifecycle(input: {
  workspaceRoot: string;
  authority: AgentProfileAuthorityPort;
  activateState: (agentName: string, state: "target" | "prior" | "blocked") => void;
}): Promise<{ reconciled: string[]; degraded: string[] }> {
  const root = lifecycleRoot(input.workspaceRoot);
  try {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { reconciled: [], degraded: ["unsafe-root"] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reconciled: [], degraded: [] };
    return { reconciled: [], degraded: ["unsafe-root"] };
  }
  const reconciled: string[] = [];
  const degraded: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    const txDir = path.join(root, entry);
    try {
      requireSafeDirectory(input.workspaceRoot, txDir);
      const journal = readJournal(txDir);
      if (journal.phase === "degraded") { degraded.push(entry); continue; }
      // SDD 482 phase 4 — recovery holds BOTH subjects' locks when the journal has a companion.
      // Recovering under only the main lock would let a concurrent edit of the companion race the
      // restore this pass is about to perform.
      const release = journal.companion
        ? acquireAgentProfileRecoveryLocks(input.workspaceRoot, [journal.agentName, journal.companion.agentName], journal.txid)
        : acquireAgentProfileRecoveryLock(input.workspaceRoot, journal.agentName, journal.txid);
      try {
        const profileTarget = currentProfileDigest(input.workspaceRoot, journal.agentName) === journal.targetProfileSha256
          && artifactsMatch(input.workspaceRoot, journal.agentName, journal.targetArtifacts ?? []);
        const authorityTarget = sameAuthority(await input.authority.read(journal.agentName), journal.targetAuthority);
        // The companion is part of the target tuple. Without this, a crash that published the new
        // agent but not the ownership edge would look CONVERGED and commit — the exact half-state a
        // single transaction exists to make impossible.
        const companionTarget = !journal.companion || (
          currentProfileDigest(input.workspaceRoot, journal.companion.agentName) === journal.companion.targetProfileSha256
          && sameAuthority(await input.authority.read(journal.companion.agentName), journal.companion.targetAuthority)
        );
        if (profileTarget && authorityTarget && companionTarget) {
          input.activateState(journal.agentName, "target");
          const activated = transition(txDir, journal, "activated");
          transition(txDir, activated, "committed");
          fs.rmSync(txDir, { recursive: true, force: true });
        } else {
          await compensate({
            workspaceRoot: input.workspaceRoot,
            agentName: journal.agentName,
            operation: journal.operation,
            authority: input.authority,
            activateState: (state) => input.activateState(journal.agentName, state),
          }, txDir, journal);
        }
        reconciled.push(entry);
      } finally { release(); }
    } catch {
      degraded.push(entry);
    }
  }
  return { reconciled, degraded };
}

export function agentProfileLifecycleBlocked(workspaceRoot: string, agentName: string): boolean {
  const root = lifecycleRoot(workspaceRoot);
  try {
    return fs.readdirSync(root).some((entry) => {
      try {
        const journal = readJournal(path.join(root, entry));
        return journal.agentName.toLowerCase() === agentName.toLowerCase();
      } catch {
        return true;
      }
    });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
