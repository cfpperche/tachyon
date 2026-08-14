import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { PersistableEntry } from "../bridge/callerIdentity.js";
import { bridgeGenerationStateKey } from "../bridge/clientRebind.js";
import { bridgeTokenFileName, externalBridgeTokenFileName } from "../bridge/token.js";
import { PROVIDER_OBSERVATION_PREFERENCES_STATE_KEY } from "../runtimeObservability/preferences.js";
import {
  CALLER_IDENTITY_HMAC_SECRET_KEY,
  authorityHeadsSecretKey,
  callerIdentityInstanceIdStateKey,
  callerIdentityRegistryStateKey,
  hostActionSessionEpochStateKey,
  workspaceVersionStateKey,
} from "../workspace/operationalStateKeys.js";
import { DaemonStateStore } from "./daemonStateStore.js";

const MIGRATION_PENDING_FILE = "legacy-state-migration-v1.pending.json";
const MIGRATION_COMPLETE_FILE = "legacy-state-migration-v1.complete.json";
const MAX_MIGRATION_BYTES = 2 * 1024 * 1024;
const MAX_REGISTRY_ENTRIES = 4_096;
const SAFE_WORKSPACE_HASH = /^[0-9a-f]{8}$/u;
const SAFE_INSTANCE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_AGENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const SAFE_HEX_64 = /^[0-9a-f]{64}$/u;

export interface LegacyEngineStateSource {
  globalStorageRoot: string;
  getState<T>(key: string): T | undefined;
  getSecret(key: string): Promise<string | undefined>;
}

export interface EngineStateMigrationV1 {
  schemaVersion: 1;
  workspaceHash: string;
  state: {
    bridgeInstanceId?: string;
    callerRegistry?: PersistableEntry[];
    hostActionSessionEpoch?: number;
    bridgeClientGeneration?: number;
    lastVersion?: string;
    providerObservationPreferences?: unknown;
  };
  secrets: {
    callerIdentityHmacKey?: string;
    authorityHeads?: string;
  };
  tokens: {
    bridge?: string;
    external?: string;
  };
}

export interface EngineStateMigrationResult {
  disposition: "applied" | "already-complete";
  fingerprint: string;
  fields: string[];
}

export interface ApplyEngineStateMigrationOptions {
  /** Test seam proving replay after a crash between data writes and the completion marker. */
  beforeComplete?: () => void;
}

export type EngineStateMigrationProvider = () => Promise<EngineStateMigrationV1>;

export class EngineStateMigrationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EngineStateMigrationError";
  }
}

/**
 * Reads only the operational values the daemon still consumes. Presentation state, transient reload
 * transactions/audits and unknown ExtensionContext keys are deliberately outside this contract.
 */
export async function collectLegacyEngineStateMigration(
  workspaceHash: string,
  source: LegacyEngineStateSource,
): Promise<EngineStateMigrationV1> {
  assertWorkspaceHash(workspaceHash);
  if (!path.isAbsolute(source.globalStorageRoot)) {
    throw new EngineStateMigrationError("INVALID_SOURCE", "legacy global storage root must be absolute");
  }

  const bridgeInstanceId = optionalInstanceId(source.getState<unknown>(callerIdentityInstanceIdStateKey(workspaceHash)));
  const hmacKey = optionalHex64(await source.getSecret(CALLER_IDENTITY_HMAC_SECRET_KEY), "caller identity HMAC key");
  const registryRaw = source.getState<unknown>(callerIdentityRegistryStateKey(workspaceHash));
  const callerRegistry = bridgeInstanceId && hmacKey && registryRaw !== undefined
    ? validateCallerRegistry(registryRaw, workspaceHash, bridgeInstanceId)
    : undefined;
  const authorityRaw = await source.getSecret(authorityHeadsSecretKey(workspaceHash));
  const authorityHeads = hmacKey && authorityRaw !== undefined
    ? validateAuthorityHeads(authorityRaw)
    : undefined;
  const hostActionSessionEpoch = optionalSafeInteger(
    source.getState<unknown>(hostActionSessionEpochStateKey(workspaceHash)),
    "host action session epoch",
  );
  const bridgeClientGeneration = bridgeInstanceId
    ? optionalSafeInteger(
        source.getState<unknown>(bridgeGenerationStateKey(workspaceHash, bridgeInstanceId)),
        "Bridge client generation",
      )
    : undefined;
  const lastVersion = optionalBoundedString(
    source.getState<unknown>(workspaceVersionStateKey(workspaceHash)),
    "last Tachyon version",
    128,
  );
  const providerRaw = source.getState<unknown>(PROVIDER_OBSERVATION_PREFERENCES_STATE_KEY);
  const providerObservationPreferences = providerRaw === undefined
    ? undefined
    : validateProviderObservationPreferences(providerRaw);
  const bridge = readLegacyToken(source.globalStorageRoot, bridgeTokenFileName(workspaceHash));
  const external = readLegacyToken(source.globalStorageRoot, externalBridgeTokenFileName(workspaceHash));
  if (bridge !== undefined && external === bridge) {
    throw new EngineStateMigrationError("INVALID_SOURCE", "legacy Bridge tokens must be distinct");
  }

  return validateMigration({
    schemaVersion: 1,
    workspaceHash,
    state: {
      ...(bridgeInstanceId === undefined ? {} : { bridgeInstanceId }),
      ...(callerRegistry === undefined ? {} : { callerRegistry }),
      ...(hostActionSessionEpoch === undefined ? {} : { hostActionSessionEpoch }),
      ...(bridgeClientGeneration === undefined ? {} : { bridgeClientGeneration }),
      ...(lastVersion === undefined ? {} : { lastVersion }),
      ...(providerObservationPreferences === undefined ? {} : { providerObservationPreferences }),
    },
    secrets: {
      ...(hmacKey === undefined ? {} : { callerIdentityHmacKey: hmacKey }),
      ...(authorityHeads === undefined ? {} : { authorityHeads }),
    },
    tokens: {
      ...(bridge === undefined ? {} : { bridge }),
      ...(external === undefined ? {} : { external }),
    },
  });
}

/** Apply one frozen migration before the first daemon launch. Existing daemon-owned values win. */
export async function applyEngineStateMigration(
  storageRoot: string,
  migrationInput: EngineStateMigrationV1,
  options: ApplyEngineStateMigrationOptions = {},
): Promise<EngineStateMigrationResult> {
  if (!path.isAbsolute(storageRoot)) {
    throw new EngineStateMigrationError("INVALID_TARGET", "engine state migration target must be absolute");
  }
  const incoming = validateMigration(migrationInput);
  // Validates existing store files and creates the private root. Migration runs before daemon launch,
  // so a whole state/secrets document can be installed atomically instead of doing a racy key-by-key RMW.
  new DaemonStateStore(storageRoot);
  const statePath = path.join(storageRoot, "state.json");
  const secretsPath = path.join(storageRoot, "secrets.json");
  const complete = readCompleteMarker(storageRoot);
  if (complete) return completedResult(complete, incoming.workspaceHash);

  let pending = readPendingMarker(storageRoot);
  // Without our pending record, either store document means a daemon already established authority.
  // Preserve the pair as one unit rather than combining an old registry with a different HMAC key.
  const preserveExistingAuthority = !pending && (fs.existsSync(statePath) || fs.existsSync(secretsPath));
  if (!pending) {
    const candidate = pendingMarker(incoming);
    if (writeJsonExclusive(path.join(storageRoot, MIGRATION_PENDING_FILE), candidate)) pending = candidate;
    else pending = readPendingMarker(storageRoot);
    // A contender may have completed and removed the pending record between those two operations.
    if (!pending) {
      const racedComplete = readCompleteMarker(storageRoot);
      if (racedComplete) return completedResult(racedComplete, incoming.workspaceHash);
      throw new EngineStateMigrationError("MIGRATION_RACE", "engine state migration changed concurrently; retry");
    }
  }
  const migration = pending.migration;
  const fingerprint = migrationFingerprint(migration);
  if (pending.workspaceHash !== incoming.workspaceHash || pending.fingerprint !== fingerprint) {
    throw new EngineStateMigrationError("PENDING_CORRUPT", "pending engine state migration is inconsistent");
  }

  const fields = preserveExistingAuthority
    ? ["state:preserved", "secrets:preserved"]
    : [
        `state:${writeJsonExclusive(statePath, migrationStateDocument(migration)) ? "imported" : "preserved"}`,
        `secrets:${writeJsonExclusive(secretsPath, migrationSecretDocument(migration)) ? "imported" : "preserved"}`,
      ];
  fields.push(`tokens.bridge:${writeTokenExclusive(storageRoot, bridgeTokenFileName(migration.workspaceHash), migration.tokens.bridge)}`);
  fields.push(`tokens.external:${writeTokenExclusive(storageRoot, externalBridgeTokenFileName(migration.workspaceHash), migration.tokens.external)}`);
  new DaemonStateStore(storageRoot); // validate either the imported documents or the preserved authority.
  options.beforeComplete?.();
  const marker: CompleteMarker = {
    schemaVersion: 1,
    workspaceHash: migration.workspaceHash,
    fingerprint,
    fields: fields.sort(),
    completedAt: new Date().toISOString(),
  };
  if (!writeJsonExclusive(path.join(storageRoot, MIGRATION_COMPLETE_FILE), marker)) {
    const racedComplete = readCompleteMarker(storageRoot);
    if (!racedComplete) throw new EngineStateMigrationError("MIGRATION_RACE", "engine state migration completion changed concurrently");
    fs.rmSync(path.join(storageRoot, MIGRATION_PENDING_FILE), { force: true });
    return completedResult(racedComplete, incoming.workspaceHash);
  }
  fs.rmSync(path.join(storageRoot, MIGRATION_PENDING_FILE), { force: true });
  return { disposition: "applied", fingerprint, fields: marker.fields };
}

/** Skip the legacy source entirely after the durable completion marker exists. */
export async function ensureEngineStateMigration(
  storageRoot: string,
  workspaceHash: string,
  provide: EngineStateMigrationProvider,
): Promise<EngineStateMigrationResult> {
  if (!path.isAbsolute(storageRoot)) {
    throw new EngineStateMigrationError("INVALID_TARGET", "engine state migration target must be absolute");
  }
  assertWorkspaceHash(workspaceHash);
  new DaemonStateStore(storageRoot);
  const complete = readCompleteMarker(storageRoot);
  if (complete) return completedResult(complete, workspaceHash);
  const migration = await provide();
  if (migration.workspaceHash !== workspaceHash) {
    throw new EngineStateMigrationError("TARGET_MISMATCH", "legacy engine state belongs to another workspace");
  }
  return applyEngineStateMigration(storageRoot, migration);
}

export function migrationFingerprint(migration: EngineStateMigrationV1): string {
  return createHash("sha256").update(canonicalJson(validateMigration(migration))).digest("hex");
}

function pendingMarker(migration: EngineStateMigrationV1): PendingMarker {
  return {
    schemaVersion: 1,
    workspaceHash: migration.workspaceHash,
    fingerprint: migrationFingerprint(migration),
    migration,
  };
}

function completedResult(marker: CompleteMarker, workspaceHash: string): EngineStateMigrationResult {
  if (marker.workspaceHash !== workspaceHash) {
    throw new EngineStateMigrationError("TARGET_MISMATCH", "engine state migration marker belongs to another workspace");
  }
  return { disposition: "already-complete", fingerprint: marker.fingerprint, fields: [...marker.fields] };
}

function migrationStateDocument(migration: EngineStateMigrationV1): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const state = migration.state;
  if (state.bridgeInstanceId !== undefined) {
    out[callerIdentityInstanceIdStateKey(migration.workspaceHash)] = state.bridgeInstanceId;
  }
  if (state.callerRegistry !== undefined) {
    out[callerIdentityRegistryStateKey(migration.workspaceHash)] = state.callerRegistry;
  }
  if (state.hostActionSessionEpoch !== undefined) {
    out[hostActionSessionEpochStateKey(migration.workspaceHash)] = state.hostActionSessionEpoch;
  }
  if (state.bridgeClientGeneration !== undefined && state.bridgeInstanceId !== undefined) {
    out[bridgeGenerationStateKey(migration.workspaceHash, state.bridgeInstanceId)] = state.bridgeClientGeneration;
  }
  if (state.lastVersion !== undefined) out[workspaceVersionStateKey(migration.workspaceHash)] = state.lastVersion;
  if (state.providerObservationPreferences !== undefined) {
    out[PROVIDER_OBSERVATION_PREFERENCES_STATE_KEY] = state.providerObservationPreferences;
  }
  return out;
}

function migrationSecretDocument(migration: EngineStateMigrationV1): Record<string, string> {
  const out: Record<string, string> = {};
  if (migration.secrets.callerIdentityHmacKey !== undefined) {
    out[CALLER_IDENTITY_HMAC_SECRET_KEY] = migration.secrets.callerIdentityHmacKey;
  }
  if (migration.secrets.authorityHeads !== undefined) {
    out[authorityHeadsSecretKey(migration.workspaceHash)] = migration.secrets.authorityHeads;
  }
  return out;
}

function writeTokenExclusive(storageRoot: string, fileName: string, value: string | undefined): "absent" | "imported" | "preserved" {
  if (value === undefined) return "absent";
  const file = path.join(storageRoot, fileName);
  if (readPrivateTokenFile(file) !== undefined) return "preserved";
  try {
    fs.writeFileSync(file, `${value}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return "imported";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    readPrivateTokenFile(file);
    return "preserved";
  }
}

interface PendingMarker {
  schemaVersion: 1;
  workspaceHash: string;
  fingerprint: string;
  migration: EngineStateMigrationV1;
}

interface CompleteMarker {
  schemaVersion: 1;
  workspaceHash: string;
  fingerprint: string;
  fields: string[];
  completedAt: string;
}

function readPendingMarker(storageRoot: string): PendingMarker | undefined {
  const value = readJsonFile(path.join(storageRoot, MIGRATION_PENDING_FILE));
  if (value === undefined) return undefined;
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.workspaceHash !== "string"
    || typeof value.fingerprint !== "string"
    || !SAFE_HEX_64.test(value.fingerprint)) {
    throw new EngineStateMigrationError("PENDING_CORRUPT", "pending engine state migration marker is invalid");
  }
  const migration = validateMigration(value.migration);
  return {
    schemaVersion: 1,
    workspaceHash: value.workspaceHash,
    fingerprint: value.fingerprint,
    migration,
  };
}

function readCompleteMarker(storageRoot: string): CompleteMarker | undefined {
  const value = readJsonFile(path.join(storageRoot, MIGRATION_COMPLETE_FILE));
  if (value === undefined) return undefined;
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.workspaceHash !== "string"
    || typeof value.fingerprint !== "string"
    || !SAFE_HEX_64.test(value.fingerprint)
    || !Array.isArray(value.fields)
    || value.fields.some((field) => typeof field !== "string" || field.length > 256)
    || typeof value.completedAt !== "string"
    || !Number.isFinite(Date.parse(value.completedAt))) {
    throw new EngineStateMigrationError("COMPLETE_CORRUPT", "engine state migration completion marker is invalid");
  }
  return {
    schemaVersion: 1,
    workspaceHash: value.workspaceHash,
    fingerprint: value.fingerprint,
    fields: [...value.fields] as string[],
    completedAt: value.completedAt,
  };
}

function validateMigration(value: unknown): EngineStateMigrationV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.workspaceHash !== "string"
    || !isRecord(value.state)
    || !isRecord(value.secrets)
    || !isRecord(value.tokens)
    || hasUnknownKeys(value, ["schemaVersion", "workspaceHash", "state", "secrets", "tokens"])
    || hasUnknownKeys(value.state, [
      "bridgeInstanceId",
      "callerRegistry",
      "hostActionSessionEpoch",
      "bridgeClientGeneration",
      "lastVersion",
      "providerObservationPreferences",
    ])
    || hasUnknownKeys(value.secrets, ["callerIdentityHmacKey", "authorityHeads"])
    || hasUnknownKeys(value.tokens, ["bridge", "external"])) {
    throw new EngineStateMigrationError("INVALID_MIGRATION", "engine state migration envelope is invalid");
  }
  assertWorkspaceHash(value.workspaceHash);
  const bridgeInstanceId = optionalInstanceId(value.state.bridgeInstanceId);
  const callerIdentityHmacKey = optionalHex64(value.secrets.callerIdentityHmacKey, "caller identity HMAC key");
  const callerRegistry = value.state.callerRegistry === undefined
    ? undefined
    : validateCallerRegistry(value.state.callerRegistry, value.workspaceHash, requiredInstanceId(bridgeInstanceId));
  const authorityHeads = value.secrets.authorityHeads === undefined
    ? undefined
    : validateAuthorityHeads(value.secrets.authorityHeads);
  if ((callerRegistry !== undefined || authorityHeads !== undefined) && callerIdentityHmacKey === undefined) {
    throw new EngineStateMigrationError("INVALID_MIGRATION", "caller registry and authority heads require their HMAC key");
  }
  const bridge = optionalHex64(value.tokens.bridge, "Bridge token");
  const external = optionalHex64(value.tokens.external, "external Bridge token");
  if (bridge !== undefined && bridge === external) {
    throw new EngineStateMigrationError("INVALID_MIGRATION", "Bridge tokens must be distinct");
  }
  const migration: EngineStateMigrationV1 = {
    schemaVersion: 1,
    workspaceHash: value.workspaceHash,
    state: {
      ...(bridgeInstanceId === undefined ? {} : { bridgeInstanceId }),
      ...(callerRegistry === undefined ? {} : { callerRegistry }),
      ...(value.state.hostActionSessionEpoch === undefined ? {} : {
        hostActionSessionEpoch: requiredSafeInteger(value.state.hostActionSessionEpoch, "host action session epoch"),
      }),
      ...(value.state.bridgeClientGeneration === undefined ? {} : {
        bridgeClientGeneration: requiredSafeInteger(value.state.bridgeClientGeneration, "Bridge client generation"),
      }),
      ...(value.state.lastVersion === undefined ? {} : {
        lastVersion: requiredBoundedString(value.state.lastVersion, "last Tachyon version", 128),
      }),
      ...(value.state.providerObservationPreferences === undefined ? {} : {
        providerObservationPreferences: validateProviderObservationPreferences(value.state.providerObservationPreferences),
      }),
    },
    secrets: {
      ...(callerIdentityHmacKey === undefined ? {} : { callerIdentityHmacKey }),
      ...(authorityHeads === undefined ? {} : { authorityHeads }),
    },
    tokens: {
      ...(bridge === undefined ? {} : { bridge }),
      ...(external === undefined ? {} : { external }),
    },
  };
  if (Buffer.byteLength(canonicalJson(migration), "utf8") > MAX_MIGRATION_BYTES) {
    throw new EngineStateMigrationError("MIGRATION_TOO_LARGE", "engine state migration exceeds the size limit");
  }
  return migration;
}

function validateCallerRegistry(value: unknown, workspaceHash: string, instanceId: string): PersistableEntry[] {
  if (!Array.isArray(value) || value.length > MAX_REGISTRY_ENTRIES) {
    throw new EngineStateMigrationError("INVALID_SOURCE", "legacy caller registry is invalid");
  }
  const digests = new Set<string>();
  return value.map((candidate): PersistableEntry => {
    if (!isRecord(candidate)
      || hasUnknownKeys(candidate, ["digestHex", "name", "workspaceId", "instanceId", "state", "mintedAt", "lastSeenAt", "expiresAt"])
      || typeof candidate.digestHex !== "string"
      || !SAFE_HEX_64.test(candidate.digestHex)
      || typeof candidate.name !== "string"
      || !SAFE_AGENT_NAME.test(candidate.name)
      || candidate.workspaceId !== workspaceHash
      || candidate.instanceId !== instanceId
      || (candidate.state !== "live" && candidate.state !== "revoked")) {
      throw new EngineStateMigrationError("INVALID_SOURCE", "legacy caller registry contains an invalid entry");
    }
    const mintedAt = requiredSafeInteger(candidate.mintedAt, "caller registry mintedAt");
    const lastSeenAt = requiredSafeInteger(candidate.lastSeenAt, "caller registry lastSeenAt");
    const expiresAt = requiredSafeInteger(candidate.expiresAt, "caller registry expiresAt");
    if (lastSeenAt < mintedAt || expiresAt < mintedAt || digests.has(candidate.digestHex)) {
      throw new EngineStateMigrationError("INVALID_SOURCE", "legacy caller registry contains contradictory entries");
    }
    digests.add(candidate.digestHex);
    return {
      digestHex: candidate.digestHex,
      name: candidate.name,
      workspaceId: candidate.workspaceId,
      instanceId: candidate.instanceId,
      state: candidate.state,
      mintedAt,
      lastSeenAt,
      expiresAt,
    };
  });
}

function validateAuthorityHeads(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw new EngineStateMigrationError("INVALID_SOURCE", "legacy authority heads are invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new EngineStateMigrationError("INVALID_SOURCE", "legacy authority heads are invalid JSON"); }
  if (!isRecord(parsed) || Object.keys(parsed).length > 4_096) {
    throw new EngineStateMigrationError("INVALID_SOURCE", "legacy authority heads are invalid");
  }
  const normalized: Record<string, { revision: number; mac: string }> = {};
  for (const key of Object.keys(parsed).sort()) {
    const candidate = parsed[key];
    if (key.length > 384
      || (!key.startsWith("legacy:") && !key.startsWith("canonical:"))
      || !isRecord(candidate)
      || hasUnknownKeys(candidate, ["revision", "mac"])
      || !Number.isSafeInteger(candidate.revision)
      || (candidate.revision as number) < 1
      || typeof candidate.mac !== "string"
      || !SAFE_HEX_64.test(candidate.mac)) {
      throw new EngineStateMigrationError("INVALID_SOURCE", "legacy authority heads contain an invalid entry");
    }
    normalized[key] = { revision: candidate.revision as number, mac: candidate.mac };
  }
  return JSON.stringify(normalized);
}

function validateProviderObservationPreferences(value: unknown): unknown {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !isRecord(value.providers)
    || hasUnknownKeys(value, ["schemaVersion", "providers"])
    || hasUnknownKeys(value.providers, ["codex", "claude"])) {
    throw new EngineStateMigrationError("INVALID_SOURCE", "legacy provider observation preferences are invalid");
  }
  const providers: Record<string, unknown> = {};
  for (const provider of ["codex", "claude"] as const) {
    const candidate = value.providers[provider];
    if (candidate === undefined) continue;
    if (!isRecord(candidate)
      || hasUnknownKeys(candidate, ["accountScopeKey", "sources"])
      || typeof candidate.accountScopeKey !== "string"
      || !/^ps_[0-9a-f]{16,64}$/u.test(candidate.accountScopeKey)
      || !Array.isArray(candidate.sources)
      || candidate.sources.length < 1
      || candidate.sources.length > 2
      || candidate.sources.some((source) => source !== "cli" && source !== "oauth")
      || new Set(candidate.sources).size !== candidate.sources.length) {
      throw new EngineStateMigrationError("INVALID_SOURCE", "legacy provider observation preferences contain an invalid entry");
    }
    providers[provider] = {
      accountScopeKey: candidate.accountScopeKey,
      sources: [...candidate.sources].sort((left, right) => String(left).localeCompare(String(right))),
    };
  }
  return { schemaVersion: 1, providers };
}

function readLegacyToken(storageRoot: string, fileName: string): string | undefined {
  return readPrivateTokenFile(path.join(storageRoot, fileName));
}

function readPrivateTokenFile(file: string): string | undefined {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) {
    throw new EngineStateMigrationError("TOKEN_UNSAFE", `Bridge token is not a bounded regular file: ${file}`);
  }
  if (process.platform !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
      throw new EngineStateMigrationError("TOKEN_UNSAFE", `Bridge token has unsafe ownership or permissions: ${file}`);
    }
  }
  const token = fs.readFileSync(file, "utf8").trim();
  if (!SAFE_HEX_64.test(token)) {
    throw new EngineStateMigrationError("TOKEN_INVALID", `Bridge token is invalid: ${file}`);
  }
  return token;
}

function optionalInstanceId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredInstanceId(value);
}

function requiredInstanceId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_INSTANCE_ID.test(value)) {
    throw new EngineStateMigrationError("INVALID_SOURCE", "legacy Bridge instance id is invalid");
  }
  return value;
}

function optionalHex64(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SAFE_HEX_64.test(value)) {
    throw new EngineStateMigrationError("INVALID_SOURCE", `${label} is invalid`);
  }
  return value;
}

function optionalSafeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredSafeInteger(value, label);
}

function requiredSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new EngineStateMigrationError("INVALID_SOURCE", `${label} is invalid`);
  }
  return value as number;
}

function optionalBoundedString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredBoundedString(value, label, maxLength);
}

function requiredBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || value.includes("\0")) {
    throw new EngineStateMigrationError("INVALID_SOURCE", `${label} is invalid`);
  }
  return value;
}

function readJsonFile(file: string): unknown | undefined {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MIGRATION_BYTES + 16 * 1024) {
    throw new EngineStateMigrationError("MARKER_UNSAFE", `engine state migration marker is unsafe: ${file}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new EngineStateMigrationError("MARKER_UNSAFE", `engine state migration marker is not private: ${file}`);
  }
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new EngineStateMigrationError("MARKER_CORRUPT", `engine state migration marker is corrupt: ${file}`); }
}

function writeJsonExclusive(file: string, value: unknown): boolean {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_MIGRATION_BYTES + 16 * 1024) {
    throw new EngineStateMigrationError("MARKER_TOO_LARGE", "engine state migration marker exceeds the size limit");
  }
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { fs.linkSync(tmp, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    fs.chmodSync(file, 0o600);
    return true;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already absent */ }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).some((key) => !keys.has(key));
}

function assertWorkspaceHash(value: string): void {
  if (!SAFE_WORKSPACE_HASH.test(value)) {
    throw new EngineStateMigrationError("INVALID_WORKSPACE", "legacy workspace hash is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
