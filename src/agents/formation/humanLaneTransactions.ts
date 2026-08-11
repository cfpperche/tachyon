import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import {
  closeCanonicalAgentProfile,
  readCanonicalAgentProfile,
  readCanonicalAgentProfileEntry,
  replaceCanonicalAgentProfileEntry,
} from "../../config/agentProfileReader.js";
import { agentProfileSchemaV1 } from "../../config/agentProfileSchema.js";
import {
  FormationAuthorityStore,
  FormationAuthorityStoreError,
  type FormationCaller,
  type FormationMutationBarrier,
} from "./authorityStore.js";
import {
  formationDigest,
  validateFormationAuthorityVector,
  type FormationAuthorityVector,
} from "./domain.js";

interface EncodedEntry {
  priorSha256: string | null;
  prior: string | null;
  nextSha256: string | null;
  next: string | null;
}

interface HumanLaneTransactionIntent {
  schemaVersion: 1;
  kind: "human-lane-profile-edit" | "human-lane-legacy-migration" | "human-lane-retirement";
  workspaceRoot: string;
  agentName: string;
  agentId: string;
  expectedGenerationSha256: string;
  nextVector: FormationAuthorityVector;
  entries: {
    agentProfile: EncodedEntry;
    instructions?: EncodedEntry;
    config?: EncodedEntry & { path: string };
  };
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function encoded(prior: Buffer | undefined, next: Buffer | null): EncodedEntry {
  return {
    priorSha256: prior ? sha256(prior) : null,
    prior: prior ? prior.toString("base64") : null,
    nextSha256: next ? sha256(next) : null,
    next: next ? next.toString("base64") : null,
  };
}

function decode(value: string | null): Buffer | null {
  if (value === null) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new FormationAuthorityStoreError("human-lane mutation intent contains invalid base64");
  }
  return Buffer.from(value, "base64");
}

function parseIntent(barrier: FormationMutationBarrier): HumanLaneTransactionIntent {
  const value = barrier.intent as Partial<HumanLaneTransactionIntent> | undefined;
  if (!value || value.schemaVersion !== 1 || !["human-lane-profile-edit", "human-lane-legacy-migration", "human-lane-retirement"].includes(String(value.kind))
    || typeof value.workspaceRoot !== "string" || typeof value.agentName !== "string" || typeof value.agentId !== "string"
    || typeof value.expectedGenerationSha256 !== "string" || !value.nextVector || !value.entries?.agentProfile) {
    throw new FormationAuthorityStoreError("human-lane mutation intent is corrupt");
  }
  const errors = validateFormationAuthorityVector(value.nextVector);
  if (errors.length > 0) throw new FormationAuthorityStoreError(`human-lane next authority vector is corrupt: ${errors.join("; ")}`);
  const intent = value as HumanLaneTransactionIntent;
  const expectedMutation = intent.kind === "human-lane-retirement" ? "retire" : "profile-edit";
  if (barrier.mutation !== expectedMutation || intent.workspaceRoot !== path.resolve(intent.workspaceRoot)
    || intent.workspaceRoot !== fs.realpathSync.native(intent.workspaceRoot)
    || intent.agentId !== barrier.agentId || intent.workspaceRoot.length === 0
    || intent.expectedGenerationSha256 !== barrier.expectedGenerationSha256
    || intent.nextVector.profile.agentId !== barrier.agentId || intent.nextVector.generation.agentId !== barrier.agentId
    || intent.nextVector.profile.workspaceId !== barrier.workspaceId || intent.nextVector.generation.workspaceId !== barrier.workspaceId
    || intent.nextVector.profile.agentName !== intent.agentName) {
    throw new FormationAuthorityStoreError("human-lane mutation intent does not match its authority barrier");
  }
  for (const entry of [intent.entries.agentProfile, intent.entries.instructions,
    intent.entries.config].filter((candidate): candidate is EncodedEntry => !!candidate)) {
    for (const side of ["prior", "next"] as const) {
      const bytes = decode(entry[side]);
      const digest = entry[`${side}Sha256`];
      if ((bytes ? sha256(bytes) : null) !== digest) throw new FormationAuthorityStoreError("human-lane mutation intent entry digest is corrupt");
    }
  }
  if (intent.entries.config) {
    const expectedConfig = path.resolve(intent.workspaceRoot, path.relative(intent.workspaceRoot, intent.entries.config.path));
    const relative = path.relative(intent.workspaceRoot, expectedConfig);
    if (expectedConfig !== intent.entries.config.path || relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new FormationAuthorityStoreError("human-lane mutation config path escapes its workspace");
    }
  }
  return intent;
}

function descriptorPath(fd: number): string {
  const expected = fs.fstatSync(fd, { bigint: true });
  for (const root of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = `${root}/${fd}`;
    try {
      const actual = fs.statSync(candidate, { bigint: true });
      if (actual.dev === expected.dev && actual.ino === expected.ino) return candidate;
    } catch { /* try next */ }
  }
  throw new FormationAuthorityStoreError("host has no verified descriptor-relative filesystem path");
}

function readSafeFile(file: string, missingAllowed = false): Buffer | undefined {
  let before: fs.BigIntStats;
  try { before = fs.lstatSync(file, { bigint: true }); }
  catch (error) {
    if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new FormationAuthorityStoreError(`unsafe human-lane transaction file: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 4n * 1024n * 1024n) {
      throw new FormationAuthorityStoreError(`human-lane transaction file changed or is too large: ${file}`);
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const atPath = fs.lstatSync(file, { bigint: true });
    if (opened.dev !== after.dev || opened.ino !== after.ino || opened.dev !== atPath.dev || opened.ino !== atPath.ino
      || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs || atPath.isSymbolicLink()) {
      throw new FormationAuthorityStoreError(`human-lane transaction file changed during read: ${file}`);
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

function replaceFileAtDirectory(directory: string, name: string, expectedSha256: string | null, bytes: Buffer | null): void {
  if (path.basename(name) !== name) throw new FormationAuthorityStoreError("human-lane transaction entry name is invalid");
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(directory) !== path.resolve(directory)) {
    throw new FormationAuthorityStoreError(`unsafe human-lane transaction directory: ${directory}`);
  }
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const root = descriptorPath(directoryFd);
    const target = path.join(root, name);
    const custody = path.join(root, `.${name}.${expectedSha256 ?? "absent"}.custody`);
    const desiredSha256 = bytes ? sha256(bytes) : null;
    const held = readSafeFile(custody, true);
    if (held) {
      const visible = readSafeFile(target, true);
      if ((visible ? sha256(visible) : null) === desiredSha256) {
        fs.unlinkSync(custody);
        fs.fsyncSync(directoryFd);
      } else if (!visible && sha256(held) === expectedSha256) {
        fs.renameSync(custody, target);
        fs.fsyncSync(directoryFd);
      }
      else throw new FormationAuthorityStoreError(`${name} has inconsistent custody from an interrupted mutation`);
    }
    const current = readSafeFile(target, true);
    if ((current ? sha256(current) : null) !== expectedSha256) throw new FormationAuthorityStoreError(`${name} changed before human-lane transaction commit`);
    if (bytes === null) {
      if (current) {
        fs.renameSync(target, custody);
        fs.fsyncSync(directoryFd);
        const moved = readSafeFile(custody)!;
        if (sha256(moved) !== expectedSha256) {
          if (!fs.existsSync(target)) {
            fs.renameSync(custody, target);
            fs.fsyncSync(directoryFd);
          }
          throw new FormationAuthorityStoreError(`${name} changed before retirement custody`);
        }
        fs.unlinkSync(custody);
      }
      fs.fsyncSync(directoryFd);
      return;
    }
    const temporary = path.join(root, `.${name}.${crypto.randomUUID()}.stage`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      const again = readSafeFile(target, true);
      if ((again ? sha256(again) : null) !== expectedSha256) throw new FormationAuthorityStoreError(`${name} changed during human-lane transaction commit`);
      if (again) {
        fs.renameSync(target, custody);
        fs.fsyncSync(directoryFd);
        const moved = readSafeFile(custody)!;
        if (sha256(moved) !== expectedSha256) {
          if (!fs.existsSync(target)) {
            fs.renameSync(custody, target);
            fs.fsyncSync(directoryFd);
          }
          throw new FormationAuthorityStoreError(`${name} changed before replacement custody`);
        }
      }
      try { fs.linkSync(temporary, target); }
      catch (error) {
        if (again && !fs.existsSync(target)) {
          fs.renameSync(custody, target);
          fs.fsyncSync(directoryFd);
        }
        throw new FormationAuthorityStoreError(`${name} was concurrently replaced: ${String(error)}`);
      }
      fs.fsyncSync(directoryFd);
      fs.unlinkSync(temporary);
      fs.fsyncSync(directoryFd);
      if (again) {
        fs.unlinkSync(custody);
        fs.fsyncSync(directoryFd);
      }
      fs.fsyncSync(directoryFd);
      if (sha256(readSafeFile(target)!) !== sha256(bytes)) throw new FormationAuthorityStoreError(`${name} failed publication integrity`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ }
    }
  } finally { fs.closeSync(directoryFd); }
}

function ensureProfileDirectory(workspaceRoot: string, agentName: string): string {
  const workspace = fs.realpathSync.native(path.resolve(workspaceRoot));
  const directories = [path.join(workspace, ".tachyon"), path.join(workspace, ".tachyon", "agents"), path.join(workspace, ".tachyon", "agents", agentName)];
  for (const directory of directories) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(directory) !== directory) {
      throw new FormationAuthorityStoreError(`unsafe canonical profile directory: ${directory}`);
    }
  }
  return directories.at(-1)!;
}

function validateNextProfile(bytes: Buffer, intentInput: {
  agentId: string;
  nextVector: FormationAuthorityVector;
  nextInstructions?: Buffer | null;
}): void {
  if (sha256(bytes) !== intentInput.nextVector.profile.canonicalSha256) {
    throw new FormationAuthorityStoreError("next agent.yml digest does not match ProfileActivationHeadV2");
  }
  const document = parseDocument(bytes.toString("utf8"), { prettyErrors: false, uniqueKeys: true });
  const parsed = agentProfileSchemaV1.safeParse(document.toJS());
  if (document.errors.length > 0 || !parsed.success || parsed.data.agentId !== intentInput.agentId) {
    throw new FormationAuthorityStoreError("next agent.yml is invalid or belongs to another agentId");
  }
  const instructionsLane = intentInput.nextVector.profile.lanes.instructions;
  if (instructionsLane.mode === "profile") {
    const reference = parsed.data.references?.find((candidate) => candidate.id === instructionsLane.selectorId);
    if (!reference || reference.id !== instructionsLane.subjectId || reference.kind !== "instructions"
      || reference.scope !== "profile" || reference.owner !== intentInput.agentId || reference.path !== instructionsLane.path
      || reference.sha256 !== instructionsLane.sourceSha256 || !intentInput.nextInstructions
      || sha256(intentInput.nextInstructions) !== instructionsLane.sourceSha256) {
      throw new FormationAuthorityStoreError("next Persistent Instructions source/reference does not match active lane authority");
    }
  } else if (intentInput.nextInstructions !== undefined) {
    throw new FormationAuthorityStoreError("disabled Persistent Instructions lane cannot publish source bytes");
  }
}

function validateTransition(current: FormationAuthorityVector, next: FormationAuthorityVector, input: {
  workspaceId: string;
  agentId: string;
  agentName: string;
}): void {
  const errors = validateFormationAuthorityVector(next);
  if (errors.length > 0) throw new FormationAuthorityStoreError(`human-lane next authority vector is invalid: ${errors.join("; ")}`);
  if (next.profile.workspaceId !== input.workspaceId || next.generation.workspaceId !== input.workspaceId
    || next.profile.agentId !== input.agentId || next.generation.agentId !== input.agentId
    || next.profile.agentName !== input.agentName || next.profile.priorRevision !== current.profile.revision
    || next.generation.priorGeneration !== current.generation.generation
    || next.profile.revision !== current.profile.revision + 1
    || next.generation.generation !== current.generation.generation + 1) {
    throw new FormationAuthorityStoreError("human-lane authority transition does not advance the exact current identity");
  }
}

export class HumanLaneTransactionService {
  constructor(private readonly store: FormationAuthorityStore) {}

  prepareProfileEdit(input: {
    operationId: string;
    caller: FormationCaller;
    workspaceId: string;
    workspaceRoot: string;
    agentId: string;
    agentName: string;
    expectedGenerationSha256: string;
    nextVector: FormationAuthorityVector;
    nextAgentProfile: Buffer | string;
    nextInstructions?: Buffer | string;
  }): FormationMutationBarrier {
    return this.prepareCanonicalMutation(input, "human-lane-profile-edit", "profile-edit");
  }

  private prepareCanonicalMutation(input: {
    operationId: string;
    caller: FormationCaller;
    workspaceId: string;
    workspaceRoot: string;
    agentId: string;
    agentName: string;
    expectedGenerationSha256: string;
    nextVector: FormationAuthorityVector;
    nextAgentProfile: Buffer | string;
    nextInstructions?: Buffer | string;
  }, kind: "human-lane-profile-edit" | "human-lane-retirement", mutation: "profile-edit" | "retire"): FormationMutationBarrier {
    const current = this.store.currentVector(input.agentId);
    if (!current || formationDigest(current.generation) !== input.expectedGenerationSha256) {
      throw new FormationAuthorityStoreError("human-lane profile edit generation CAS mismatch");
    }
    if (current.profile.workspaceId !== input.workspaceId || current.profile.agentName !== input.agentName
      || current.profile.agentId !== input.agentId) throw new FormationAuthorityStoreError("human-lane profile edit identity mismatch");
    validateTransition(current, input.nextVector, input);
    const source = readCanonicalAgentProfile(input.workspaceRoot, input.agentName);
    if (!source || source.sha256 !== current.profile.canonicalSha256) {
      closeCanonicalAgentProfile(source!);
      throw new FormationAuthorityStoreError("current agent.yml does not match active profile authority");
    }
    try {
      const nextAgentProfile = Buffer.isBuffer(input.nextAgentProfile) ? Buffer.from(input.nextAgentProfile) : Buffer.from(input.nextAgentProfile, "utf8");
      const nextInstructions = input.nextInstructions === undefined
        ? undefined
        : Buffer.isBuffer(input.nextInstructions) ? Buffer.from(input.nextInstructions) : Buffer.from(input.nextInstructions, "utf8");
      const priorInstructions = readCanonicalAgentProfileEntry(source, "instructions.md")?.bytes;
      validateNextProfile(nextAgentProfile, {
        agentId: input.agentId,
        nextVector: input.nextVector,
        nextInstructions,
      });
      const intent: HumanLaneTransactionIntent = {
        schemaVersion: 1,
        kind,
        workspaceRoot: fs.realpathSync.native(path.resolve(input.workspaceRoot)),
        agentName: input.agentName,
        agentId: input.agentId,
        expectedGenerationSha256: input.expectedGenerationSha256,
        nextVector: structuredClone(input.nextVector),
        entries: {
          agentProfile: encoded(source.bytes, nextAgentProfile),
          ...(nextInstructions !== undefined ? { instructions: encoded(priorInstructions, nextInstructions) } : {}),
        },
      };
      return this.store.beginMutationBarrier({
        operationId: input.operationId,
        mutation,
        caller: input.caller,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        expectedGenerationSha256: input.expectedGenerationSha256,
        intent,
      });
    } finally {
      closeCanonicalAgentProfile(source);
    }
  }

  prepareLegacyMigration(input: {
    operationId: string;
    caller: FormationCaller;
    workspaceId: string;
    workspaceRoot: string;
    configPath: string;
    expectedConfigSha256: string;
    nextConfigText: string;
    agentId: string;
    agentName: string;
    expectedGenerationSha256: string;
    expectedLegacyInstructionsSha256?: string;
    legacyInstructions?: string;
    nextVector: FormationAuthorityVector;
    nextAgentProfile: Buffer | string;
  }): FormationMutationBarrier {
    const current = this.store.currentVector(input.agentId);
    if (!current || formationDigest(current.generation) !== input.expectedGenerationSha256
      || current.profile.workspaceId !== input.workspaceId || current.profile.agentId !== input.agentId
      || current.profile.agentName !== input.agentName
      || Object.values(current.profile.lanes).some((lane) => lane.mode !== "legacy")) {
      throw new FormationAuthorityStoreError("legacy human-lane migration requires the exact all-legacy authority generation");
    }
    if (Object.values(input.nextVector.profile.lanes).some((lane) => lane.mode === "legacy")) {
      throw new FormationAuthorityStoreError("legacy human-lane migration must cut over every lane without fallback");
    }
    validateTransition(current, input.nextVector, input);
    const nextAgentProfile = Buffer.isBuffer(input.nextAgentProfile) ? Buffer.from(input.nextAgentProfile) : Buffer.from(input.nextAgentProfile, "utf8");
    const nextInstructions = input.legacyInstructions === undefined ? undefined : Buffer.from(input.legacyInstructions, "utf8");
    if ((nextInstructions ? sha256(nextInstructions) : undefined) !== input.expectedLegacyInstructionsSha256) {
      throw new FormationAuthorityStoreError("legacy Persistent Instructions bytes do not match the declared migration digest");
    }
    const workspaceRoot = fs.realpathSync.native(path.resolve(input.workspaceRoot));
    const requestedConfigPath = path.resolve(input.configPath);
    const configName = path.basename(requestedConfigPath);
    const configParent = fs.realpathSync.native(path.dirname(requestedConfigPath));
    if ((configName !== "tachyon.yml" && configName !== "tachyon.yaml") || configParent !== workspaceRoot) {
      throw new FormationAuthorityStoreError("legacy migration config path is not the canonical workspace config");
    }
    const configPath = path.join(configParent, configName);
    const priorConfig = readSafeFile(configPath)!;
    if (sha256(priorConfig) !== input.expectedConfigSha256 || input.expectedConfigSha256 !== current.profile.canonicalSha256) {
      throw new FormationAuthorityStoreError("legacy config does not match active legacy profile authority");
    }
    const nextConfig = Buffer.from(input.nextConfigText, "utf8");
    const configDocument = parseDocument(input.nextConfigText, { prettyErrors: false, uniqueKeys: true });
    const configValue = configDocument.toJS() as { agents?: Record<string, unknown> } | undefined;
    const nextStanza = configValue?.agents?.[input.agentName] as Record<string, unknown> | undefined;
    if (configDocument.errors.length > 0 || !nextStanza || Object.keys(nextStanza).some((key) => key !== "profile")
      || nextStanza.profile !== `.tachyon/agents/${input.agentName}/agent.yml`) {
      throw new FormationAuthorityStoreError("legacy migration target config must contain only the canonical profile pointer for this agent");
    }
    const profileDirectory = path.join(path.resolve(input.workspaceRoot), ".tachyon", "agents", input.agentName);
    const priorAgentProfile = readSafeFile(path.join(profileDirectory, "agent.yml"), true);
    if (priorAgentProfile) throw new FormationAuthorityStoreError("legacy migration found an existing canonical agent.yml");
    const priorInstructions = readSafeFile(path.join(profileDirectory, "instructions.md"), true);
    if (priorInstructions && nextInstructions) throw new FormationAuthorityStoreError("legacy migration refuses to adopt pre-existing Persistent Instructions bytes");
    validateNextProfile(nextAgentProfile, {
      agentId: input.agentId,
      nextVector: input.nextVector,
      nextInstructions,
    });
    const intent: HumanLaneTransactionIntent = {
      schemaVersion: 1,
      kind: "human-lane-legacy-migration",
      workspaceRoot: fs.realpathSync.native(path.resolve(input.workspaceRoot)),
      agentName: input.agentName,
      agentId: input.agentId,
      expectedGenerationSha256: input.expectedGenerationSha256,
      nextVector: structuredClone(input.nextVector),
      entries: {
        agentProfile: encoded(undefined, nextAgentProfile),
        ...(nextInstructions ? { instructions: encoded(undefined, nextInstructions) } : {}),
        config: { ...encoded(priorConfig, nextConfig), path: configPath },
      },
    };
    return this.store.beginMutationBarrier({
      operationId: input.operationId,
      mutation: "profile-edit",
      caller: input.caller,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      expectedGenerationSha256: input.expectedGenerationSha256,
      intent,
    });
  }

  prepareRetirement(input: {
    operationId: string;
    caller: FormationCaller;
    workspaceId: string;
    workspaceRoot: string;
    agentId: string;
    agentName: string;
    expectedGenerationSha256: string;
    nextVector: FormationAuthorityVector;
    nextAgentProfile: Buffer | string;
  }): FormationMutationBarrier {
    const current = this.store.currentVector(input.agentId);
    if (!current || current.generation.retired || formationDigest(current.generation) !== input.expectedGenerationSha256
      || current.profile.workspaceId !== input.workspaceId || current.profile.agentName !== input.agentName
      || current.profile.agentId !== input.agentId || !input.nextVector.generation.retired
      || input.nextVector.generation.generation !== current.generation.generation + 1
      || input.nextVector.generation.priorGeneration !== current.generation.generation
      || input.nextVector.generation.workspaceId !== current.generation.workspaceId
      || input.nextVector.generation.agentId !== current.generation.agentId
      || formationDigest(input.nextVector.generation.profile) !== formationDigest(current.generation.profile)
      || formationDigest(input.nextVector.generation.memory ?? null) !== formationDigest(current.generation.memory ?? null)
      || input.nextVector.generation.rendererContractsSha256 !== current.generation.rendererContractsSha256
      || formationDigest(input.nextVector.profile) !== formationDigest(current.profile)
      || (input.nextVector.memory === undefined) !== (current.memory === undefined)
      || (input.nextVector.memory && current.memory && formationDigest(input.nextVector.memory) !== formationDigest(current.memory))) {
      throw new FormationAuthorityStoreError("agent retirement must preserve every lane authority and retire the exact active generation");
    }
    const nextAgentProfile = Buffer.isBuffer(input.nextAgentProfile) ? Buffer.from(input.nextAgentProfile) : Buffer.from(input.nextAgentProfile, "utf8");
    const source = readCanonicalAgentProfile(input.workspaceRoot, input.agentName);
    if (!source || source.sha256 !== current.profile.canonicalSha256 || sha256(nextAgentProfile) !== source.sha256) {
      closeCanonicalAgentProfile(source!);
      throw new FormationAuthorityStoreError("agent retirement source does not match active canonical profile authority");
    }
    try {
      const intent: HumanLaneTransactionIntent = {
        schemaVersion: 1,
        kind: "human-lane-retirement",
        workspaceRoot: fs.realpathSync.native(path.resolve(input.workspaceRoot)),
        agentName: input.agentName,
        agentId: input.agentId,
        expectedGenerationSha256: input.expectedGenerationSha256,
        nextVector: structuredClone(input.nextVector),
        entries: { agentProfile: encoded(source.bytes, source.bytes) },
      };
      return this.store.beginMutationBarrier({
        operationId: input.operationId,
        mutation: "retire",
        caller: input.caller,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        expectedGenerationSha256: input.expectedGenerationSha256,
        intent,
      });
    } finally { closeCanonicalAgentProfile(source); }
  }

  commit(
    agentId: string,
    operationId: string,
    caller: FormationCaller,
    hooks?: { afterSourcePublished?: () => void; afterAuthorityCommitted?: () => void },
  ): FormationAuthorityVector {
    const receipt = this.store.mutationReceipt(operationId, caller);
    if (receipt) {
      if (receipt.agentId !== agentId || receipt.outcome !== "committed") {
        throw new FormationAuthorityStoreError("human-lane mutation operation is already terminal with another outcome");
      }
      const replay = this.store.currentVector(agentId);
      if (!replay || formationDigest(replay.generation) !== receipt.nextGenerationSha256) {
        throw new FormationAuthorityStoreError("committed human-lane mutation authority is unavailable");
      }
      return replay;
    }
    const barrier = this.store.mutationBarrier(agentId, caller);
    if (!barrier || barrier.operationId !== operationId) throw new FormationAuthorityStoreError("human-lane mutation barrier is unavailable");
    const intent = parseIntent(barrier);
    if (barrier.caller.principal !== caller.principal || barrier.caller.kind !== caller.kind) {
      throw new FormationAuthorityStoreError("human-lane mutation belongs to another caller");
    }
    if (barrier.phase === "prepared") {
      this.applyEntries(intent, "next");
      this.store.advanceMutationBarrier({ operationId, caller, expectedPhase: "prepared", phase: "source-published" });
      hooks?.afterSourcePublished?.();
    }
    this.applyEntries(intent, "next");
    const current = this.store.currentVector(intent.agentId);
    if (!current || formationDigest(current.generation) !== formationDigest(intent.nextVector.generation)) {
      this.store.replaceVector({
        operationId,
        caller,
        mutation: barrier.mutation,
        vector: intent.nextVector,
        expectedGenerationSha256: intent.expectedGenerationSha256,
      });
    }
    this.applyEntries(intent, "next");
    const after = this.store.mutationBarrier(agentId, caller);
    if (!after || after.operationId !== operationId) throw new FormationAuthorityStoreError("human-lane mutation barrier disappeared before commit");
    if (after.phase === "source-published") {
      this.store.advanceMutationBarrier({ operationId, caller, expectedPhase: "source-published", phase: "authority-committed" });
      hooks?.afterAuthorityCommitted?.();
    }
    this.store.finishMutationBarrier({
      operationId,
      caller,
      outcome: "committed",
      nextGenerationSha256: formationDigest(intent.nextVector.generation),
    });
    return structuredClone(intent.nextVector);
  }

  recover(agentId: string, caller: FormationCaller): "none" | "rolled-back" | "completed" {
    const barrier = this.store.mutationBarrier(agentId, caller);
    if (!barrier) return "none";
    if (barrier.caller.principal !== caller.principal || barrier.caller.kind !== caller.kind) {
      throw new FormationAuthorityStoreError("human-lane mutation belongs to another caller");
    }
    const intent = parseIntent(barrier);
    const current = this.store.currentVector(agentId);
    if (current && formationDigest(current.generation) === formationDigest(intent.nextVector.generation)) {
      this.applyEntries(intent, "next");
      let phase = barrier.phase;
      if (phase === "prepared") {
        this.store.advanceMutationBarrier({ operationId: barrier.operationId, caller, expectedPhase: "prepared", phase: "source-published" });
        phase = "source-published";
      }
      if (phase === "source-published") {
        this.store.advanceMutationBarrier({ operationId: barrier.operationId, caller, expectedPhase: "source-published", phase: "authority-committed" });
      }
      this.store.finishMutationBarrier({
        operationId: barrier.operationId,
        caller,
        outcome: "committed",
        nextGenerationSha256: formationDigest(intent.nextVector.generation),
      });
      return "completed";
    }
    if (current && formationDigest(current.generation) === intent.expectedGenerationSha256) {
      this.applyEntries(intent, "prior");
      this.store.finishMutationBarrier({ operationId: barrier.operationId, caller, outcome: "rolled-back" });
      return "rolled-back";
    }
    throw new FormationAuthorityStoreError("human-lane mutation recovery found an unrelated authority generation");
  }

  status(operationId: string, caller: FormationCaller) {
    return this.store.mutationReceipt(operationId, caller);
  }

  inspect(agentId: string, caller: FormationCaller): {
    vector: FormationAuthorityVector | undefined;
    activeMutation?: { operationId: string; mutation: FormationMutationBarrier["mutation"]; phase: FormationMutationBarrier["phase"] };
    instructions: "legacy" | "disabled" | "profile" | "absent";
  } {
    const vector = this.store.currentVector(agentId);
    const barrier = this.store.mutationBarrier(agentId, caller);
    return {
      vector,
      ...(barrier ? { activeMutation: { operationId: barrier.operationId, mutation: barrier.mutation, phase: barrier.phase } } : {}),
      instructions: vector?.profile.lanes.instructions.mode ?? "absent",
    };
  }

  private applyEntries(intent: HumanLaneTransactionIntent, side: "prior" | "next"): void {
    if (side === "prior" && intent.entries.config) this.applyConfigEntry(intent.entries.config, side);
    let source = readCanonicalAgentProfile(intent.workspaceRoot, intent.agentName);
    if (!source && side === "next" && intent.entries.agentProfile.priorSha256 === null) {
      const directory = ensureProfileDirectory(intent.workspaceRoot, intent.agentName);
      replaceFileAtDirectory(directory, "agent.yml", null, decode(intent.entries.agentProfile.next));
      source = readCanonicalAgentProfile(intent.workspaceRoot, intent.agentName);
    }
    if (!source) {
      if (side === "prior" && intent.entries.agentProfile.priorSha256 === null) return;
      throw new FormationAuthorityStoreError("canonical profile disappeared during human-lane mutation");
    }
    try {
      const entries: Array<["agent.yml" | "instructions.md", EncodedEntry]> = [];
      if (side === "next" && intent.entries.agentProfile.priorSha256 !== null) entries.push(["agent.yml", intent.entries.agentProfile]);
      if (intent.entries.instructions) entries.push(["instructions.md", intent.entries.instructions]);
      if (side === "prior") entries.push(["agent.yml", intent.entries.agentProfile]);
      for (const [name, entry] of entries) {
        const desiredDigest = side === "next" ? entry.nextSha256 : entry.priorSha256;
        const desired = decode(side === "next" ? entry.next : entry.prior);
        const current = readCanonicalAgentProfileEntry(source, name)?.sha256 ?? null;
        if (current === desiredDigest) continue;
        const otherDigest = side === "next" ? entry.priorSha256 : entry.nextSha256;
        if (current !== otherDigest) throw new FormationAuthorityStoreError(`${name} changed outside the human-lane mutation`);
        replaceCanonicalAgentProfileEntry({ source, name, expectedSha256: current, bytes: desired });
      }
    } finally {
      closeCanonicalAgentProfile(source);
    }
    if (side === "next" && intent.entries.config) this.applyConfigEntry(intent.entries.config, side);
  }

  private applyConfigEntry(entry: EncodedEntry & { path: string }, side: "prior" | "next"): void {
    const desired = decode(side === "next" ? entry.next : entry.prior);
    const desiredDigest = side === "next" ? entry.nextSha256 : entry.priorSha256;
    const current = readSafeFile(entry.path, true);
    const currentDigest = current ? sha256(current) : null;
    if (currentDigest === desiredDigest) return;
    const otherDigest = side === "next" ? entry.priorSha256 : entry.nextSha256;
    if (currentDigest !== otherDigest) throw new FormationAuthorityStoreError("legacy config changed outside the human-lane migration");
    replaceFileAtDirectory(path.dirname(entry.path), path.basename(entry.path), currentDigest, desired);
  }
}
