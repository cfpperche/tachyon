import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument, stringify } from "yaml";
import { isValidAgentName } from "./nameValidation.js";
import { agentProfileSchemaV1, type AgentProfileV1 } from "./agentProfileSchema.js";
import type { AgentProfileAuthorityRecord } from "./agentProfileAuthority.js";
import {
  acquireAgentProfileTransactionLock,
  acquireAgentProfileRecoveryLock,
  agentProfileTransactionsRoot,
  currentProfileDigest,
  publishCanonicalProfile,
  removeCanonicalProfileIfExact,
  type AgentProfileMigrationAuthorityPort,
} from "./agentProfileMigration.js";
import { agentStanzaSourceSlice } from "./YamlConfigEditor.js";
import { canonicalAgentProfilePointer, scanAgentProfilePointers } from "./agentProfilePointer.js";
import { closeCanonicalAgentProfile, readCanonicalAgentProfile, verifiedDescriptorPath } from "./agentProfileReader.js";
import { CODEX_EMPTY_NATIVE_INPUT_INSPECTOR, PI_PRIVATE_CAPABILITY_INPUT_INSPECTOR } from "./agentProfileProjection.js";

const SCHEMA_VERSION = 1 as const;
const CANONICALIZATION_VERSION = 1 as const;
const LIFECYCLE_DIR = "lifecycle";
const JOURNAL = "journal.json";
const STAGED = "staged-agent.yml";
const BACKUP = "backup-agent.yml";
const DIGEST_RE = /^[a-f0-9]{64}$/;

export type AgentProfileLifecycleOperation = "create" | "edit" | "set-enabled";
export type AgentProfileLifecyclePhase =
  | "intent"
  | "staged"
  | "profile-published"
  | "authority-published"
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
  priorConfigSha256: string;
  targetConfigSha256: string;
  degradedReason?: string;
}

export interface AgentProfileLifecycleConfigPort {
  read(): string;
  /** Replace the full file only when its current digest equals expectedSha256. */
  replace(expectedSha256: string, text: string): void;
}

export interface AgentProfileLifecycleSnapshot {
  schemaVersion: 1;
  canonicalizationVersion: typeof CANONICALIZATION_VERSION;
  agentName: string;
  agentId: string;
  revision: string;
  profile: AgentProfileV1;
  provenance: {
    canonical: { scope: "profile"; writable: true; sha256: string };
    authority: { scope: "host"; writable: false; revision: string; grants: number };
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
  authority: AgentProfileMigrationAuthorityPort;
  config: AgentProfileLifecycleConfigPort;
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

function revisionOf(profileSha256: string, authority: AgentProfileAuthorityRecord, stanzaSha256: string): string {
  return digest(JSON.stringify({
    canonicalizationVersion: CANONICALIZATION_VERSION,
    profileSha256,
    authority,
    stanzaSha256,
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
    || typeof value.priorConfigSha256 !== "string" || !DIGEST_RE.test(value.priorConfigSha256)
    || typeof value.targetConfigSha256 !== "string" || !DIGEST_RE.test(value.targetConfigSha256)
    || !value.targetAuthority || typeof value.createdAt !== "string") throw new Error("invalid lifecycle journal schema");
  return value as AgentProfileLifecycleJournal;
}

function canonicalProfile(workspaceRoot: string, agentName: string): { profile: AgentProfileV1; text: string; sha256: string } | undefined {
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) return undefined;
  try {
    const doc = parseDocument(source.text, { uniqueKeys: true });
    if (doc.errors.length > 0) throw new Error(`canonical profile YAML is invalid: ${doc.errors[0]!.message}`);
    const parsed = agentProfileSchemaV1.safeParse(doc.toJS());
    if (!parsed.success) throw new Error(`canonical profile schema is invalid: ${parsed.error.issues[0]!.message}`);
    return { profile: parsed.data, text: source.text, sha256: source.sha256 };
  } finally {
    closeCanonicalAgentProfile(source);
  }
}

function pointerStanza(configText: string, agentName: string): { sha256: string } {
  const scan = scanAgentProfilePointers(configText);
  if (scan.errors.length > 0) throw new Error(scan.errors.join("; "));
  if (!scan.pointers.has(agentName)) throw new Error(`agents.${agentName}: canonical profile pointer is missing`);
  return { sha256: agentStanzaSourceSlice(configText, agentName).valueSha256 };
}

function addPointer(configText: string, agentName: string): string {
  const doc = parseDocument(configText, { uniqueKeys: true });
  if (doc.errors.length > 0) throw new Error(`tachyon.yml is invalid: ${doc.errors[0]!.message}`);
  if (doc.hasIn(["agents", agentName]) || doc.hasIn(["terminals", agentName])) throw new Error(`agent '${agentName}' already exists`);
  if (!doc.has("agents")) doc.set("agents", {});
  doc.setIn(["agents", agentName], { profile: canonicalAgentProfilePointer(agentName) });
  const text = String(doc);
  pointerStanza(text, agentName);
  return text;
}

function replaceCanonicalProfileExact(workspaceRoot: string, agentName: string, expectedSha256: string, text: string): void {
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
  authority: AgentProfileMigrationAuthorityPort;
  config: AgentProfileLifecycleConfigPort;
}): Promise<AgentProfileLifecycleSnapshot> {
  const canonical = canonicalProfile(input.workspaceRoot, input.agentName);
  if (!canonical) throw new Error(`canonical profile for '${input.agentName}' is missing`);
  const authority = await input.authority.read(input.agentName);
  if (!authority || authority.agentId !== canonical.profile.agentId || authority.canonicalSha256 !== canonical.sha256) {
    throw new Error(`canonical authority for '${input.agentName}' is missing or stale`);
  }
  const stanza = pointerStanza(input.config.read(), input.agentName);
  const revision = revisionOf(canonical.sha256, authority, stanza.sha256);
  return {
    schemaVersion: 1,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    agentName: input.agentName,
    agentId: canonical.profile.agentId,
    revision,
    profile: structuredClone(canonical.profile),
    provenance: {
      canonical: { scope: "profile", writable: true, sha256: canonical.sha256 },
      authority: { scope: "host", writable: false, revision: authority.revision, grants: authority.capabilityGrants?.length ?? 0 },
      learned: { scope: "profile", writable: false, present: canonical.profile.prompt?.evolution !== undefined },
      projection: { scope: "runtime", writable: false, active: canonical.profile.lifecycle?.enabled !== false },
    },
  };
}

function targetProfile(input: CommitAgentProfileLifecycleInput, current?: AgentProfileV1): AgentProfileV1 {
  if (input.operation === "create") {
    if (!input.createProfile) throw new Error("createProfile is required for create");
    return agentProfileSchemaV1.parse({ schemaVersion: 1, agentId: crypto.randomUUID(), ...input.createProfile });
  }
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

function authorityFor(agentName: string, profile: AgentProfileV1, sha256: string, prior: AgentProfileAuthorityRecord | undefined, txid: string): AgentProfileAuthorityRecord {
  const inspector = profile.runtime.adapter === "pi" ? PI_PRIVATE_CAPABILITY_INPUT_INSPECTOR : CODEX_EMPTY_NATIVE_INPUT_INSPECTOR;
  if (!prior && !["codex", "pi"].includes(profile.runtime.adapter)) throw new Error(`unsupported profile runtime adapter '${profile.runtime.adapter}'`);
  return {
    schemaVersion: 1,
    agentName,
    agentId: profile.agentId,
    revision: `lifecycle-${txid}`,
    canonicalSha256: sha256,
    runtimeInspector: prior ? { ...prior.runtimeInspector } : { ...inspector },
    ...(prior?.capabilityGrants ? { capabilityGrants: prior.capabilityGrants.map((grant) => ({ ...grant })) } : {}),
  };
}

async function compensate(input: CommitAgentProfileLifecycleInput, txDir: string, journal: AgentProfileLifecycleJournal): Promise<void> {
  journal = transition(txDir, journal, "compensating", input.onPhase);
  try {
    const profileSha = currentProfileDigest(input.workspaceRoot, input.agentName);
    if (profileSha === journal.targetProfileSha256) {
      if (journal.priorProfileSha256 === null) removeCanonicalProfileIfExact(input.workspaceRoot, input.agentName, journal.targetProfileSha256);
      else {
        const backup = readPrivateFile(path.join(txDir, BACKUP));
        if (digest(backup) !== journal.priorProfileSha256) throw new Error("profile backup digest mismatch");
        replaceCanonicalProfileExact(input.workspaceRoot, input.agentName, journal.targetProfileSha256, backup.toString("utf8"));
      }
    } else if (profileSha !== journal.priorProfileSha256) throw new Error("profile changed outside lifecycle transaction");

    const authority = await input.authority.read(input.agentName);
    if (sameAuthority(authority, journal.targetAuthority)) {
      if (journal.priorAuthority) await input.authority.replace(journal.priorAuthority, journal.targetAuthority);
      else await input.authority.retire(input.agentName, journal.targetAuthority);
    } else if (!sameAuthority(authority, journal.priorAuthority)) throw new Error("authority changed outside lifecycle transaction");

    const configText = input.config.read();
    const configSha = digest(configText);
    if (configSha === journal.targetConfigSha256 && journal.targetConfigSha256 !== journal.priorConfigSha256) {
      const prior = readPrivateFile(path.join(txDir, "backup-tachyon.yml")).toString("utf8");
      if (digest(prior) !== journal.priorConfigSha256) throw new Error("config backup digest mismatch");
      input.config.replace(journal.targetConfigSha256, prior);
    } else if (configSha !== journal.priorConfigSha256) throw new Error("config changed outside lifecycle transaction");
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
  const release = acquireAgentProfileTransactionLock(input.workspaceRoot, input.agentName, txid);
  let txDir: string | undefined;
  try {
    const configBefore = input.config.read();
    const canonical = canonicalProfile(input.workspaceRoot, input.agentName);
    const priorAuthority = await input.authority.read(input.agentName);
    if (input.operation === "create") {
      if (canonical || priorAuthority) throw new Error(`agent '${input.agentName}' already has canonical state`);
      const scan = scanAgentProfilePointers(configBefore);
      if (scan.pointers.has(input.agentName)) throw new Error(`agent '${input.agentName}' already has a profile pointer`);
    } else {
      if (!canonical || !priorAuthority) throw new Error(`agent '${input.agentName}' has incomplete canonical state`);
      const current = await inspectAgentProfileLifecycle(input);
      if (!input.expectedRevision || input.expectedRevision !== current.revision) throw new Error(`agent '${input.agentName}' profile revision conflict`);
    }
    const profile = targetProfile(input, canonical?.profile);
    const profileText = stringify(profile);
    const targetSha = digest(profileText);
    const targetAuthority = authorityFor(input.agentName, profile, targetSha, priorAuthority, txid);
    const configTarget = input.operation === "create" ? addPointer(configBefore, input.agentName) : configBefore;
    const root = ensureLifecycleRoot(input.workspaceRoot);
    txDir = path.join(root, txid);
    ensureSafeDirectory(input.workspaceRoot, txDir);
    writeNew(path.join(txDir, STAGED), profileText);
    writeNew(path.join(txDir, "backup-tachyon.yml"), configBefore);
    if (canonical) writeNew(path.join(txDir, BACKUP), canonical.text);
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
      priorConfigSha256: digest(configBefore),
      targetConfigSha256: digest(configTarget),
    };
    writeJournal(txDir, journal);
    try {
      journal = transition(txDir, journal, "staged", input.onPhase);
      if (canonical) replaceCanonicalProfileExact(input.workspaceRoot, input.agentName, canonical.sha256, profileText);
      else publishCanonicalProfile(input.workspaceRoot, input.agentName, profileText);
      journal = transition(txDir, journal, "profile-published", input.onPhase);
      if (priorAuthority) await input.authority.replace(targetAuthority, priorAuthority);
      else await input.authority.publish(targetAuthority, undefined);
      journal = transition(txDir, journal, "authority-published", input.onPhase);
      if (configTarget !== configBefore) input.config.replace(journal.priorConfigSha256, configTarget);
      journal = transition(txDir, journal, "locator-written", input.onPhase);
      const snapshot = await inspectAgentProfileLifecycle(input);
      if (snapshot.profile.agentId !== profile.agentId || currentProfileDigest(input.workspaceRoot, input.agentName) !== targetSha) {
        throw new Error("lifecycle target tuple did not converge");
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
  authority: AgentProfileMigrationAuthorityPort;
  config: AgentProfileLifecycleConfigPort;
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
      const release = acquireAgentProfileRecoveryLock(input.workspaceRoot, journal.agentName, journal.txid);
      try {
        const profileTarget = currentProfileDigest(input.workspaceRoot, journal.agentName) === journal.targetProfileSha256;
        const authorityTarget = sameAuthority(await input.authority.read(journal.agentName), journal.targetAuthority);
        const configTarget = digest(input.config.read()) === journal.targetConfigSha256;
        if (profileTarget && authorityTarget && configTarget) {
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
            config: input.config,
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
