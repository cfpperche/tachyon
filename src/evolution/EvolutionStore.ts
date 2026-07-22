import crypto from "node:crypto";
import { constants as fsConstants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isValidAgentName } from "../config/nameValidation.js";
import {
  authorityRecordMac,
  sealAuthorityRecord,
  verifyAuthorityRecord,
  workspaceAuthorityDomain,
  type AuthorityRecord,
  type AuthorityHead,
  type AuthorityHeadPort,
} from "../delivery/authorityIntegrity.js";
import {
  EVOLUTION_SCHEMA_VERSION,
  createInitialEvolutionProfile,
  evolutionCandidateTargetKey,
  renderEvolutionLearnings,
  type EvolutionCandidate,
  type EvolutionCandidateTarget,
  type EvolutionHistoryRecord,
  type EvolutionLearning,
  type EvolutionLearningTarget,
  type EvolutionProfile,
  type EvolutionReview,
  type EvolutionSkillFile,
  type EvolutionSkillTarget,
} from "./domain.js";
import {
  digestEvolutionSkillFiles,
  validateEvolutionSkillBundle,
  type EvolutionSkillBundleInput,
} from "./skillBundle.js";

const SAFE_RECORD_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_SKILL_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ACTIVE_TEXT_MAX_BYTES = 256 * 1024;
const ACTIVE_SKILL_FILE_MAX_BYTES = 1024 * 1024;
const ACTIVE_SKILL_FILES_MAX = 1024;
const ACTIVE_SKILL_TOTAL_MAX_BYTES = 16 * 1024 * 1024;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function formationActiveNamesDigest(names: readonly string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(names)).digest("hex");
}

interface OpenedUtf8File {
  content: string;
  mode: number;
}

async function readBoundedNoFollowUtf8WithMode(file: string, maxBytes: number, label: string): Promise<OpenedUtf8File> {
  const before = await fs.lstat(file, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(maxBytes)) {
    throw new EvolutionStoreError("evolution/authority-invalid", `${label} is unsafe or exceeds ${maxBytes} bytes`);
  }
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > BigInt(maxBytes)) {
      throw new EvolutionStoreError("evolution/authority-invalid", `${label} changed while opened`);
    }
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new EvolutionStoreError("evolution/authority-invalid", `${label} exceeds ${maxBytes} bytes`);
    const after = await handle.stat({ bigint: true });
    const atPath = await fs.lstat(file, { bigint: true });
    if (atPath.isSymbolicLink() || opened.dev !== after.dev || opened.ino !== after.ino
      || opened.dev !== atPath.dev || opened.ino !== atPath.ino || opened.size !== after.size
      || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs) {
      throw new EvolutionStoreError("evolution/authority-invalid", `${label} changed during read`);
    }
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), mode: Number(opened.mode) };
  } catch (error) {
    if (error instanceof EvolutionStoreError) throw error;
    throw new EvolutionStoreError("evolution/authority-invalid", `${label} cannot be read safely: ${error instanceof Error ? error.message : String(error)}`);
  } finally { await handle.close(); }
}

async function readBoundedNoFollowUtf8(file: string, maxBytes: number, label: string): Promise<string> {
  return (await readBoundedNoFollowUtf8WithMode(file, maxBytes, label)).content;
}

async function openNoFollowDirectory(directory: string, label: string): Promise<Awaited<ReturnType<typeof fs.open>>> {
  if (fsConstants.O_NOFOLLOW === undefined || process.platform !== "linux") {
    throw new EvolutionStoreError("evolution/authority-invalid", `${label} requires secure no-follow directory access`);
  }
  const before = await fs.lstat(directory, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new EvolutionStoreError("evolution/authority-invalid", `${label} is not a safe directory`);
  }
  const handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const atPath = await fs.lstat(directory, { bigint: true });
    if (!opened.isDirectory() || atPath.isSymbolicLink() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.dev !== atPath.dev || opened.ino !== atPath.ino) {
      throw new EvolutionStoreError("evolution/authority-invalid", `${label} changed while opened`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export type EvolutionStoreErrorCode =
  | "evolution/path-invalid"
  | "evolution/profile-conflict"
  | "evolution/profile-malformed"
  | "evolution/candidate-malformed"
  | "evolution/candidate-conflict"
  | "evolution/review-malformed"
  | "evolution/review-conflict"
  | "evolution/promotion-conflict"
  | "evolution/authority-invalid"
  | "evolution/skill-invalid"
  | "evolution/history-invalid";

export class EvolutionStoreError extends Error {
  constructor(
    public readonly code: EvolutionStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EvolutionStoreError";
  }
}

export type EvolutionCandidateInputTarget =
  | EvolutionLearningTarget
  | ({ kind: "skill" } & EvolutionSkillBundleInput);

export interface CreateEvolutionCandidateInput {
  reviewId: string;
  taskId: string;
  target: EvolutionCandidateInputTarget;
}

export interface CreateEvolutionReviewInput {
  taskId: string;
  taskTitle: string;
  completionRevision: string;
  session: string;
  activitySeq?: number;
}

export interface EvolutionReviewSubmission {
  review: EvolutionReview;
  candidates: EvolutionCandidate[];
  replayed: boolean;
}

export interface EvolutionCandidateDetail {
  candidate: EvolutionCandidate;
  activeVersion: number;
  currentTargetDigest?: string;
}

export interface ResolveEvolutionCandidateInput {
  expectedActiveVersion: number;
  expectedTargetDigest?: string;
  reservedSkillNames?: ReadonlySet<string>;
}

export interface EvolutionFormationPromotionToken {
  schemaVersion: 1;
  agent: string;
  candidateId: string;
  reviewId: string;
  expectedActiveVersion: number;
  expectedTargetDigest?: string;
  approvedAt: string;
  priorActiveSha256: string;
  nextActiveSha256: string;
  nextActive: EvolutionActiveSnapshotBytes;
  authorization: string;
}

export interface EvolutionPromotionResult {
  candidate: EvolutionCandidate;
  profile: EvolutionProfile;
  history: EvolutionHistoryRecord;
}

export interface EvolutionStoreOptions {
  now?: () => string;
  uuid?: () => string;
  reservedSkillNames?: (agent: string) => ReadonlySet<string>;
  /** Production authority custody. Omit only for isolated store tests/tools without a host. */
  authorityIntegrityKey?: () => Buffer | undefined;
  authorityHead?: AuthorityHeadPort;
  /** Fault-injection seam for promotion recovery tests. */
  promotionFault?: (point: EvolutionPromotionFaultPoint) => void | Promise<void>;
  /** Fault-injection seam for initial-profile journal recovery tests. */
  creationFault?: () => void | Promise<void>;
  /** Fault-injection seam after atomic rename publication and before source quarantine. */
  renameFault?: () => void | Promise<void>;
  /** Test seam for best-effort cleanup after a renamed source is quarantined. */
  retiredRootCleanup?: (root: string) => Promise<void>;
  /** Fault-injection seam for the atomic source quarantine during rename. */
  quarantineRoot?: (source: string, quarantined: string) => Promise<void>;
  /** Host-owned materialization root for session-pinned skill bundles. */
  sessionSnapshotsRoot?: string;
}

export interface EvolutionActiveSnapshotBytes {
  profile: EvolutionProfile;
  learnings: string;
  skills: Array<{ name: string; files: EvolutionSkillFile[] }>;
}

export function evolutionActiveSnapshotDigest(active: EvolutionActiveSnapshotBytes): string {
  return crypto.createHash("sha256").update(JSON.stringify(active), "utf8").digest("hex");
}

export type EvolutionPromotionFaultPoint =
  | "after-intent"
  | "after-target"
  | "after-history"
  | "after-profile"
  | "after-candidate"
  | "after-authority";

interface EvolutionPromotionIntent {
  schemaVersion: 1;
  agent: string;
  candidateId: string;
  previousVersion: number;
  nextVersion: number;
  previousHead: AuthorityHead;
  nextHead: AuthorityHead;
  target: { kind: "learning" } | { kind: "skill"; name: string };
  historyFile: string;
  previousProfile: EvolutionProfile;
  previousCandidate: EvolutionCandidate;
  previousLearnings: string;
  previousSkillFiles?: EvolutionSkillFile[];
}

type EvolutionCreationIntent = AuthorityRecord & {
  schemaVersion: 1;
  kind: "agent-evolution-create";
  agent: string;
  profile: EvolutionProfile;
  head: AuthorityHead;
};

type EvolutionRenameIntent = AuthorityRecord & {
  schemaVersion: 1;
  kind: "agent-evolution-rename";
  oldAgent: string;
  newAgent: string;
  profileId: string;
  retiredRoot: string;
  previousHead: AuthorityHead;
  nextHead: AuthorityHead;
};

function assertAgentName(agent: string): void {
  if (!isValidAgentName(agent)) {
    throw new EvolutionStoreError("evolution/path-invalid", `invalid evolution agent name '${agent}'`);
  }
}

function assertRecordId(kind: string, id: string): void {
  if (!SAFE_RECORD_ID.test(id)) {
    throw new EvolutionStoreError("evolution/path-invalid", `invalid evolution ${kind} id '${id}'`);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseProfile(raw: string, agent: string): EvolutionProfile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new EvolutionStoreError("evolution/profile-malformed", `Evolution Profile for '${agent}' is not valid JSON`);
  }
  const profile = value as Partial<EvolutionProfile>;
  if (
    profile.schemaVersion !== EVOLUTION_SCHEMA_VERSION
    || !requiredString(profile.profileId)
    || profile.agent !== agent
    || !Number.isSafeInteger(profile.activeVersion)
    || (profile.activeVersion ?? -1) < 0
    || !requiredString(profile.createdAt)
    || !requiredString(profile.updatedAt)
  ) {
    throw new EvolutionStoreError("evolution/profile-malformed", `Evolution Profile for '${agent}' has an invalid v1 shape`);
  }
  return profile as EvolutionProfile;
}

function isSkillTarget(value: unknown): value is EvolutionSkillTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<EvolutionSkillTarget>;
  if (!(target.kind === "skill"
    && (target.operation === "create" || target.operation === "update")
    && requiredString(target.name)
    && requiredString(target.reason)
    && typeof target.digest === "string" && SHA256_RE.test(target.digest)
    && Array.isArray(target.files))) return false;
  const validation = validateEvolutionSkillBundle({
    operation: target.operation,
    name: target.name,
    reason: target.reason,
    ...(target.expectedTargetDigest !== undefined ? { expectedTargetDigest: target.expectedTargetDigest } : {}),
    files: target.files,
  });
  return validation.ok && validation.bundle.digest === target.digest;
}

function isLearningTarget(value: unknown): value is EvolutionLearningTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<EvolutionLearningTarget>;
  return target.kind === "learning" && requiredString(target.content) && requiredString(target.reason);
}

function parseCandidate(raw: string, agent: string, expectedId: string): EvolutionCandidate {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new EvolutionStoreError("evolution/candidate-malformed", `Evolution candidate '${expectedId}' is not valid JSON`);
  }
  const candidate = value as Partial<EvolutionCandidate>;
  if (
    candidate.schemaVersion !== EVOLUTION_SCHEMA_VERSION
    || candidate.id !== expectedId
    || candidate.agent !== agent
    || !requiredString(candidate.reviewId)
    || !requiredString(candidate.taskId)
    || !requiredString(candidate.createdAt)
    || !["pending", "approved", "rejected"].includes(candidate.status ?? "")
    || (!isLearningTarget(candidate.target) && !isSkillTarget(candidate.target))
    || (candidate.resolvedAt !== undefined && !requiredString(candidate.resolvedAt))
    || (candidate.promotedVersion !== undefined && (!Number.isSafeInteger(candidate.promotedVersion) || candidate.promotedVersion < 1))
    || (candidate.status === "pending" && (candidate.resolvedAt !== undefined || candidate.promotedVersion !== undefined))
    || (candidate.status === "rejected" && candidate.promotedVersion !== undefined)
  ) {
    throw new EvolutionStoreError("evolution/candidate-malformed", `Evolution candidate '${expectedId}' has an invalid v1 shape`);
  }
  return candidate as EvolutionCandidate;
}

function parseLearnings(raw: string, agent: string): EvolutionLearning[] {
  if (!raw.startsWith("# Learned Context\n\nHuman-approved context for this Tachyon agent.\n")) {
    throw new EvolutionStoreError("evolution/profile-malformed", `Evolution learnings for '${agent}' have an invalid v1 header`);
  }
  const marker = /^<!-- learning:([A-Za-z0-9_-]+) task:([^\s]+) review:([A-Za-z0-9_-]+) approved:([^\s]+) -->$/gm;
  const matches = [...raw.matchAll(marker)];
  if (matches.length === 0) {
    if (raw !== renderEvolutionLearnings([])) {
      throw new EvolutionStoreError("evolution/profile-malformed", `Evolution learnings for '${agent}' have invalid content`);
    }
    return [];
  }
  const entries: EvolutionLearning[] = [];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!;
    const contentStart = (match.index ?? 0) + match[0].length + 1;
    const contentEnd = index + 1 < matches.length ? matches[index + 1]!.index! - 2 : raw.length;
    const content = raw.slice(contentStart, contentEnd).trim();
    const approvedAt = match[4]!;
    if (!content || !Number.isFinite(Date.parse(approvedAt))) {
      throw new EvolutionStoreError("evolution/profile-malformed", `Evolution learnings for '${agent}' contain an invalid entry`);
    }
    entries.push({
      id: match[1]!,
      sourceTaskId: match[2]!,
      sourceReviewId: match[3]!,
      approvedAt,
      content,
    });
  }
  if (renderEvolutionLearnings(entries) !== raw) {
    throw new EvolutionStoreError("evolution/profile-malformed", `Evolution learnings for '${agent}' are not canonical`);
  }
  return entries;
}

function parseReview(raw: string, agent: string, expectedId: string): EvolutionReview {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new EvolutionStoreError("evolution/review-malformed", `Evolution review '${expectedId}' is not valid JSON`);
  }
  const review = value as Partial<EvolutionReview>;
  const anchor = review.sessionAnchor;
  const delivery = review.delivery;
  if (
    review.schemaVersion !== EVOLUTION_SCHEMA_VERSION
    || review.id !== expectedId
    || review.agent !== agent
    || !requiredString(review.taskId)
    || !requiredString(review.taskTitle)
    || !requiredString(review.completionRevision)
    || !requiredString(review.createdAt)
    || !requiredString(review.updatedAt)
    || !["pending", "submitted", "no-proposal", "failed"].includes(review.status ?? "")
    || !anchor || !requiredString(anchor.session)
    || (anchor.activitySeq !== undefined && (!Number.isSafeInteger(anchor.activitySeq) || anchor.activitySeq < 0))
    || !delivery || !["not-attempted", "notified", "queued", "failed"].includes(delivery.status)
    || (delivery.detail !== undefined && typeof delivery.detail !== "string")
    || !Array.isArray(review.candidateIds) || review.candidateIds.some((id) => typeof id !== "string" || !SAFE_RECORD_ID.test(id))
    || (review.submissionDigest !== undefined && !SHA256_RE.test(review.submissionDigest))
    || (review.failure !== undefined && typeof review.failure !== "string")
  ) {
    throw new EvolutionStoreError("evolution/review-malformed", `Evolution review '${expectedId}' has an invalid v1 shape`);
  }
  return review as EvolutionReview;
}

/** Canonical runtime-neutral store under `.tachyon/agents/<agent>/evolution/`. */
export class EvolutionStore {
  private readonly now: () => string;
  private readonly uuid: () => string;
  private readonly reservedSkillNames: (agent: string) => ReadonlySet<string>;
  private readonly authorityIntegrityKey: (() => Buffer | undefined) | undefined;
  private readonly authorityHead: AuthorityHeadPort | undefined;
  private readonly promotionFault: ((point: EvolutionPromotionFaultPoint) => void | Promise<void>) | undefined;
  private readonly creationFault: (() => void | Promise<void>) | undefined;
  private readonly renameFault: (() => void | Promise<void>) | undefined;
  private readonly retiredRootCleanup: (root: string) => Promise<void>;
  private readonly quarantineRoot: (source: string, quarantined: string) => Promise<void>;
  private readonly sessionSnapshotsRoot: string;
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly workspaceRoot: string,
    options: EvolutionStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.reservedSkillNames = options.reservedSkillNames ?? (() => new Set());
    this.authorityIntegrityKey = options.authorityIntegrityKey;
    this.authorityHead = options.authorityHead;
    this.promotionFault = options.promotionFault;
    this.creationFault = options.creationFault;
    this.renameFault = options.renameFault;
    this.retiredRootCleanup = options.retiredRootCleanup
      ?? ((root) => fs.rm(root, { recursive: true, force: true }));
    this.quarantineRoot = options.quarantineRoot ?? ((source, quarantined) => fs.rename(source, quarantined));
    this.sessionSnapshotsRoot = options.sessionSnapshotsRoot
      ?? path.join(this.workspaceRoot, ".tachyon", "evolution-session-snapshots");
    if ((this.authorityIntegrityKey === undefined) !== (this.authorityHead === undefined)) {
      throw new Error("Agent Evolution authority key and freshness head must be configured together");
    }
  }

  rootFor(agent: string): string {
    assertAgentName(agent);
    return path.join(this.workspaceRoot, ".tachyon", "agents", agent, "evolution");
  }

  profilePath(agent: string): string {
    return path.join(this.rootFor(agent), "profile.json");
  }

  learningsPath(agent: string): string {
    return path.join(this.rootFor(agent), "LEARNINGS.md");
  }

  private async openEvolutionRootAnchored(agent: string): Promise<Awaited<ReturnType<typeof fs.open>>> {
    assertAgentName(agent);
    let current = await openNoFollowDirectory(this.workspaceRoot, "Evolution workspace root");
    try {
      for (const segment of [".tachyon", "agents", agent, "evolution"]) {
        const next = await openNoFollowDirectory(`/proc/self/fd/${current.fd}/${segment}`, `Evolution path component '${segment}'`);
        await current.close();
        current = next;
      }
      return current;
    } catch (error) {
      await current.close();
      throw error;
    }
  }

  private async readActiveLearningsUnlocked(agent: string): Promise<string> {
    const root = await this.openEvolutionRootAnchored(agent);
    try {
      return await readBoundedNoFollowUtf8(`/proc/self/fd/${root.fd}/LEARNINGS.md`, ACTIVE_TEXT_MAX_BYTES, "active Evolution learnings");
    } finally { await root.close(); }
  }

  candidatesDir(agent: string): string {
    return path.join(this.rootFor(agent), "candidates");
  }

  reviewsDir(agent: string): string {
    return path.join(this.rootFor(agent), "reviews");
  }

  reviewPath(agent: string, reviewId: string): string {
    assertRecordId("review", reviewId);
    return path.join(this.reviewsDir(agent), `${reviewId}.json`);
  }

  candidatePath(agent: string, candidateId: string): string {
    assertRecordId("candidate", candidateId);
    return path.join(this.candidatesDir(agent), `${candidateId}.json`);
  }

  historyDir(agent: string): string {
    return path.join(this.rootFor(agent), "history");
  }

  promotionDir(agent: string): string {
    return path.join(this.rootFor(agent), "promotion");
  }

  promotionIntentPath(agent: string): string {
    return path.join(this.promotionDir(agent), "intent.json");
  }

  creationIntentPath(agent: string): string {
    return path.join(this.rootFor(agent), "creation-intent.json");
  }

  renameIntentPath(agent: string): string {
    return path.join(this.rootFor(agent), "rename-intent.json");
  }

  skillsDir(agent: string): string {
    return path.join(this.rootFor(agent), "skills");
  }

  skillDir(agent: string, skillName: string): string {
    if (!SAFE_SKILL_NAME.test(skillName)) {
      throw new EvolutionStoreError("evolution/path-invalid", `invalid evolution skill name '${skillName}'`);
    }
    return path.join(this.skillsDir(agent), skillName);
  }

  sessionSnapshotRoot(profileId: string): string {
    return path.join(this.sessionSnapshotsRoot, crypto.createHash("sha256").update(profileId, "utf8").digest("hex"));
  }

  async readProfile(agent: string): Promise<EvolutionProfile | undefined> {
    assertAgentName(agent);
    const profile = await this.readProfileFile(agent);
    if (profile) await this.assertAuthorizedStateUnlocked(agent, profile);
    return profile;
  }

  private async readProfileFile(agent: string): Promise<EvolutionProfile | undefined> {
    try {
      return parseProfile(await fs.readFile(this.profilePath(agent), "utf8"), agent);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async ensureProfile(agent: string): Promise<EvolutionProfile> {
    return this.withAgentMutation(agent, async () => {
      await this.reconcilePromotionUnlocked(agent);
      return this.ensureProfileUnlocked(agent);
    });
  }

  /** Capture and authenticate the exact active bytes delivered to a fresh runtime. */
  async readAuthorizedActiveState(agent: string): Promise<EvolutionActiveSnapshotBytes> {
    return this.withAgentMutation(agent, async () => {
      await this.reconcilePromotionUnlocked(agent);
      const profile = await this.ensureProfileUnlocked(agent);
      const learnings = await this.readActiveLearningsUnlocked(agent);
      parseLearnings(learnings, agent);
      const skills: EvolutionActiveSnapshotBytes["skills"] = [];
      const budget = { files: 0, bytes: 0 };
      const skillNames = await this.listSkillNamesUnlocked(agent);
      for (const name of skillNames) {
        const files = await this.readSkillFilesUnlocked(agent, name, budget);
        if (files) skills.push({ name, files });
      }
      if (formationActiveNamesDigest(skillNames) !== formationActiveNamesDigest(await this.listSkillNamesUnlocked(agent))) {
        throw new EvolutionStoreError("evolution/authority-invalid", "active Evolution skills changed during capture");
      }
      const expected = this.authorityHeadForCapturedState(agent, profile, learnings, skills);
      await this.assertExpectedAuthorityHeadUnlocked(agent, profile, expected);
      return { profile, learnings, skills };
    });
  }

  /** Retire one name-scoped authority identity before canonical agent footprint deletion. */
  async retireAgent(agent: string, expectedProfileId?: string | null): Promise<void> {
    assertAgentName(agent);
    if (!this.authorityHead) return;
    if (!this.authorityHead.retire) {
      throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution approval authority cannot retire agent identities");
    }
    await this.withAgentMutation(agent, async () => {
      try {
        await fs.access(this.renameIntentPath(agent));
        const profile = await this.readProfileFile(agent);
        if (!profile) throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution rename profile is missing");
        await this.reconcileRenameIntentUnlocked(agent, profile);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (expectedProfileId !== undefined) {
        const stored = await this.readProfileFile(agent);
        if ((expectedProfileId === null && stored !== undefined)
          || (typeof expectedProfileId === "string" && stored?.profileId !== expectedProfileId)) {
          throw new EvolutionStoreError(
            "evolution/authority-invalid",
            `Agent Evolution identity changed before retirement for '${agent}'`,
          );
        }
      }
      const current = await this.authorityHead!.current(this.authorityIdentity(agent));
      if (!current) return;
      await this.authorityHead!.retire!(this.authorityIdentity(agent), current.mac);
    });
  }

  /** Move one canonical profile to a renamed Tachyon agent without changing its identity or version. */
  async renameAgent(oldAgent: string, newAgent: string): Promise<boolean> {
    assertAgentName(oldAgent);
    assertAgentName(newAgent);
    if (oldAgent === newAgent) return (await this.readProfile(oldAgent)) !== undefined;
    return this.withAgentMutations([oldAgent, newAgent], async () => {
      const preparedDestination = await this.readProfileFile(newAgent);
      if (preparedDestination) {
        try {
          await fs.access(this.renameIntentPath(newAgent));
          await this.reconcileRenameIntentUnlocked(newAgent, preparedDestination);
          return true;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        throw new EvolutionStoreError(
          "evolution/profile-conflict",
          `Agent Evolution Profile already exists for '${newAgent}'`,
        );
      }
      await this.reconcilePromotionUnlocked(oldAgent);
      const profile = await this.readProfile(oldAgent);
      if (!profile) return false;
      let destinationExists = false;
      try {
        await fs.access(this.rootFor(newAgent));
        destinationExists = true;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (destinationExists) {
        throw new EvolutionStoreError(
          "evolution/profile-conflict",
          `Agent Evolution Profile already exists for '${newAgent}'`,
        );
      }

      const oldRoot = this.rootFor(oldAgent);
      const newRoot = this.rootFor(newAgent);
      const newParent = path.dirname(newRoot);
      const staging = path.join(newParent, `.evolution-rename-${this.uuid()}`);
      await fs.mkdir(newParent, { recursive: true });
      try {
        await fs.cp(oldRoot, staging, { recursive: true, errorOnExist: true, force: false });
        const rewriteOwnedJson = async (file: string, profileFile = false): Promise<void> => {
          const value = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
          if (value.agent !== oldAgent) {
            throw new EvolutionStoreError(
              "evolution/profile-malformed",
              `Evolution rename found mismatched owner in '${path.basename(file)}'`,
            );
          }
          value.agent = newAgent;
          if (profileFile) value.updatedAt = this.now();
          await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        };
        await rewriteOwnedJson(path.join(staging, "profile.json"), true);
        for (const directory of ["candidates", "reviews", "history"]) {
          let names: string[];
          try {
            names = await fs.readdir(path.join(staging, directory));
          } catch (error) {
            if (isMissing(error)) continue;
            throw error;
          }
          for (const name of names) {
            if (name.endsWith(".json")) await rewriteOwnedJson(path.join(staging, directory, name));
          }
        }
        const renamedProfile = parseProfile(await fs.readFile(path.join(staging, "profile.json"), "utf8"), newAgent);
        let previousHead: AuthorityHead | undefined;
        let nextHead: AuthorityHead | undefined;
        const retiredRoot = path.join(newParent, `.retired-evolution-${oldAgent}-${crypto.randomUUID()}`);
        if (this.authorityHead) {
          if (!this.authorityHead.move) {
            throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution approval authority cannot move agent identities");
          }
          // Calculate both heads while the old root and its authority identity still agree.
          const active = await this.capturedStateBytesUnlocked(oldAgent, profile);
          previousHead = this.authorityHeadForCapturedState(oldAgent, profile, active.learnings, active.skills);
          await this.assertExpectedAuthorityHeadUnlocked(oldAgent, profile, previousHead);
          nextHead = this.authorityHeadForCapturedState(newAgent, renamedProfile, active.learnings, active.skills);
          await this.writeRenameIntentUnlocked({
            schemaVersion: 1,
            kind: "agent-evolution-rename",
            oldAgent,
            newAgent,
            profileId: renamedProfile.profileId,
            retiredRoot,
            previousHead,
            nextHead,
          }, path.join(staging, "rename-intent.json"));
        }
        // Publish the prepared profile and its recovery journal in one atomic directory rename.
        await fs.rename(staging, newRoot);
        await this.renameFault?.();

        // Quarantine the source before authority moves. If this atomic rename fails, the old
        // identity is still authoritative and the prepared destination can be discarded safely.
        try {
          await this.quarantineRoot(oldRoot, retiredRoot);
        } catch (error) {
          await fs.rm(newRoot, { recursive: true, force: true });
          throw error;
        }

        if (this.authorityHead && previousHead && nextHead) {
          try {
            await this.authorityHead.move!(
              this.authorityIdentity(oldAgent),
              this.authorityIdentity(newAgent),
              nextHead,
              previousHead.mac,
            );
          } catch (error) {
            let committed: AuthorityHead | undefined;
            try {
              committed = await this.authorityHead.current(this.authorityIdentity(newAgent));
            } catch {
              // The signed journal plus both prepared roots make the desired rename recoverable.
              // Keep the config-facing rename committed; the next store access retries the same
              // idempotent authority move instead of rolling Workspace/YAML back inconsistently.
              return true;
            }
            if (committed?.revision !== nextHead.revision || committed.mac !== nextHead.mac) {
              try {
                await fs.rename(retiredRoot, oldRoot);
                await fs.rm(newRoot, { recursive: true, force: true });
              } catch (rollbackError) {
                throw new AggregateError([error, rollbackError], "Agent Evolution rename and rollback both failed");
              }
              throw error;
            }
          }
        }
        await fs.rm(this.renameIntentPath(newAgent), { force: true });
        await this.retiredRootCleanup(retiredRoot).catch(() => undefined);
        return true;
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
    });
  }

  async createCandidate(agent: string, input: CreateEvolutionCandidateInput): Promise<EvolutionCandidate> {
    return this.withAgentMutation(agent, async () => {
      await this.reconcilePromotionUnlocked(agent);
      await this.ensureProfileUnlocked(agent);
      if (!requiredString(input.reviewId) || !requiredString(input.taskId)) {
        throw new EvolutionStoreError("evolution/candidate-malformed", "Evolution candidate requires reviewId and taskId");
      }

      const target = this.normalizeCandidateTarget(input.target);

      const id = `candidate-${this.uuid()}`;
      assertRecordId("candidate", id);
      const candidate: EvolutionCandidate = {
        schemaVersion: EVOLUTION_SCHEMA_VERSION,
        id,
        agent,
        reviewId: input.reviewId,
        taskId: input.taskId,
        createdAt: this.now(),
        status: "pending",
        target,
      };

      await this.assertNoPendingSkillCollision(agent, candidate, new Set());

      await this.atomicWriteJson(this.candidatePath(agent, id), candidate);
      return candidate;
    });
  }

  async readCandidate(agent: string, candidateId: string): Promise<EvolutionCandidate | undefined> {
    try {
      return parseCandidate(await fs.readFile(this.candidatePath(agent, candidateId), "utf8"), agent, candidateId);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async listCandidates(agent: string): Promise<EvolutionCandidate[]> {
    assertAgentName(agent);
    return this.listCandidatesUnlocked(agent);
  }

  async candidateDetail(agent: string, candidateId: string): Promise<EvolutionCandidateDetail> {
    const profile = await this.readProfile(agent);
    const candidate = await this.readCandidate(agent, candidateId);
    if (!profile || !candidate) {
      throw new EvolutionStoreError("evolution/promotion-conflict", `unknown Evolution candidate '${candidateId}' for agent '${agent}'`);
    }
    const currentTargetDigest = await this.currentTargetDigest(agent, candidate);
    return {
      candidate,
      activeVersion: profile.activeVersion,
      ...(currentTargetDigest !== undefined ? { currentTargetDigest } : {}),
    };
  }

  async rejectCandidate(
    agent: string,
    candidateId: string,
    input: ResolveEvolutionCandidateInput,
  ): Promise<EvolutionCandidate> {
    return this.withAgentMutation(agent, async () => {
      await this.reconcilePromotionUnlocked(agent);
      const { profile, candidate } = await this.requirePendingCandidate(agent, candidateId, input);
      void profile;
      const rejected: EvolutionCandidate = {
        ...candidate,
        status: "rejected",
        resolvedAt: this.now(),
      };
      await this.atomicWriteJson(this.candidatePath(agent, candidateId), rejected);
      return rejected;
    });
  }

  private formationTokenAuthorization(token: Omit<EvolutionFormationPromotionToken, "authorization">): string {
    const payload = JSON.stringify(token);
    const key = this.authorityIntegrityKey?.();
    if (!key) throw new EvolutionStoreError("evolution/authority-invalid", "Evolution formation promotion requires durable host authority custody");
    return crypto.createHmac("sha256", key).update("tachyon:evolution-formation-promotion:v1\0").update(this.workspaceRoot).update("\0").update(payload).digest("hex");
  }

  verifyFormationPromotionToken(token: EvolutionFormationPromotionToken): boolean {
    const { authorization, ...payload } = token;
    if (token.schemaVersion !== 1 || !requiredString(token.agent) || !requiredString(token.candidateId)
      || !requiredString(token.reviewId) || !Number.isSafeInteger(token.expectedActiveVersion)
      || !requiredString(token.approvedAt) || !SHA256_RE.test(token.priorActiveSha256)
      || !SHA256_RE.test(token.nextActiveSha256) || evolutionActiveSnapshotDigest(token.nextActive) !== token.nextActiveSha256) return false;
    let expected: string;
    try { expected = this.formationTokenAuthorization(payload); } catch { return false; }
    const actualBytes = SHA256_RE.test(authorization) ? Buffer.from(authorization, "hex") : Buffer.alloc(0);
    const expectedBytes = Buffer.from(expected, "hex");
    return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
  }

  /** Prepare the exact result of one pending human-reviewed candidate without publishing active bytes. */
  async prepareFormationPromotion(
    agent: string,
    candidateId: string,
    input: ResolveEvolutionCandidateInput,
  ): Promise<EvolutionFormationPromotionToken> {
    return this.withAgentMutation(agent, async () => {
      await this.reconcilePromotionUnlocked(agent);
      const { profile, candidate } = await this.requirePendingCandidate(agent, candidateId, input);
      const prior = await this.capturedStateBytesUnlocked(agent, profile);
      const approvedAt = this.now();
      const nextProfile: EvolutionProfile = { ...profile, activeVersion: profile.activeVersion + 1, updatedAt: approvedAt };
      let nextLearnings = prior.learnings;
      const nextSkills = structuredClone(prior.skills);
      if (candidate.target.kind === "learning") {
        const entries = await this.readLearningsUnlocked(agent);
        nextLearnings = renderEvolutionLearnings([...entries, {
          id: `learning-${candidate.id.slice("candidate-".length)}`,
          content: candidate.target.content,
          sourceTaskId: candidate.taskId,
          sourceReviewId: candidate.reviewId,
          approvedAt,
        }]);
      } else {
        const target = candidate.target;
        if (this.reservedSkillNames(agent).has(target.name)
          || input.reservedSkillNames?.has(target.name)) {
          throw new EvolutionStoreError("evolution/promotion-conflict", `skill '${target.name}' is declared by the human-owned harness and cannot be replaced by Agent Evolution`);
        }
        const index = nextSkills.findIndex((skill) => skill.name === target.name);
        if (target.operation === "create" && index >= 0) {
          throw new EvolutionStoreError("evolution/promotion-conflict", `skill '${target.name}' already exists`);
        }
        if (target.operation === "update" && index < 0) {
          throw new EvolutionStoreError("evolution/promotion-conflict", `skill '${target.name}' changed since the proposal was created`);
        }
        const replacement = { name: target.name, files: structuredClone(target.files) };
        if (index >= 0) nextSkills[index] = replacement;
        else nextSkills.push(replacement);
        nextSkills.sort((a, b) => compareText(a.name, b.name));
      }
      const nextActive: EvolutionActiveSnapshotBytes = { profile: nextProfile, learnings: nextLearnings, skills: nextSkills };
      const payload: Omit<EvolutionFormationPromotionToken, "authorization"> = {
        schemaVersion: 1,
        agent,
        candidateId: candidate.id,
        reviewId: candidate.reviewId,
        expectedActiveVersion: input.expectedActiveVersion,
        ...(input.expectedTargetDigest !== undefined ? { expectedTargetDigest: input.expectedTargetDigest } : {}),
        approvedAt,
        priorActiveSha256: evolutionActiveSnapshotDigest(prior),
        nextActiveSha256: evolutionActiveSnapshotDigest(nextActive),
        nextActive,
      };
      return { ...payload, authorization: this.formationTokenAuthorization(payload) };
    });
  }

  async approvePreparedFormationPromotion(token: EvolutionFormationPromotionToken): Promise<EvolutionPromotionResult> {
    if (!this.verifyFormationPromotionToken(token)) {
      throw new EvolutionStoreError("evolution/authority-invalid", "Evolution formation promotion token is invalid");
    }
    const prior = await this.readAuthorizedActiveState(token.agent);
    if (evolutionActiveSnapshotDigest(prior) !== token.priorActiveSha256) {
      throw new EvolutionStoreError("evolution/promotion-conflict", "Evolution active state changed after formation preparation");
    }
    const result = await this.approveCandidate(token.agent, token.candidateId, {
      expectedActiveVersion: token.expectedActiveVersion,
      ...(token.expectedTargetDigest !== undefined ? { expectedTargetDigest: token.expectedTargetDigest } : {}),
      approvedAt: token.approvedAt,
    });
    const active = await this.readAuthorizedActiveState(token.agent);
    if (evolutionActiveSnapshotDigest(active) !== token.nextActiveSha256) {
      throw new EvolutionStoreError("evolution/authority-invalid", "Evolution approved state does not match its prepared formation token");
    }
    return result;
  }

  async approveCandidate(
    agent: string,
    candidateId: string,
    input: ResolveEvolutionCandidateInput & { approvedAt?: string },
  ): Promise<EvolutionPromotionResult> {
    return this.withAgentMutation(agent, async () => {
      await this.reconcilePromotionUnlocked(agent);
      const { profile, candidate } = await this.requirePendingCandidate(agent, candidateId, input);
      const promotedVersion = profile.activeVersion + 1;
      const recordedAt = input.approvedAt ?? this.now();
      let previousDigest: string | undefined;
      let previousSkillFiles: EvolutionSkillFile[] | undefined;
      let promotedDigest: string;
      let nextLearnings: string | undefined;

      if (candidate.target.kind === "learning") {
        const entries = await this.readLearningsUnlocked(agent);
        const learning: EvolutionLearning = {
          id: `learning-${candidate.id.slice("candidate-".length)}`,
          content: candidate.target.content,
          sourceTaskId: candidate.taskId,
          sourceReviewId: candidate.reviewId,
          approvedAt: recordedAt,
        };
        nextLearnings = renderEvolutionLearnings([...entries, learning]);
        promotedDigest = crypto.createHash("sha256").update(nextLearnings, "utf8").digest("hex");
      } else {
        if (this.reservedSkillNames(agent).has(candidate.target.name)
          || input.reservedSkillNames?.has(candidate.target.name)) {
          throw new EvolutionStoreError(
            "evolution/promotion-conflict",
            `skill '${candidate.target.name}' is declared by the human-owned harness and cannot be replaced by Agent Evolution`,
          );
        }
        previousSkillFiles = await this.readSkillFilesUnlocked(agent, candidate.target.name);
        previousDigest = previousSkillFiles ? digestEvolutionSkillFiles(previousSkillFiles) : undefined;
        if (candidate.target.operation === "create" && previousSkillFiles) {
          throw new EvolutionStoreError("evolution/promotion-conflict", `skill '${candidate.target.name}' already exists`);
        }
        if (candidate.target.operation === "update"
          && (!previousSkillFiles || previousDigest !== candidate.target.expectedTargetDigest)) {
          throw new EvolutionStoreError("evolution/promotion-conflict", `skill '${candidate.target.name}' changed since the proposal was created`);
        }
        promotedDigest = candidate.target.digest;
      }

      const history: EvolutionHistoryRecord = {
        schemaVersion: EVOLUTION_SCHEMA_VERSION,
        id: `promotion-${candidate.id.slice("candidate-".length)}`,
        agent,
        version: promotedVersion,
        candidateId: candidate.id,
        target: candidate.target.kind,
        recordedAt,
        ...(previousDigest !== undefined ? { previousDigest } : {}),
        promotedDigest,
        ...(previousSkillFiles !== undefined ? { previousSkillFiles } : {}),
      };
      const nextProfile: EvolutionProfile = {
        ...profile,
        activeVersion: promotedVersion,
        updatedAt: recordedAt,
      };
      const approved: EvolutionCandidate = {
        ...candidate,
        status: "approved",
        resolvedAt: recordedAt,
        promotedVersion,
      };
      const previousHead = await this.assertAuthorizedStateUnlocked(agent, profile);
      const previousLearnings = await fs.readFile(this.learningsPath(agent), "utf8");
      const nextHead = await this.calculatedAuthorityHead(agent, nextProfile, candidate.target.kind === "learning"
        ? { learnings: nextLearnings }
        : { skill: { name: candidate.target.name, files: candidate.target.files } });
      const historyFile = `${String(history.version).padStart(6, "0")}-${history.id}.json`;
      const intent: EvolutionPromotionIntent = {
        schemaVersion: 1,
        agent,
        candidateId: candidate.id,
        previousVersion: profile.activeVersion,
        nextVersion: nextProfile.activeVersion,
        previousHead,
        nextHead,
        target: candidate.target.kind === "learning"
          ? { kind: "learning" }
          : { kind: "skill", name: candidate.target.name },
        historyFile,
        previousProfile: profile,
        previousCandidate: candidate,
        previousLearnings,
        ...(previousSkillFiles ? { previousSkillFiles } : {}),
      };
      await fs.rm(this.promotionDir(agent), { recursive: true, force: true });
      await this.atomicWriteJson(this.promotionIntentPath(agent), intent);
      await this.fault("after-intent");
      try {
        if (candidate.target.kind === "learning") {
          await this.atomicWrite(this.learningsPath(agent), nextLearnings!);
        } else {
          await this.writeSkillBundleUnlocked(agent, candidate.target.name, candidate.target.files, candidate.target.operation);
        }
        await this.fault("after-target");
        await this.recordHistoryUnlocked(agent, history);
        await this.fault("after-history");
        await this.atomicWriteJson(this.profilePath(agent), nextProfile);
        await this.fault("after-profile");
        await this.atomicWriteJson(this.candidatePath(agent, candidate.id), approved);
        await this.fault("after-candidate");
        if (this.authorityHead) {
          await this.authorityHead.prepare(this.authorityIdentity(agent), nextHead, previousHead.mac);
          const committed = await this.authorityHead.current(this.authorityIdentity(agent));
          if (committed?.revision !== nextHead.revision || committed.mac !== nextHead.mac) {
            throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution approval head was not durably committed");
          }
        }
        await this.fault("after-authority");
        await fs.rm(this.promotionDir(agent), { recursive: true, force: true });
        return { candidate: approved, profile: nextProfile, history };
      } catch (error) {
        await this.reconcilePromotionUnlocked(agent);
        const recoveredProfile = await this.readProfileFile(agent);
        const recoveredCandidate = await this.readCandidate(agent, candidate.id);
        if (recoveredProfile?.activeVersion === nextProfile.activeVersion
          && recoveredCandidate?.status === "approved"
          && recoveredCandidate.promotedVersion === nextProfile.activeVersion) {
          return { candidate: recoveredCandidate, profile: recoveredProfile, history };
        }
        throw error;
      }
    });
  }

  async readLearnings(agent: string): Promise<EvolutionLearning[]> {
    assertAgentName(agent);
    return this.readLearningsUnlocked(agent);
  }

  async readSkillFiles(agent: string, skillName: string): Promise<EvolutionSkillFile[] | undefined> {
    assertAgentName(agent);
    return this.readSkillFilesUnlocked(agent, skillName);
  }

  async listSkillNames(agent: string): Promise<string[]> {
    assertAgentName(agent);
    const profile = await this.readProfile(agent);
    if (!profile) return [];
    return this.listSkillNamesUnlocked(agent);
  }

  private async listSkillNamesUnlocked(agent: string): Promise<string[]> {
    let entries: Dirent[];
    let evolutionRoot: Awaited<ReturnType<typeof fs.open>> | undefined;
    let skillsRoot: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      evolutionRoot = await this.openEvolutionRootAnchored(agent);
      skillsRoot = await openNoFollowDirectory(`/proc/self/fd/${evolutionRoot.fd}/skills`, "active Evolution skills root");
      const before = await skillsRoot.stat({ bigint: true });
      entries = await fs.readdir(`/proc/self/fd/${skillsRoot.fd}`, { withFileTypes: true });
      const after = await skillsRoot.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw new EvolutionStoreError("evolution/authority-invalid", "active Evolution skills root changed during enumeration");
      }
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    } finally {
      await skillsRoot?.close();
      await evolutionRoot?.close();
    }
    for (const entry of entries) {
      if (!SAFE_SKILL_NAME.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new EvolutionStoreError("evolution/skill-invalid", `active Evolution skills root contains unsafe entry '${entry.name}'`);
      }
    }
    return entries.map((entry) => entry.name).sort(compareText);
  }

  async createReview(agent: string, input: CreateEvolutionReviewInput): Promise<{ review: EvolutionReview; created: boolean }> {
    return this.withAgentMutation(agent, async () => {
      await this.ensureProfileUnlocked(agent);
      if (!requiredString(input.taskId) || !requiredString(input.taskTitle.trim())
        || !SHA256_RE.test(input.completionRevision) || !requiredString(input.session)
        || (input.activitySeq !== undefined && (!Number.isSafeInteger(input.activitySeq) || input.activitySeq < 0))) {
        throw new EvolutionStoreError("evolution/review-malformed", "Evolution review input has an invalid v1 shape");
      }
      const existing = (await this.listReviewsUnlocked(agent))
        .find((review) => review.completionRevision === input.completionRevision);
      if (existing) return { review: existing, created: false };

      const now = this.now();
      const id = `review-${this.uuid()}`;
      assertRecordId("review", id);
      const review: EvolutionReview = {
        schemaVersion: EVOLUTION_SCHEMA_VERSION,
        id,
        agent,
        taskId: input.taskId,
        taskTitle: input.taskTitle.trim(),
        completionRevision: input.completionRevision,
        createdAt: now,
        updatedAt: now,
        status: "pending",
        sessionAnchor: {
          session: input.session,
          ...(input.activitySeq !== undefined ? { activitySeq: input.activitySeq } : {}),
        },
        delivery: { status: "not-attempted" },
        candidateIds: [],
      };
      await this.atomicWriteJson(this.reviewPath(agent, id), review);
      return { review, created: true };
    });
  }

  async readReview(agent: string, reviewId: string): Promise<EvolutionReview | undefined> {
    try {
      return parseReview(await fs.readFile(this.reviewPath(agent, reviewId), "utf8"), agent, reviewId);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async listReviews(agent: string): Promise<EvolutionReview[]> {
    assertAgentName(agent);
    return this.listReviewsUnlocked(agent);
  }

  async markReviewDelivery(agent: string, reviewId: string, status: "notified" | "queued"): Promise<EvolutionReview> {
    return this.withAgentMutation(agent, async () => {
      const review = await this.requireReview(agent, reviewId);
      if (review.status !== "pending") return review;
      const next: EvolutionReview = {
        ...review,
        updatedAt: this.now(),
        delivery: { status },
      };
      await this.atomicWriteJson(this.reviewPath(agent, reviewId), next);
      return next;
    });
  }

  async markReviewFailed(agent: string, reviewId: string, reason: string): Promise<EvolutionReview> {
    return this.withAgentMutation(agent, async () => {
      const review = await this.requireReview(agent, reviewId);
      if (review.status !== "pending") return review;
      const detail = reason.trim() || "review delivery failed";
      const next: EvolutionReview = {
        ...review,
        updatedAt: this.now(),
        status: "failed",
        delivery: { status: "failed", detail },
        failure: detail,
      };
      await this.atomicWriteJson(this.reviewPath(agent, reviewId), next);
      return next;
    });
  }

  async submitReview(
    agent: string,
    reviewId: string,
    proposals: readonly EvolutionCandidateInputTarget[],
  ): Promise<EvolutionReviewSubmission> {
    return this.withAgentMutation(agent, async () => {
      await this.reconcilePromotionUnlocked(agent);
      const review = await this.requireReview(agent, reviewId);
      const targets = proposals.map((proposal) => this.normalizeCandidateTarget(proposal));
      const submissionDigest = crypto.createHash("sha256").update(JSON.stringify(targets), "utf8").digest("hex");

      if (review.status === "submitted" || review.status === "no-proposal") {
        if (review.submissionDigest !== submissionDigest) {
          throw new EvolutionStoreError("evolution/review-conflict", `Evolution review '${reviewId}' was already submitted with different proposals`);
        }
        const candidates = await this.candidatesForReviewRecord(agent, review);
        return { review, candidates, replayed: true };
      }
      if (review.status !== "pending") {
        throw new EvolutionStoreError("evolution/review-conflict", `Evolution review '${reviewId}' is ${review.status}`);
      }

      const now = this.now();
      const planned = targets.map((target, index): EvolutionCandidate => ({
        schemaVersion: EVOLUTION_SCHEMA_VERSION,
        id: `candidate-${review.id.slice("review-".length)}-${index + 1}`,
        agent,
        reviewId: review.id,
        taskId: review.taskId,
        createdAt: now,
        status: "pending",
        target,
      }));
      const plannedIds = new Set(planned.map((candidate) => candidate.id));
      const plannedSkillKeys = new Set<string>();
      const existingCandidates = await this.listCandidatesUnlocked(agent);
      for (const candidate of planned) {
        assertRecordId("candidate", candidate.id);
        if (candidate.target.kind !== "skill") continue;
        const key = evolutionCandidateTargetKey(candidate);
        if (plannedSkillKeys.has(key)) {
          throw new EvolutionStoreError("evolution/candidate-conflict", `review '${reviewId}' proposes skill '${candidate.target.name}' more than once`);
        }
        plannedSkillKeys.add(key);
        const collision = existingCandidates.find((existing) =>
          existing.status === "pending"
          && !plannedIds.has(existing.id)
          && evolutionCandidateTargetKey(existing) === key,
        );
        if (collision) {
          throw new EvolutionStoreError(
            "evolution/candidate-conflict",
            `pending candidate '${collision.id}' already targets skill '${candidate.target.name}'`,
          );
        }
      }

      const candidates: EvolutionCandidate[] = [];
      for (const candidate of planned) {
        const existing = await this.readCandidate(agent, candidate.id);
        if (existing) {
          if (existing.reviewId !== review.id || existing.taskId !== review.taskId
            || JSON.stringify(existing.target) !== JSON.stringify(candidate.target)) {
            throw new EvolutionStoreError("evolution/candidate-conflict", `candidate id '${candidate.id}' already contains different data`);
          }
          candidates.push(existing);
          continue;
        }
        await this.atomicWriteJson(this.candidatePath(agent, candidate.id), candidate);
        candidates.push(candidate);
      }

      const next: EvolutionReview = {
        ...review,
        updatedAt: now,
        status: candidates.length === 0 ? "no-proposal" : "submitted",
        candidateIds: candidates.map((candidate) => candidate.id),
        submissionDigest,
      };
      await this.atomicWriteJson(this.reviewPath(agent, reviewId), next);
      return { review: next, candidates, replayed: false };
    });
  }

  async writeLearnings(agent: string, entries: readonly EvolutionLearning[]): Promise<void> {
    await this.withAgentMutation(agent, async () => {
      await this.reconcilePromotionUnlocked(agent);
      await this.ensureProfileUnlocked(agent);
      const ids = new Set<string>();
      for (const entry of entries) {
        assertRecordId("learning", entry.id);
        if (ids.has(entry.id)) {
          throw new EvolutionStoreError("evolution/candidate-conflict", `duplicate learning id '${entry.id}'`);
        }
        ids.add(entry.id);
        if (!requiredString(entry.content.trim()) || !requiredString(entry.sourceTaskId)
          || !requiredString(entry.sourceReviewId) || !requiredString(entry.approvedAt)) {
          throw new EvolutionStoreError("evolution/candidate-malformed", `learning '${entry.id}' has an invalid v1 shape`);
        }
      }
      await this.atomicWrite(this.learningsPath(agent), renderEvolutionLearnings(entries));
    });
  }

  async recordHistory(agent: string, record: EvolutionHistoryRecord): Promise<void> {
    await this.withAgentMutation(agent, async () => {
      await this.reconcilePromotionUnlocked(agent);
      await this.ensureProfileUnlocked(agent);
      await this.recordHistoryUnlocked(agent, record);
    });
  }

  private normalizeCandidateTarget(input: EvolutionCandidateInputTarget): EvolutionCandidateTarget {
    if (input.kind === "learning") {
      if (!requiredString(input.content.trim()) || !requiredString(input.reason.trim())) {
        throw new EvolutionStoreError("evolution/candidate-malformed", "Learning candidate requires non-empty content and reason");
      }
      return { kind: "learning", content: input.content.trim(), reason: input.reason.trim() };
    }
    const result = validateEvolutionSkillBundle(input);
    if (!result.ok) {
      throw new EvolutionStoreError("evolution/skill-invalid", result.errors.join("; "));
    }
    return {
      kind: "skill",
      operation: result.bundle.operation,
      name: result.bundle.name,
      reason: result.bundle.reason,
      ...(result.bundle.expectedTargetDigest !== undefined ? { expectedTargetDigest: result.bundle.expectedTargetDigest } : {}),
      files: result.bundle.files,
      digest: result.bundle.digest,
    };
  }

  private async assertNoPendingSkillCollision(
    agent: string,
    candidate: EvolutionCandidate,
    ignoredIds: ReadonlySet<string>,
  ): Promise<void> {
    if (candidate.target.kind !== "skill") return;
    const key = evolutionCandidateTargetKey(candidate);
    const collision = (await this.listCandidatesUnlocked(agent))
      .find((existing) => existing.status === "pending"
        && !ignoredIds.has(existing.id)
        && evolutionCandidateTargetKey(existing) === key);
    if (collision) {
      throw new EvolutionStoreError(
        "evolution/candidate-conflict",
        `pending candidate '${collision.id}' already targets skill '${candidate.target.name}'`,
      );
    }
  }

  private async requireReview(agent: string, reviewId: string): Promise<EvolutionReview> {
    const review = await this.readReview(agent, reviewId);
    if (!review) {
      throw new EvolutionStoreError("evolution/review-conflict", `unknown Evolution review '${reviewId}' for agent '${agent}'`);
    }
    return review;
  }

  private async requirePendingCandidate(
    agent: string,
    candidateId: string,
    input: ResolveEvolutionCandidateInput,
  ): Promise<{ profile: EvolutionProfile; candidate: EvolutionCandidate }> {
    const profile = await this.readProfile(agent);
    const candidate = await this.readCandidate(agent, candidateId);
    if (!profile || !candidate) {
      throw new EvolutionStoreError("evolution/promotion-conflict", `unknown Evolution candidate '${candidateId}' for agent '${agent}'`);
    }
    if (candidate.status !== "pending") {
      throw new EvolutionStoreError("evolution/promotion-conflict", `Evolution candidate '${candidateId}' is already ${candidate.status}`);
    }
    if (!Number.isSafeInteger(input.expectedActiveVersion) || input.expectedActiveVersion !== profile.activeVersion) {
      throw new EvolutionStoreError(
        "evolution/promotion-conflict",
        `Evolution profile version changed: expected ${input.expectedActiveVersion}, current ${profile.activeVersion}`,
      );
    }
    const currentTargetDigest = await this.currentTargetDigest(agent, candidate);
    if (input.expectedTargetDigest !== currentTargetDigest) {
      throw new EvolutionStoreError(
        "evolution/promotion-conflict",
        `Evolution target changed: expected ${input.expectedTargetDigest ?? "absent"}, current ${currentTargetDigest ?? "absent"}`,
      );
    }
    return { profile, candidate };
  }

  private async currentTargetDigest(agent: string, candidate: EvolutionCandidate): Promise<string | undefined> {
    if (candidate.target.kind === "learning") {
      try {
        const raw = await this.readActiveLearningsUnlocked(agent);
        parseLearnings(raw, agent);
        return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    }
    const files = await this.readSkillFilesUnlocked(agent, candidate.target.name);
    return files ? digestEvolutionSkillFiles(files) : undefined;
  }

  private async readLearningsUnlocked(agent: string): Promise<EvolutionLearning[]> {
    try {
      return parseLearnings(await this.readActiveLearningsUnlocked(agent), agent);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async readSkillFilesUnlocked(
    agent: string,
    skillName: string,
    budget: { files: number; bytes: number } = { files: 0, bytes: 0 },
  ): Promise<EvolutionSkillFile[] | undefined> {
    const evolutionRoot = await this.openEvolutionRootAnchored(agent);
    let rootHandle: Awaited<ReturnType<typeof fs.open>>;
    try {
      const skillsRoot = await openNoFollowDirectory(`/proc/self/fd/${evolutionRoot.fd}/skills`, "active Evolution skills root");
      try {
        rootHandle = await openNoFollowDirectory(`/proc/self/fd/${skillsRoot.fd}/${skillName}`, `active skill '${skillName}'`);
      } finally { await skillsRoot.close(); }
    } catch (error) {
      await evolutionRoot.close();
      if (isMissing(error)) return undefined;
      throw new EvolutionStoreError("evolution/skill-invalid", `active skill '${skillName}' is not a safe directory`);
    }
    await evolutionRoot.close();
    const files: EvolutionSkillFile[] = [];
    const visit = async (directory: Awaited<ReturnType<typeof fs.open>>, prefix: string): Promise<void> => {
      const before = await directory.stat({ bigint: true });
      if (!before.isDirectory()) throw new EvolutionStoreError("evolution/skill-invalid", `active skill '${skillName}' contains an unsafe directory`);
      const directoryPath = `/proc/self/fd/${directory.fd}`;
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const childPath = path.join(directoryPath, entry.name);
        if (entry.isSymbolicLink()) throw new EvolutionStoreError("evolution/skill-invalid", `active skill '${skillName}' contains a symbolic link`);
        if (entry.isDirectory()) {
          const child = await openNoFollowDirectory(childPath, `active skill '${skillName}' directory '${relative}'`);
          try { await visit(child, relative); } finally { await child.close(); }
          continue;
        }
        if (!entry.isFile()) throw new EvolutionStoreError("evolution/skill-invalid", `active skill '${skillName}' contains a special file`);
        const opened = await readBoundedNoFollowUtf8WithMode(childPath, ACTIVE_SKILL_FILE_MAX_BYTES, `active skill '${skillName}' file '${relative}'`);
        budget.files += 1;
        budget.bytes += Buffer.byteLength(opened.content, "utf8");
        if (budget.files > ACTIVE_SKILL_FILES_MAX || budget.bytes > ACTIVE_SKILL_TOTAL_MAX_BYTES) {
          throw new EvolutionStoreError("evolution/skill-invalid", "active Evolution skill inventory exceeds its bounds");
        }
        files.push({
          path: relative,
          content: opened.content,
          ...(opened.mode & 0o111 ? { executable: true } : {}),
        });
      }
      const after = await directory.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw new EvolutionStoreError("evolution/skill-invalid", `active skill '${skillName}' changed during directory traversal`);
      }
    };
    try { await visit(rootHandle, ""); } finally { await rootHandle.close(); }
    const validation = validateEvolutionSkillBundle({
      operation: "create",
      name: skillName,
      reason: "validate active skill",
      files,
    });
    if (!validation.ok || validation.bundle.digest !== digestEvolutionSkillFiles(files)) {
      throw new EvolutionStoreError("evolution/skill-invalid", `active skill '${skillName}' is malformed`);
    }
    return validation.bundle.files;
  }

  private async writeSkillBundleUnlocked(
    agent: string,
    skillName: string,
    files: readonly EvolutionSkillFile[],
    operation: "create" | "update",
  ): Promise<void> {
    const skills = this.skillsDir(agent);
    const target = this.skillDir(agent, skillName);
    const staging = path.join(skills, `.staging-${skillName}-${crypto.randomBytes(4).toString("hex")}`);
    const backup = path.join(skills, `.backup-${skillName}-${crypto.randomBytes(4).toString("hex")}`);
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      for (const file of files) {
        const destination = path.join(staging, file.path);
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await fs.writeFile(destination, file.content, { encoding: "utf8", mode: file.executable ? 0o700 : 0o600, flag: "wx" });
      }
      if (operation === "create") {
        await fs.rename(staging, target);
        return;
      }
      await fs.rename(target, backup);
      try {
        await fs.rename(staging, target);
      } catch (error) {
        await fs.rename(backup, target).catch(() => undefined);
        throw error;
      }
      await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async recordHistoryUnlocked(agent: string, record: EvolutionHistoryRecord): Promise<void> {
    if (
      record.schemaVersion !== EVOLUTION_SCHEMA_VERSION
      || record.agent !== agent
      || !Number.isSafeInteger(record.version)
      || record.version < 1
      || !requiredString(record.id)
      || !requiredString(record.candidateId)
      || (record.target !== "learning" && record.target !== "skill")
      || !requiredString(record.recordedAt)
      || !SHA256_RE.test(record.promotedDigest)
      || (record.previousDigest !== undefined && !SHA256_RE.test(record.previousDigest))
      || (record.previousSkillFiles !== undefined
        && (record.target !== "skill"
          || record.previousDigest !== digestEvolutionSkillFiles(record.previousSkillFiles)))
    ) {
      throw new EvolutionStoreError("evolution/history-invalid", "Evolution history record has an invalid v1 shape");
    }
    assertRecordId("history", record.id);
    const file = path.join(this.historyDir(agent), `${String(record.version).padStart(6, "0")}-${record.id}.json`);
    await this.atomicWriteJson(file, record);
  }

  private async candidatesForReviewRecord(agent: string, review: EvolutionReview): Promise<EvolutionCandidate[]> {
    const candidates: EvolutionCandidate[] = [];
    for (const candidateId of review.candidateIds) {
      const candidate = await this.readCandidate(agent, candidateId);
      if (!candidate || candidate.reviewId !== review.id) {
        throw new EvolutionStoreError("evolution/review-malformed", `Evolution review '${review.id}' references a missing candidate`);
      }
      candidates.push(candidate);
    }
    return candidates;
  }

  private async ensureProfileUnlocked(agent: string): Promise<EvolutionProfile> {
    let current = await this.readProfileFile(agent);
    if (!current && this.authorityHead) {
      const pending = await this.readCreationIntentUnlocked(agent);
      if (pending) {
        current = parseProfile(JSON.stringify(pending.profile), agent);
        const expected = this.authorityHeadForCapturedState(agent, current, renderEvolutionLearnings([]), []);
        if (pending.head.revision !== expected.revision || pending.head.mac !== expected.mac) {
          throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution creation intent does not match its initial profile");
        }
        // The intent is the authenticated source of truth for every pre-authority crash boundary.
        await this.atomicWriteJson(this.profilePath(agent), current);
        await this.atomicWrite(this.learningsPath(agent), renderEvolutionLearnings([]));
      }
    }
    if (current) {
      try {
        await fs.access(this.learningsPath(agent));
      } catch (error) {
        if (!isMissing(error)) throw error;
        await this.atomicWrite(this.learningsPath(agent), renderEvolutionLearnings([]));
      }
      await this.reconcileRenameIntentUnlocked(agent, current);
      if (await this.reconcileCreationIntentUnlocked(agent, current)) return current;
      await this.assertAuthorizedStateUnlocked(agent, current);
      return current;
    }
    const now = this.now();
    const profile = createInitialEvolutionProfile({ profileId: this.uuid(), agent, now });
    if (this.authorityHead) {
      const expected = this.authorityHeadForCapturedState(agent, profile, renderEvolutionLearnings([]), []);
      await this.writeCreationIntentUnlocked(agent, profile, expected);
      await this.creationFault?.();
    }
    await this.atomicWriteJson(this.profilePath(agent), profile);
    await this.atomicWrite(this.learningsPath(agent), renderEvolutionLearnings([]));
    try {
      await this.establishAuthorizedStateUnlocked(agent, profile);
      await fs.rm(this.creationIntentPath(agent), { force: true });
    } catch (error) {
      if (!this.authorityHead) throw error;
      try {
        if (await this.reconcileCreationIntentUnlocked(agent, profile)) return profile;
      } catch {
        // Preserve the signed intent and exact bytes. A later call can safely retry or confirm the
        // same head without accepting unauthenticated workspace state.
      }
      throw error;
    }
    return profile;
  }

  private async writeCreationIntentUnlocked(agent: string, profile: EvolutionProfile, head: AuthorityHead): Promise<void> {
    const key = this.authorityIntegrityKey?.();
    if (!key) throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution approval authority is unavailable");
    const intent = sealAuthorityRecord({
      schemaVersion: 1 as const,
      kind: "agent-evolution-create" as const,
      agent,
      profile,
      head,
    }, key, workspaceAuthorityDomain("agent-evolution", this.workspaceRoot));
    await this.atomicWriteJson(this.creationIntentPath(agent), intent);
  }

  private async writeRenameIntentUnlocked(intent: {
    schemaVersion: 1;
    kind: "agent-evolution-rename";
    oldAgent: string;
    newAgent: string;
    profileId: string;
    retiredRoot: string;
    previousHead: AuthorityHead;
    nextHead: AuthorityHead;
  }, target = this.renameIntentPath(intent.newAgent)): Promise<void> {
    const key = this.authorityIntegrityKey?.();
    if (!key) throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution approval authority is unavailable");
    const sealed = sealAuthorityRecord(intent, key, workspaceAuthorityDomain("agent-evolution", this.workspaceRoot));
    await this.atomicWriteJson(target, sealed);
  }

  private async reconcileRenameIntentUnlocked(agent: string, profile: EvolutionProfile): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(this.renameIntentPath(agent), "utf8"));
    } catch (error) {
      if (isMissing(error)) return;
      throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution rename intent is unreadable");
    }
    const intent = value as Partial<EvolutionRenameIntent>;
    const oldAgent = intent.oldAgent;
    const retiredRoot = intent.retiredRoot;
    const previousHead = intent.previousHead;
    const nextHead = intent.nextHead;
    const key = this.authorityIntegrityKey?.();
    const parent = path.dirname(this.rootFor(agent));
    if (!this.authorityHead?.move || !key || intent.schemaVersion !== 1 || intent.kind !== "agent-evolution-rename"
      || !requiredString(oldAgent) || intent.newAgent !== agent || intent.profileId !== profile.profileId
      || !requiredString(retiredRoot) || path.dirname(retiredRoot) !== parent
      || !path.basename(retiredRoot).startsWith(`.retired-evolution-${oldAgent}-`)
      || !Number.isSafeInteger(previousHead?.revision) || !SHA256_RE.test(previousHead?.mac ?? "")
      || !Number.isSafeInteger(nextHead?.revision) || !SHA256_RE.test(nextHead?.mac ?? "")
      || !verifyAuthorityRecord(intent as AuthorityRecord, key, workspaceAuthorityDomain("agent-evolution", this.workspaceRoot))) {
      throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution rename intent is not authentic");
    }
    const authenticatedOldAgent = oldAgent as string;
    const authenticatedRetiredRoot = retiredRoot as string;
    const authenticatedPreviousHead = previousHead as AuthorityHead;
    const authenticatedNextHead = nextHead as AuthorityHead;
    const expected = await this.calculatedAuthorityHead(agent, profile);
    if (authenticatedNextHead.revision !== expected.revision || authenticatedNextHead.mac !== expected.mac) {
      throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution rename intent does not match active bytes");
    }
    let sourceQuarantined = false;
    try {
      await fs.access(authenticatedRetiredRoot);
      sourceQuarantined = true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (!sourceQuarantined) {
      const oldRoot = this.rootFor(authenticatedOldAgent);
      try {
        await this.quarantineRoot(oldRoot, authenticatedRetiredRoot);
      } catch (error) {
        if (isMissing(error)) {
          throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution rename source is missing before authority move");
        }
        throw error;
      }
    }
    try {
      await this.authorityHead.move(
        this.authorityIdentity(authenticatedOldAgent),
        this.authorityIdentity(agent),
        authenticatedNextHead,
        authenticatedPreviousHead.mac,
      );
    } catch (error) {
      const current = await this.authorityHead.current(this.authorityIdentity(agent));
      if (current?.revision !== authenticatedNextHead.revision || current.mac !== authenticatedNextHead.mac) throw error;
    }
    const current = await this.authorityHead.current(this.authorityIdentity(agent));
    if (current?.revision !== authenticatedNextHead.revision || current.mac !== authenticatedNextHead.mac) {
      throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution rename authority could not be recovered");
    }
    await fs.rm(this.renameIntentPath(agent), { force: true });
    await this.retiredRootCleanup(authenticatedRetiredRoot).catch(() => undefined);
  }

  private async readCreationIntentUnlocked(agent: string): Promise<EvolutionCreationIntent | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(this.creationIntentPath(agent), "utf8"));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution creation intent is unreadable");
    }
    const intent = value as Partial<EvolutionCreationIntent>;
    const key = this.authorityIntegrityKey?.();
    if (!key || intent.schemaVersion !== 1 || intent.kind !== "agent-evolution-create"
      || intent.agent !== agent || !intent.profile
      || !Number.isSafeInteger(intent.head?.revision) || !SHA256_RE.test(intent.head?.mac ?? "")
      || !verifyAuthorityRecord(intent as AuthorityRecord, key, workspaceAuthorityDomain("agent-evolution", this.workspaceRoot))) {
      throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution creation intent is not authentic");
    }
    parseProfile(JSON.stringify(intent.profile), agent);
    return intent as EvolutionCreationIntent;
  }

  private async reconcileCreationIntentUnlocked(agent: string, profile: EvolutionProfile): Promise<boolean> {
    const intent = await this.readCreationIntentUnlocked(agent);
    if (!intent) return false;
    const key = this.authorityIntegrityKey?.();
    const expected = await this.calculatedAuthorityHead(agent, profile);
    if (!this.authorityHead || !this.authorityHead.establishInitial || !key
      || intent.profile.profileId !== profile.profileId
      || intent.head?.revision !== expected.revision || intent.head.mac !== expected.mac
      || JSON.stringify(intent.profile) !== JSON.stringify(profile)) {
      throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution creation intent is not authentic");
    }
    const identity = this.authorityIdentity(agent);
    let current = await this.authorityHead.current(identity);
    if (!current) {
      try {
        await this.authorityHead.establishInitial(identity, expected);
      } catch (error) {
        current = await this.authorityHead.current(identity);
        if (current?.revision !== expected.revision || current.mac !== expected.mac) throw error;
      }
      current = await this.authorityHead.current(identity);
    }
    if (current?.revision !== expected.revision || current.mac !== expected.mac) {
      throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution creation intent conflicts with approval authority");
    }
    await fs.rm(this.creationIntentPath(agent), { force: true });
    return true;
  }

  private async listReviewsUnlocked(agent: string): Promise<EvolutionReview[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.reviewsDir(agent));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const reviews: EvolutionReview[] = [];
    for (const name of names.sort(compareText)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!SAFE_RECORD_ID.test(id)) continue;
      const review = await this.readReview(agent, id);
      if (review) reviews.push(review);
    }
    return reviews.sort((a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id));
  }

  private async listCandidatesUnlocked(agent: string): Promise<EvolutionCandidate[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.candidatesDir(agent));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const candidates: EvolutionCandidate[] = [];
    for (const name of names.sort(compareText)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!SAFE_RECORD_ID.test(id)) continue;
      const candidate = await this.readCandidate(agent, id);
      if (candidate) candidates.push(candidate);
    }
    return candidates.sort((a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id));
  }

  private authorityIdentity(agent: string): string {
    return `evolution:${agent}`;
  }

  private async capturedStateBytesUnlocked(
    agent: string,
    profile: EvolutionProfile,
  ): Promise<EvolutionActiveSnapshotBytes> {
    const learnings = await this.readActiveLearningsUnlocked(agent);
    parseLearnings(learnings, agent);
    const skills: EvolutionActiveSnapshotBytes["skills"] = [];
    const budget = { files: 0, bytes: 0 };
    const skillNames = await this.listSkillNamesUnlocked(agent);
    for (const name of skillNames) {
      const files = await this.readSkillFilesUnlocked(agent, name, budget);
      if (files) skills.push({ name, files });
    }
    if (formationActiveNamesDigest(skillNames) !== formationActiveNamesDigest(await this.listSkillNamesUnlocked(agent))) {
      throw new EvolutionStoreError("evolution/authority-invalid", "active Evolution skills changed during capture");
    }
    return { profile, learnings, skills };
  }

  private async calculatedAuthorityHead(
    agent: string,
    profile: EvolutionProfile,
    override: { learnings?: string; skill?: { name: string; files: readonly EvolutionSkillFile[] } } = {},
  ): Promise<AuthorityHead> {
    let learnings: string;
    try {
      learnings = override.learnings ?? await this.readActiveLearningsUnlocked(agent);
      parseLearnings(learnings, agent);
    } catch (error) {
      if (!isMissing(error)) throw error;
      learnings = renderEvolutionLearnings([]);
    }
    const skills: EvolutionActiveSnapshotBytes["skills"] = [];
    const skillNames = new Set(await this.listSkillNamesUnlocked(agent));
    if (override.skill) skillNames.add(override.skill.name);
    const budget = { files: 0, bytes: 0 };
    for (const name of [...skillNames].sort(compareText)) {
      const files = override.skill?.name === name ? [...override.skill.files] : await this.readSkillFilesUnlocked(agent, name, budget);
      if (override.skill?.name === name && files) {
        budget.files += files.length;
        budget.bytes += files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
        if (budget.files > ACTIVE_SKILL_FILES_MAX || budget.bytes > ACTIVE_SKILL_TOTAL_MAX_BYTES) {
          throw new EvolutionStoreError("evolution/skill-invalid", "active Evolution skill inventory exceeds its bounds");
        }
      }
      if (files) skills.push({ name, files });
    }
    const expectedNames = [...skillNames].sort(compareText);
    const observedNames = await this.listSkillNamesUnlocked(agent);
    const sourceNames = override.skill ? observedNames.includes(override.skill.name) ? observedNames : [...observedNames, override.skill.name].sort(compareText) : observedNames;
    if (formationActiveNamesDigest(expectedNames) !== formationActiveNamesDigest(sourceNames)) {
      throw new EvolutionStoreError("evolution/authority-invalid", "active Evolution skills changed during authority calculation");
    }
    return this.authorityHeadForCapturedState(agent, profile, learnings, skills);
  }

  private authorityHeadForCapturedState(
    agent: string,
    profile: EvolutionProfile,
    learnings: string,
    skills: EvolutionActiveSnapshotBytes["skills"],
  ): AuthorityHead {
    const record = {
      schemaVersion: 1,
      kind: "agent-evolution-active",
      agent,
      profileId: profile.profileId,
      activeVersion: profile.activeVersion,
      learningsDigest: crypto.createHash("sha256").update(learnings, "utf8").digest("hex"),
      skills: skills.map(({ name, files }) => ({ name, digest: digestEvolutionSkillFiles(files) })),
    };
    const key = this.authorityIntegrityKey?.();
    const mac = key
      ? authorityRecordMac(sealAuthorityRecord(record, key, workspaceAuthorityDomain("agent-evolution", this.workspaceRoot)))!
      : crypto.createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex");
    return { revision: profile.activeVersion + 1, mac };
  }

  private async assertAuthorizedStateUnlocked(agent: string, profile: EvolutionProfile): Promise<AuthorityHead> {
    const expected = await this.calculatedAuthorityHead(agent, profile);
    await this.assertExpectedAuthorityHeadUnlocked(agent, profile, expected);
    return expected;
  }

  private async assertExpectedAuthorityHeadUnlocked(
    agent: string,
    profile: EvolutionProfile,
    expected: AuthorityHead,
  ): Promise<void> {
    if (!this.authorityHead) return;
    if (!this.authorityIntegrityKey?.()) {
      throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution approval authority is unavailable");
    }
    const identity = this.authorityIdentity(agent);
    const current = await this.authorityHead.current(identity);
    if (!current) throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution approval authority has no active head");
    if (current.revision !== expected.revision || current.mac !== expected.mac) {
      throw new EvolutionStoreError(
        "evolution/authority-invalid",
        `Agent Evolution active profile '${profile.profileId}' does not match its human-approved head`,
      );
    }
  }

  private async establishAuthorizedStateUnlocked(agent: string, profile: EvolutionProfile): Promise<AuthorityHead> {
    const expected = await this.calculatedAuthorityHead(agent, profile);
    if (!this.authorityHead) return expected;
    if (!this.authorityIntegrityKey?.() || !this.authorityHead.establishInitial) {
      throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution approval authority is unavailable");
    }
    const identity = this.authorityIdentity(agent);
    await this.authorityHead.establishInitial(identity, expected);
    const established = await this.authorityHead.current(identity);
    if (established?.revision !== expected.revision || established.mac !== expected.mac) {
      throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution approval authority could not be established");
    }
    return expected;
  }

  private async fault(point: EvolutionPromotionFaultPoint): Promise<void> {
    await this.promotionFault?.(point);
  }

  private async readPromotionIntentUnlocked(agent: string): Promise<EvolutionPromotionIntent | undefined> {
    try {
      const value = JSON.parse(await fs.readFile(this.promotionIntentPath(agent), "utf8")) as EvolutionPromotionIntent;
      if (value.schemaVersion !== 1 || value.agent !== agent || !requiredString(value.candidateId)
        || !Number.isSafeInteger(value.previousVersion) || !Number.isSafeInteger(value.nextVersion)
        || value.nextVersion !== value.previousVersion + 1
        || !Number.isSafeInteger(value.previousHead?.revision) || !SHA256_RE.test(value.previousHead?.mac ?? "")
        || !Number.isSafeInteger(value.nextHead?.revision) || !SHA256_RE.test(value.nextHead?.mac ?? "")
        || !requiredString(value.historyFile) || !value.previousProfile || !value.previousCandidate
        || typeof value.previousLearnings !== "string") {
        throw new Error("invalid promotion intent");
      }
      return value;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new EvolutionStoreError("evolution/authority-invalid", `Agent Evolution promotion intent is corrupt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async rollbackPromotionUnlocked(agent: string, intent: EvolutionPromotionIntent): Promise<void> {
    if (intent.target.kind === "learning") {
      await this.atomicWrite(this.learningsPath(agent), intent.previousLearnings);
    } else {
      await fs.rm(this.skillDir(agent, intent.target.name), { recursive: true, force: true });
      if (intent.previousSkillFiles) {
        await this.writeSkillBundleUnlocked(agent, intent.target.name, intent.previousSkillFiles, "create");
      }
    }
    await fs.rm(path.join(this.historyDir(agent), intent.historyFile), { force: true });
    await this.atomicWriteJson(this.profilePath(agent), intent.previousProfile);
    await this.atomicWriteJson(this.candidatePath(agent, intent.candidateId), intent.previousCandidate);
    await fs.rm(this.promotionDir(agent), { recursive: true, force: true });
  }

  private async reconcilePromotionUnlocked(agent: string): Promise<void> {
    const intent = await this.readPromotionIntentUnlocked(agent);
    if (!intent) return;
    if (!this.authorityHead) {
      await this.rollbackPromotionUnlocked(agent, intent);
      return;
    }
    const identity = this.authorityIdentity(agent);
    const current = await this.authorityHead.current(identity);
    if (current?.revision === intent.nextHead.revision && current.mac === intent.nextHead.mac) {
      const profile = await this.readProfileFile(agent);
      if (!profile || profile.activeVersion !== intent.nextVersion) {
        throw new EvolutionStoreError("evolution/authority-invalid", "authorized Agent Evolution promotion is incomplete");
      }
      const calculated = await this.calculatedAuthorityHead(agent, profile);
      if (calculated.revision !== current.revision || calculated.mac !== current.mac) {
        throw new EvolutionStoreError("evolution/authority-invalid", "authorized Agent Evolution promotion bytes are incomplete");
      }
      await fs.rm(this.promotionDir(agent), { recursive: true, force: true });
      return;
    }
    if (current?.revision === intent.previousHead.revision && current.mac === intent.previousHead.mac) {
      await this.rollbackPromotionUnlocked(agent, intent);
      const restored = await this.readProfileFile(agent);
      if (!restored) throw new EvolutionStoreError("evolution/authority-invalid", "promotion rollback lost the active profile");
      const calculated = await this.calculatedAuthorityHead(agent, restored);
      if (calculated.revision !== current.revision || calculated.mac !== current.mac) {
        throw new EvolutionStoreError("evolution/authority-invalid", "promotion rollback did not restore the authorized profile");
      }
      return;
    }
    throw new EvolutionStoreError("evolution/authority-invalid", "Agent Evolution promotion authority changed during recovery");
  }

  private async withAgentMutation<T>(agent: string, action: () => Promise<T>): Promise<T> {
    return this.withAgentMutations([agent], action);
  }

  private async withAgentMutations<T>(agents: readonly string[], action: () => Promise<T>): Promise<T> {
    const keys = [...new Set(agents)].sort(compareText);
    for (const agent of keys) assertAgentName(agent);
    const previous = keys.map((agent) => this.mutationTails.get(agent) ?? Promise.resolve());
    const result = Promise.all(previous).then(action);
    const tail = result.then(() => undefined, () => undefined);
    for (const agent of keys) this.mutationTails.set(agent, tail);
    try {
      return await result;
    } finally {
      for (const agent of keys) {
        if (this.mutationTails.get(agent) === tail) this.mutationTails.delete(agent);
      }
    }
  }

  private async atomicWriteJson(target: string, value: unknown): Promise<void> {
    await this.atomicWrite(target, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    try {
      await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
