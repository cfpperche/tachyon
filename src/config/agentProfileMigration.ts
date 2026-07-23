import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml, stringify } from "yaml";
import { parseConfig, type AgentDef } from "./loadConfig.js";
import { agentProfileSchemaV1, type AgentProfileV1 } from "./agentProfileSchema.js";
import {
  CODEX_EMPTY_NATIVE_INPUT_INSPECTOR,
  projectCanonicalAgentProfile,
} from "./agentProfileProjection.js";
import type { AgentProfileAuthorityRecord } from "./agentProfileAuthority.js";
import {
  agentStanzaSourceSlice,
  replaceAgentStanzaValue,
  type AgentStanzaSourceSlice,
} from "./YamlConfigEditor.js";
import { loadProfileAwareConfig } from "./agentProfileConfigLoader.js";
import {
  closeCanonicalAgentProfile,
  readAgentProfileReference,
  readCanonicalAgentProfile,
} from "./agentProfileReader.js";
import { asciiFoldAgentName } from "./nameValidation.js";

const SUPPORTED_KEYS = new Set([
  "cmd", "cwd", "env", "autostart", "watch", "attention", "restart", "kind", "role",
  "worktree", "branch", "isolate", "subagents", "selfEvolution",
]);

const DEFERRED_KEYS: Readonly<Record<string, string>> = {
  instructions: "persistent instructions are owned by t-a2827d",
  soul: "Soul is owned by t-a2827d",
  harness: "agent capabilities are owned by t-a34bb7",
  worktreeSetup: "worktree setup requires pinned profile references",
  verify: "verification requires a pinned profile reference",
};

export interface PlanLegacyAgentProfileMigrationInput {
  workspaceRoot: string;
  configText: string;
  agentName: string;
  /** Every legacy env key must be explicitly acknowledged as a non-secret value. */
  nonSecretEnv?: readonly string[];
  agentId?: string;
  authorityRevision?: string;
  currentAuthority?: AgentProfileAuthorityRecord;
  /** Host-authorized stable selector for an enabled legacy Evolution lane. */
  evolutionSelector?: {
    profileId: string;
    text: string;
    sha256: string;
  };
}

export interface LegacyAgentProfileMigrationPlan {
  agentName: string;
  agentId: string;
  source: AgentStanzaSourceSlice;
  originalDefinition: AgentDef;
  projectedDefinition: AgentDef;
  profile: AgentProfileV1;
  profileText: string;
  profileSha256: string;
  authority: AgentProfileAuthorityRecord;
  pointerValueText: string;
  artifacts: Array<{ path: string; text: string; sha256: string }>;
}

export type PlanLegacyAgentProfileMigrationResult =
  | { ok: true; plan: LegacyAgentProfileMigrationPlan }
  | { ok: false; blockers: string[]; unclassifiedEnv: string[] };

export const AGENT_PROFILE_MIGRATIONS_REL = ".tachyon/agent-profile-migrations";
export const AGENT_PROFILE_MIGRATION_SCHEMA_VERSION = 1 as const;
export type AgentProfileMigrationPhase =
  | "intent"
  | "staged"
  | "profile-published"
  | "authority-published"
  | "config-written"
  | "committed"
  | "rolling-back"
  | "rolled-back"
  | "degraded";

export interface AgentProfileMigrationJournal {
  schemaVersion: typeof AGENT_PROFILE_MIGRATION_SCHEMA_VERSION;
  txid: string;
  agentName: string;
  phase: AgentProfileMigrationPhase;
  createdAt: string;
  priorConfigSha256: string;
  priorStanzaSha256: string;
  targetStanzaSha256: string;
  profileSha256: string;
  authority: AgentProfileAuthorityRecord;
  artifacts?: Array<{ path: string; sha256: string }>;
  degradedReason?: string;
}

export interface AgentProfileMigrationAuthorityPort {
  read(agentName: string): Promise<AgentProfileAuthorityRecord | undefined>;
  publish(record: AgentProfileAuthorityRecord, expected: undefined): Promise<void>;
  replace(record: AgentProfileAuthorityRecord, expected: AgentProfileAuthorityRecord): Promise<void>;
  retire(agentName: string, expected: AgentProfileAuthorityRecord): Promise<void>;
  /** Atomically remove the exact source record and publish the exact renamed target. */
  move?(
    oldAgentName: string,
    newAgentName: string,
    expected: AgentProfileAuthorityRecord,
    target: AgentProfileAuthorityRecord,
  ): Promise<void>;
}

export interface CommitLegacyAgentProfileMigrationInput {
  workspaceRoot: string;
  configPath: string;
  plan: LegacyAgentProfileMigrationPlan;
  authority: AgentProfileMigrationAuthorityPort;
  homeDir?: string;
  assertStopped?: (agentName: string) => Promise<void>;
  onPhase?: (phase: AgentProfileMigrationPhase) => void;
}

export interface AgentProfileMigrationResult {
  txid: string;
  phase: "committed" | "rolled-back";
  agentName: string;
}

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function agentProfileTransactionsRoot(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), AGENT_PROFILE_MIGRATIONS_REL);
}

function ensureMigrationsRoot(workspaceRoot: string): string {
  const root = agentProfileTransactionsRoot(workspaceRoot);
  for (const directory of [path.dirname(root), root, path.join(root, "locks")]) {
    try { ensureSafeDirectory(workspaceRoot, directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; requireSafeDirectory(workspaceRoot, directory); }
  }
  return root;
}

function migrationLockPath(root: string, agentName: string): string {
  const key = Buffer.from(asciiFoldAgentName(agentName), "utf8").toString("hex");
  return path.join(root, "locks", `${key}.lock`);
}

interface MigrationLockRecord { txid: string; pid: number }

function readMigrationLock(root: string, agentName: string): MigrationLockRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(migrationLockPath(root, agentName), "utf8")) as Partial<MigrationLockRecord>;
    if (typeof value.txid !== "string" || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid < 1) {
      throw new Error(`invalid agent profile migration lock for '${agentName}'`);
    }
    return value as MigrationLockRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function acquireMigrationLock(root: string, agentName: string, txid: string): () => void {
  const file = migrationLockPath(root, agentName);
  const record: MigrationLockRecord = { txid, pid: process.pid };
  try {
    writeNewDurable(file, `${JSON.stringify(record)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`agent profile migration for '${agentName}' is already active`);
    }
    throw error;
  }
  return () => {
    const current = readMigrationLock(root, agentName);
    if (!current || current.txid !== txid || current.pid !== process.pid) throw new Error(`agent profile migration lock changed for '${agentName}'`);
    fs.unlinkSync(file);
    syncDirectory(path.dirname(file));
  };
}

/** Shared durable admission lock for migration and canonical lifecycle mutations. */
export function acquireAgentProfileTransactionLock(workspaceRoot: string, agentName: string, txid: string): () => void {
  return acquireMigrationLock(ensureMigrationsRoot(workspaceRoot), agentName, txid);
}

/** Acquire every name in one canonical order so opposing renames cannot deadlock. */
export function acquireAgentProfileTransactionLocks(
  workspaceRoot: string,
  agentNames: readonly string[],
  txid: string,
): () => void {
  const names = [...new Map(agentNames.map((name) => [asciiFoldAgentName(name), name])).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, name]) => name);
  const releases: Array<() => void> = [];
  try {
    for (const name of names) releases.push(acquireAgentProfileTransactionLock(workspaceRoot, name, txid));
  } catch (error) {
    for (const release of releases.reverse()) release();
    throw error;
  }
  return () => {
    for (const release of releases.reverse()) release();
  };
}

export function acquireAgentProfileRecoveryLock(workspaceRoot: string, agentName: string, txid: string): () => void {
  const root = ensureMigrationsRoot(workspaceRoot);
  releaseRecoveredMigrationLock(root, agentName, txid);
  return acquireMigrationLock(root, agentName, txid);
}

export function acquireAgentProfileRecoveryLocks(
  workspaceRoot: string,
  agentNames: readonly string[],
  txid: string,
): () => void {
  const names = [...new Map(agentNames.map((name) => [asciiFoldAgentName(name), name])).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, name]) => name);
  const releases: Array<() => void> = [];
  try {
    for (const name of names) releases.push(acquireAgentProfileRecoveryLock(workspaceRoot, name, txid));
  } catch (error) {
    for (const release of releases.reverse()) release();
    throw error;
  }
  return () => {
    for (const release of releases.reverse()) release();
  };
}

function releaseRecoveredMigrationLock(root: string, agentName: string, txid: string): void {
  const current = readMigrationLock(root, agentName);
  if (!current) return;
  if (current.txid !== txid) throw new Error(`agent profile migration lock belongs to another transaction for '${agentName}'`);
  if (current.pid !== process.pid && processAlive(current.pid)) {
    throw new Error(`agent profile migration for '${agentName}' is active in process ${current.pid}`);
  }
  fs.unlinkSync(migrationLockPath(root, agentName));
  syncDirectory(path.join(root, "locks"));
}

function journalFile(txDir: string): string { return path.join(txDir, "journal.json"); }
function backupStanzaFile(txDir: string): string { return path.join(txDir, "backup-stanza.yml"); }
function stagedProfileFile(txDir: string): string { return path.join(txDir, "staged-agent.yml"); }

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

function requireSafeDirectory(workspaceRoot: string, directory: string): void {
  const workspaceReal = fs.realpathSync.native(path.resolve(workspaceRoot));
  const expected = path.join(workspaceReal, path.relative(path.resolve(workspaceRoot), directory));
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(directory) !== expected) {
    throw new Error(`unsafe migration directory: ${directory}`);
  }
}

function ensureSafeDirectory(workspaceRoot: string, directory: string): void {
  fs.mkdirSync(directory, { mode: 0o700 });
  requireSafeDirectory(workspaceRoot, directory);
  syncDirectory(path.dirname(directory));
}

function writeNewDurable(file: string, bytes: string | Buffer): void {
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(path.dirname(file));
}

function descriptorPath(fd: number): string {
  const expected = fs.fstatSync(fd, { bigint: true });
  for (const base of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = `${base}/${fd}`;
    try {
      const actual = fs.statSync(candidate, { bigint: true });
      if (actual.dev === expected.dev && actual.ino === expected.ino) return candidate;
    } catch {
      // Try the next host-supported descriptor filesystem.
    }
  }
  throw new Error("host has no verified descriptor-relative filesystem path");
}

function openProfileDirectory(workspaceRoot: string, agentName: string): { fd: number; close(): void } {
  const noFollow = fs.constants.O_NOFOLLOW;
  const directory = fs.constants.O_DIRECTORY;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (typeof noFollow !== "number" || typeof directory !== "number" || typeof nonBlock !== "number") {
    throw new Error("host does not support no-follow profile publication");
  }
  const opened: number[] = [];
  try {
    let current = fs.openSync(fs.realpathSync.native(workspaceRoot), fs.constants.O_RDONLY | directory | noFollow | nonBlock);
    opened.push(current);
    for (const segment of [".tachyon", "agents", agentName]) {
      current = fs.openSync(`${descriptorPath(current)}/${segment}`, fs.constants.O_RDONLY | directory | noFollow | nonBlock);
      if (!fs.fstatSync(current).isDirectory()) throw new Error(`profile path component is not a directory: ${segment}`);
      opened.push(current);
    }
    const retained = opened.pop()!;
    return {
      fd: retained,
      close: () => {
        fs.closeSync(retained);
        for (const fd of opened.reverse()) fs.closeSync(fd);
      },
    };
  } catch (error) {
    for (const fd of opened.reverse()) {
      try { fs.closeSync(fd); } catch { /* preserve failure */ }
    }
    throw error;
  }
}

function writeJournal(txDir: string, journal: AgentProfileMigrationJournal): void {
  const file = journalFile(txDir);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    writeNewDurable(temporary, `${JSON.stringify(journal, null, 2)}\n`);
    fs.renameSync(temporary, file);
    syncDirectory(txDir);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
  }
}

function transition(
  txDir: string,
  journal: AgentProfileMigrationJournal,
  phase: AgentProfileMigrationPhase,
  onPhase?: (phase: AgentProfileMigrationPhase) => void,
): AgentProfileMigrationJournal {
  const next = { ...journal, phase };
  writeJournal(txDir, next);
  onPhase?.(phase);
  return next;
}

interface FileSnapshot {
  text: string;
  stat: fs.BigIntStats;
}

function readRegularFileSnapshot(file: string): FileSnapshot {
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error(`${file} is not a regular file`);
    const text = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error(`${file} changed during read`);
    }
    return { text, stat: after };
  } finally {
    fs.closeSync(fd);
  }
}

function sameRevision(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function atomicReplaceIfUnchanged(file: string, snapshot: FileSnapshot, nextText: string): void {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    writeNewDurable(temporary, nextText);
    const current = fs.statSync(file, { bigint: true });
    if (!sameRevision(snapshot.stat, current)) throw new Error(`${file} changed before commit`);
    fs.chmodSync(temporary, Number(snapshot.stat.mode & 0o777n));
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
  }
}

/** No-follow config access shared by migration and lifecycle mutations. */
export function readAgentProfileConfigText(file: string): string {
  return readRegularFileSnapshot(file).text;
}

export function replaceAgentProfileConfigIfDigest(file: string, expectedSha256: string, nextText: string): void {
  const snapshot = readRegularFileSnapshot(file);
  if (digest(snapshot.text) !== expectedSha256) throw new Error(`${file} changed (CAS mismatch)`);
  atomicReplaceIfUnchanged(file, snapshot, nextText);
}

function sameAuthority(left: AgentProfileAuthorityRecord | undefined, right: AgentProfileAuthorityRecord): boolean {
  return left !== undefined && isDeepStrictEqual(left, right);
}

function plainAgentStanza(configText: string, agentName: string): Record<string, unknown> | undefined {
  const raw = parseYaml(configText) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const agents = (raw as Record<string, unknown>).agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return undefined;
  const stanza = (agents as Record<string, unknown>)[agentName];
  return stanza && typeof stanza === "object" && !Array.isArray(stanza)
    ? stanza as Record<string, unknown>
    : undefined;
}

function buildProfile(
  agentId: string,
  definition: AgentDef,
  evolutionSelector?: PlanLegacyAgentProfileMigrationInput["evolutionSelector"],
): AgentProfileV1 {
  const profile: Record<string, unknown> = {
    schemaVersion: 1,
    agentId,
    runtime: { adapter: "codex", executable: "codex" },
  };
  if (definition.env && Object.keys(definition.env).length > 0) {
    profile.environment = { values: { ...definition.env } };
  }
  if (definition.role || definition.selfEvolution?.enabled) {
    profile.prompt = {
      ...(definition.role ? { role: definition.role } : {}),
      ...(definition.selfEvolution?.enabled ? { evolution: "evolution" } : {}),
    };
  }
  if (definition.selfEvolution?.enabled) {
    if (!evolutionSelector) throw new Error("enabled Agent Evolution requires a host-authorized selector");
    profile.references = [{
      id: "evolution",
      kind: "evolution",
      scope: "profile",
      owner: agentId,
      path: "evolution-selector.json",
      mode: "pinned",
      sha256: evolutionSelector.sha256,
    }];
  }

  const lifecycle: Record<string, unknown> = {};
  if (definition.autostart) lifecycle.autostart = true;
  if (definition.watch.length > 0) lifecycle.watch = [...definition.watch];
  if (!definition.attention.enabled || definition.attention.silenceSec !== 8 || definition.attention.patterns.length > 0) {
    lifecycle.attention = {
      enabled: definition.attention.enabled,
      silenceSec: definition.attention.silenceSec,
      ...(definition.attention.patterns.length > 0 ? { patterns: [...definition.attention.patterns] } : {}),
    };
  }
  if (definition.restart !== "never") lifecycle.restart = definition.restart;
  if (Object.keys(lifecycle).length > 0) profile.lifecycle = lifecycle;

  const workspace: Record<string, unknown> = {};
  if (definition.cwd) workspace.cwd = definition.cwd;
  if (definition.worktree !== undefined || definition.branch) {
    workspace.worktree = {
      ...(definition.worktree !== undefined ? { enabled: definition.worktree } : {}),
      ...(definition.branch ? { branch: definition.branch } : {}),
    };
  }
  if (Object.keys(workspace).length > 0) profile.workspace = workspace;
  if (definition.isolate) profile.isolation = definition.isolate;
  if (definition.subagents) profile.ownership = { subagents: [...definition.subagents] };
  return agentProfileSchemaV1.parse(profile);
}

function prospectiveProjection(
  agentName: string,
  profileText: string,
  authority: AgentProfileAuthorityRecord,
  artifacts: readonly { path: string; text: string }[] = [],
): AgentDef | string[] {
  const preflight = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-agent-profile-migration-preflight-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-agent-profile-migration-home-"));
  try {
    const directory = path.join(preflight, ".tachyon", "agents", agentName);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "agent.yml"), profileText, { mode: 0o600 });
    for (const artifact of artifacts) fs.writeFileSync(path.join(directory, artifact.path), artifact.text, { mode: 0o600 });
    const result = projectCanonicalAgentProfile({
      workspaceRoot: preflight,
      agentName,
      authority,
      homeDir: home,
    });
    if (!result.ok) return result.errors;
    return runtimeBehaviorDefinition(result.definition);
  } finally {
    fs.rmSync(preflight, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runtimeBehaviorDefinition(definition: AgentDef): AgentDef {
  const {
    profileCapabilities: _profileCapabilities,
    profileLifecycle: _profileLifecycle,
    profileEvolution: _profileEvolution,
    ...publicDefinition
  } = definition;
  return publicDefinition;
}

export function planLegacyAgentProfileMigration(
  input: PlanLegacyAgentProfileMigrationInput,
): PlanLegacyAgentProfileMigrationResult {
  const blockers: string[] = [];
  const parsed = parseConfig(input.configText);
  blockers.push(...parsed.errors);
  const originalDefinition = parsed.config?.agents[input.agentName];
  if (!originalDefinition) blockers.push(`agents.${input.agentName}: legacy agent is not loadable`);

  let source: AgentStanzaSourceSlice | undefined;
  try {
    source = agentStanzaSourceSlice(input.configText, input.agentName);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }
  const stanza = plainAgentStanza(input.configText, input.agentName);
  if (!stanza) blockers.push(`agents.${input.agentName}: stanza is not a plain mapping`);
  if (stanza) {
    for (const key of Object.keys(stanza)) {
      if (DEFERRED_KEYS[key]) blockers.push(`agents.${input.agentName}.${key}: ${DEFERRED_KEYS[key]}`);
      else if (!SUPPORTED_KEYS.has(key)) blockers.push(`agents.${input.agentName}.${key}: unsupported migration field`);
    }
  }
  if (originalDefinition?.kind !== "agent") blockers.push(`agents.${input.agentName}: only AI agent entries are migratable`);
  if (originalDefinition?.cmd !== "codex") {
    blockers.push(`agents.${input.agentName}.cmd: V1 migration supports only the exact literal 'codex' command`);
  }
  const envKeys = Object.keys(originalDefinition?.env ?? {}).sort();
  const classified = [...new Set(input.nonSecretEnv ?? [])].sort();
  if (!isDeepStrictEqual(envKeys, classified)) {
    blockers.push(`agents.${input.agentName}.env: classify every key explicitly as non-secret (expected: ${envKeys.join(", ") || "none"})`);
  }
  if (input.currentAuthority) blockers.push(`agents.${input.agentName}: host profile authority already exists`);
  if (originalDefinition?.selfEvolution?.enabled && !input.evolutionSelector) {
    blockers.push(`agents.${input.agentName}.selfEvolution: host-authorized Evolution selector is unavailable`);
  }
  if (!originalDefinition?.selfEvolution?.enabled && input.evolutionSelector) {
    blockers.push(`agents.${input.agentName}.selfEvolution: selector supplied for a disabled Evolution lane`);
  }
  if (input.evolutionSelector && digest(input.evolutionSelector.text) !== input.evolutionSelector.sha256) {
    blockers.push(`agents.${input.agentName}.selfEvolution: selector digest mismatch`);
  }
  const canonicalPath = path.join(input.workspaceRoot, ".tachyon", "agents", input.agentName, "agent.yml");
  try {
    fs.lstatSync(canonicalPath);
    blockers.push(`agents.${input.agentName}: canonical agent.yml already exists`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") blockers.push(`agents.${input.agentName}: cannot prove canonical agent.yml absence`);
  }
  if (blockers.length > 0 || !originalDefinition || !source) return { ok: false, blockers, unclassifiedEnv: envKeys.filter((key) => !classified.includes(key)) };

  const agentId = input.agentId ?? crypto.randomUUID();
  let profile: AgentProfileV1;
  try {
    profile = buildProfile(agentId, originalDefinition, input.evolutionSelector);
  } catch (error) {
    return { ok: false, blockers: [`agents.${input.agentName}: canonical projection failed: ${error instanceof Error ? error.message : String(error)}`], unclassifiedEnv: [] };
  }
  const profileText = stringify(profile);
  const profileSha256 = digest(profileText);
  const authority: AgentProfileAuthorityRecord = {
    schemaVersion: 1,
    agentName: input.agentName,
    agentId,
    revision: input.authorityRevision ?? `migration-${profileSha256.slice(0, 16)}`,
    canonicalSha256: profileSha256,
    runtimeInspector: { ...CODEX_EMPTY_NATIVE_INPUT_INSPECTOR },
  };
  const artifacts = input.evolutionSelector
    ? [{ path: "evolution-selector.json", text: input.evolutionSelector.text, sha256: input.evolutionSelector.sha256 }]
    : [];
  const projection = prospectiveProjection(input.agentName, profileText, authority, artifacts);
  if (Array.isArray(projection)) return { ok: false, blockers: projection, unclassifiedEnv: [] };
  if (!isDeepStrictEqual(originalDefinition, projection)) {
    return { ok: false, blockers: [`agents.${input.agentName}: normalized before/after definitions are not equivalent`], unclassifiedEnv: [] };
  }
  return {
    ok: true,
    plan: {
      agentName: input.agentName,
      agentId,
      source,
      originalDefinition,
      projectedDefinition: projection,
      profile,
      profileText,
      profileSha256,
      authority,
      pointerValueText: `profile: .tachyon/agents/${input.agentName}/agent.yml\n`,
      artifacts,
    },
  };
}

export function currentProfileDigest(workspaceRoot: string, agentName: string): string | null {
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) return null;
  try {
    return source.sha256;
  } finally {
    closeCanonicalAgentProfile(source);
  }
}

export function publishCanonicalProfile(workspaceRoot: string, agentName: string, profileText: string): void {
  const tachyon = path.join(workspaceRoot, ".tachyon");
  const agents = path.join(tachyon, "agents");
  const principal = path.join(agents, agentName);
  for (const directory of [tachyon, agents, principal]) {
    try {
      ensureSafeDirectory(workspaceRoot, directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      requireSafeDirectory(workspaceRoot, directory);
    }
  }
  const retained = openProfileDirectory(workspaceRoot, agentName);
  try {
    writeNewDurable(`${descriptorPath(retained.fd)}/agent.yml`, profileText);
  } finally {
    retained.close();
  }
}

function publishMigrationArtifacts(
  workspaceRoot: string,
  agentName: string,
  artifacts: readonly { path: string; text: string }[],
): void {
  if (artifacts.length === 0) return;
  const retained = openProfileDirectory(workspaceRoot, agentName);
  try {
    for (const artifact of artifacts) writeNewDurable(`${descriptorPath(retained.fd)}/${artifact.path}`, artifact.text);
  } finally {
    retained.close();
  }
}

function removeMigrationArtifactsExact(
  workspaceRoot: string,
  agentName: string,
  artifacts: readonly { path: string; sha256: string }[],
): void {
  if (artifacts.length === 0) return;
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) return;
  try {
    for (const artifact of artifacts) {
      const file = `${descriptorPath(source.profileDirectoryFd)}/${artifact.path}`;
      try { fs.lstatSync(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      readAgentProfileReference(source, artifact.path, artifact.sha256);
      fs.unlinkSync(file);
    }
    syncDirectory(descriptorPath(source.profileDirectoryFd));
  } finally {
    closeCanonicalAgentProfile(source);
  }
}

export function removeCanonicalProfileIfExact(workspaceRoot: string, agentName: string, expectedSha256: string): void {
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) return;
  try {
    if (source.sha256 !== expectedSha256) throw new Error(`canonical profile for '${agentName}' changed outside the migration`);
    fs.unlinkSync(`${descriptorPath(source.profileDirectoryFd)}/agent.yml`);
    syncDirectory(descriptorPath(source.profileDirectoryFd));
  } finally {
    closeCanonicalAgentProfile(source);
  }
}

function readJournal(txDir: string): AgentProfileMigrationJournal {
  const snapshot = readRegularFileSnapshot(journalFile(txDir));
  const parsed = JSON.parse(snapshot.text) as Partial<AgentProfileMigrationJournal>;
  if (parsed.schemaVersion !== AGENT_PROFILE_MIGRATION_SCHEMA_VERSION
    || parsed.txid !== path.basename(txDir)
    || typeof parsed.agentName !== "string"
    || typeof parsed.phase !== "string"
    || typeof parsed.priorConfigSha256 !== "string"
    || typeof parsed.priorStanzaSha256 !== "string"
    || typeof parsed.targetStanzaSha256 !== "string"
    || typeof parsed.profileSha256 !== "string"
    || !parsed.authority) {
    throw new Error(`invalid agent profile migration journal: ${txDir}`);
  }
  return parsed as AgentProfileMigrationJournal;
}

async function compensateIncompleteMigration(
  input: Pick<CommitLegacyAgentProfileMigrationInput, "workspaceRoot" | "configPath" | "authority">,
  txDir: string,
  journal: AgentProfileMigrationJournal,
): Promise<AgentProfileMigrationJournal> {
  try {
    const config = readRegularFileSnapshot(input.configPath);
    const stanza = agentStanzaSourceSlice(config.text, journal.agentName);
    if (stanza.valueSha256 === journal.targetStanzaSha256) {
      const backup = fs.readFileSync(backupStanzaFile(txDir), "utf8");
      if (digest(backup) !== journal.priorStanzaSha256) throw new Error("backup stanza digest mismatch");
      const restored = replaceAgentStanzaValue(config.text, journal.agentName, journal.targetStanzaSha256, backup);
      atomicReplaceIfUnchanged(input.configPath, config, restored.text);
    } else if (stanza.valueSha256 !== journal.priorStanzaSha256) {
      throw new Error("affected config stanza changed outside the migration");
    }

    const authority = await input.authority.read(journal.agentName);
    if (sameAuthority(authority, journal.authority)) {
      await input.authority.retire(journal.agentName, journal.authority);
    } else if (authority !== undefined) {
      throw new Error("profile authority changed outside the migration");
    }
    removeMigrationArtifactsExact(input.workspaceRoot, journal.agentName, journal.artifacts ?? []);
    removeCanonicalProfileIfExact(input.workspaceRoot, journal.agentName, journal.profileSha256);
    return transition(txDir, journal, "rolled-back");
  } catch (error) {
    const degraded: AgentProfileMigrationJournal = {
      ...journal,
      phase: "degraded",
      degradedReason: error instanceof Error ? error.message : String(error),
    };
    writeJournal(txDir, degraded);
    throw error;
  }
}

export async function commitLegacyAgentProfileMigration(
  input: CommitLegacyAgentProfileMigrationInput,
): Promise<AgentProfileMigrationResult> {
  await input.assertStopped?.(input.plan.agentName);
  const root = ensureMigrationsRoot(input.workspaceRoot);
  const txid = crypto.randomUUID();
  const release = acquireMigrationLock(root, input.plan.agentName, txid);
  try {
    const existingAuthority = await input.authority.read(input.plan.agentName);
    if (existingAuthority !== undefined) throw new Error(`host profile authority already exists for '${input.plan.agentName}'`);
    if (currentProfileDigest(input.workspaceRoot, input.plan.agentName) !== null) {
      throw new Error(`canonical agent.yml already exists for '${input.plan.agentName}'`);
    }
    const config = readRegularFileSnapshot(input.configPath);
    const currentStanza = agentStanzaSourceSlice(config.text, input.plan.agentName);
    if (currentStanza.valueSha256 !== input.plan.source.valueSha256) {
      throw new Error(`agents.${input.plan.agentName}: affected stanza changed since dry-run`);
    }
    const patched = replaceAgentStanzaValue(
      config.text,
      input.plan.agentName,
      currentStanza.valueSha256,
      input.plan.pointerValueText,
    );
    const txDir = path.join(root, txid);
    ensureSafeDirectory(input.workspaceRoot, txDir);
    writeNewDurable(backupStanzaFile(txDir), currentStanza.valueText);
    writeNewDurable(stagedProfileFile(txDir), input.plan.profileText);
    let journal: AgentProfileMigrationJournal = {
      schemaVersion: AGENT_PROFILE_MIGRATION_SCHEMA_VERSION,
      txid,
      agentName: input.plan.agentName,
      phase: "intent",
      createdAt: new Date().toISOString(),
      priorConfigSha256: digest(config.text),
      priorStanzaSha256: currentStanza.valueSha256,
      targetStanzaSha256: patched.next.valueSha256,
      profileSha256: input.plan.profileSha256,
      authority: input.plan.authority,
      artifacts: input.plan.artifacts.map(({ path: artifactPath, sha256 }) => ({ path: artifactPath, sha256 })),
    };
    writeJournal(txDir, journal);
    try {
      journal = transition(txDir, journal, "staged", input.onPhase);
      publishCanonicalProfile(input.workspaceRoot, input.plan.agentName, input.plan.profileText);
      publishMigrationArtifacts(input.workspaceRoot, input.plan.agentName, input.plan.artifacts);
      journal = transition(txDir, journal, "profile-published", input.onPhase);
      await input.authority.publish(input.plan.authority, undefined);
      journal = transition(txDir, journal, "authority-published", input.onPhase);

      const preflight = loadProfileAwareConfig({
        yamlText: patched.text,
        workspaceRoot: input.workspaceRoot,
        authorities: new Map([[input.plan.agentName, input.plan.authority]]),
        homeDir: input.homeDir,
      });
      if (!preflight.config || preflight.errors.length > 0) {
        throw new Error(`prospective trusted reload failed: ${preflight.errors.join("; ")}`);
      }
      if (!isDeepStrictEqual(
        runtimeBehaviorDefinition(preflight.config.agents[input.plan.agentName]!),
        input.plan.originalDefinition,
      )) {
        throw new Error("prospective trusted reload changed normalized runtime behavior");
      }
      atomicReplaceIfUnchanged(input.configPath, config, patched.text);
      journal = transition(txDir, journal, "config-written", input.onPhase);
      const committedConfig = readRegularFileSnapshot(input.configPath).text;
      const committedStanza = agentStanzaSourceSlice(committedConfig, input.plan.agentName);
      if (committedStanza.valueSha256 !== journal.targetStanzaSha256
        || currentProfileDigest(input.workspaceRoot, input.plan.agentName) !== journal.profileSha256
        || !sameAuthority(await input.authority.read(input.plan.agentName), journal.authority)) {
        throw new Error("complete migration target tuple did not converge");
      }
      journal = transition(txDir, journal, "committed", input.onPhase);
      return { txid, phase: "committed", agentName: journal.agentName };
    } catch (error) {
      if (journal.phase !== "committed") await compensateIncompleteMigration(input, txDir, journal);
      throw error;
    }
  } finally {
    release();
  }
}

export async function rollbackLegacyAgentProfileMigration(
  input: Pick<CommitLegacyAgentProfileMigrationInput, "workspaceRoot" | "configPath" | "authority" | "assertStopped"> & { txid: string },
): Promise<AgentProfileMigrationResult> {
  const root = ensureMigrationsRoot(input.workspaceRoot);
  const txDir = path.join(root, input.txid);
  requireSafeDirectory(input.workspaceRoot, txDir);
  let journal = readJournal(txDir);
  if (journal.phase !== "committed") throw new Error(`migration '${input.txid}' is not safely rollbackable (${journal.phase})`);
  await input.assertStopped?.(journal.agentName);
  const release = acquireMigrationLock(root, journal.agentName, input.txid);
  try {
    journal = readJournal(txDir);
    if (journal.phase !== "committed") throw new Error(`migration '${input.txid}' changed before rollback (${journal.phase})`);
    const config = readRegularFileSnapshot(input.configPath);
    const stanza = agentStanzaSourceSlice(config.text, journal.agentName);
    if (stanza.valueSha256 !== journal.targetStanzaSha256) throw new Error("affected config stanza changed after migration");
    if (currentProfileDigest(input.workspaceRoot, journal.agentName) !== journal.profileSha256) {
      throw new Error("canonical profile changed after migration");
    }
    if (!sameAuthority(await input.authority.read(journal.agentName), journal.authority)) {
      throw new Error("profile authority changed after migration");
    }
    journal = transition(txDir, journal, "rolling-back");
    return {
      txid: input.txid,
      phase: (await compensateIncompleteMigration(input, txDir, journal)).phase as "rolled-back",
      agentName: journal.agentName,
    };
  } finally {
    release();
  }
}

export async function reconcileAgentProfileMigrations(
  input: Pick<CommitLegacyAgentProfileMigrationInput, "workspaceRoot" | "configPath" | "authority">,
): Promise<{ reconciled: string[]; degraded: string[] }> {
  const root = agentProfileTransactionsRoot(input.workspaceRoot);
  try { requireSafeDirectory(input.workspaceRoot, root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reconciled: [], degraded: [] };
    return { reconciled: [], degraded: ["unsafe-root"] };
  }
  const reconciled: string[] = [];
  const degraded: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (["locks", "lifecycle", "rename", "forget"].includes(entry)) continue;
    const txDir = path.join(root, entry);
    try {
      requireSafeDirectory(input.workspaceRoot, txDir);
      let journal = readJournal(txDir);
      const lock = readMigrationLock(root, journal.agentName);
      if (lock && lock.txid !== journal.txid) throw new Error("migration lock belongs to another transaction");
      if (lock && lock.pid !== process.pid && processAlive(lock.pid)) continue;
      if (["committed", "rolled-back"].includes(journal.phase)) {
        releaseRecoveredMigrationLock(root, journal.agentName, journal.txid);
        continue;
      }
      if (journal.phase === "degraded") { degraded.push(entry); continue; }
      const config = readRegularFileSnapshot(input.configPath);
      const stanza = agentStanzaSourceSlice(config.text, journal.agentName);
      const profileMatches = currentProfileDigest(input.workspaceRoot, journal.agentName) === journal.profileSha256;
      const authorityMatches = sameAuthority(await input.authority.read(journal.agentName), journal.authority);
      if (stanza.valueSha256 === journal.targetStanzaSha256 && profileMatches && authorityMatches) {
        journal = transition(txDir, journal, "committed");
        releaseRecoveredMigrationLock(root, journal.agentName, journal.txid);
        reconciled.push(entry);
        continue;
      }
      await compensateIncompleteMigration(input, txDir, journal);
      releaseRecoveredMigrationLock(root, journal.agentName, journal.txid);
      reconciled.push(entry);
    } catch {
      degraded.push(entry);
    }
  }
  return { reconciled, degraded };
}

export interface RollbackableAgentProfileMigration {
  txid: string;
  agentName: string;
  createdAt: string;
}

export function listRollbackableAgentProfileMigrations(workspaceRoot: string): RollbackableAgentProfileMigration[] {
  const root = agentProfileTransactionsRoot(workspaceRoot);
  try { requireSafeDirectory(workspaceRoot, root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: RollbackableAgentProfileMigration[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (["locks", "lifecycle", "rename", "forget"].includes(entry)) continue;
    const txDir = path.join(root, entry);
    try {
      requireSafeDirectory(workspaceRoot, txDir);
      const journal = readJournal(txDir);
      if (journal.phase === "committed") {
        rows.push({ txid: journal.txid, agentName: journal.agentName, createdAt: journal.createdAt });
      }
    } catch {
      // Corrupt/degraded journals are intentionally not advertised as safely rollbackable.
    }
  }
  return rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
