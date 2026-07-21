import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isValidAgentName } from "../config/nameValidation.js";
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

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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

export interface EvolutionPromotionResult {
  candidate: EvolutionCandidate;
  profile: EvolutionProfile;
  history: EvolutionHistoryRecord;
}

export interface EvolutionStoreOptions {
  now?: () => string;
  uuid?: () => string;
  reservedSkillNames?: (agent: string) => ReadonlySet<string>;
}

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
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly workspaceRoot: string,
    options: EvolutionStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.reservedSkillNames = options.reservedSkillNames ?? (() => new Set());
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

  skillsDir(agent: string): string {
    return path.join(this.rootFor(agent), "skills");
  }

  skillDir(agent: string, skillName: string): string {
    if (!SAFE_SKILL_NAME.test(skillName)) {
      throw new EvolutionStoreError("evolution/path-invalid", `invalid evolution skill name '${skillName}'`);
    }
    return path.join(this.skillsDir(agent), skillName);
  }

  async readProfile(agent: string): Promise<EvolutionProfile | undefined> {
    assertAgentName(agent);
    try {
      return parseProfile(await fs.readFile(this.profilePath(agent), "utf8"), agent);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async ensureProfile(agent: string): Promise<EvolutionProfile> {
    return this.withAgentMutation(agent, () => this.ensureProfileUnlocked(agent));
  }

  /** Move one canonical profile to a renamed Tachyon agent without changing its identity or version. */
  async renameAgent(oldAgent: string, newAgent: string): Promise<boolean> {
    assertAgentName(oldAgent);
    assertAgentName(newAgent);
    if (oldAgent === newAgent) return (await this.readProfile(oldAgent)) !== undefined;
    return this.withAgentMutations([oldAgent, newAgent], async () => {
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
        await fs.rename(staging, newRoot);
        try {
          await fs.rm(oldRoot, { recursive: true, force: false });
        } catch (error) {
          await fs.rm(newRoot, { recursive: true, force: true });
          throw error;
        }
        return true;
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
    });
  }

  async createCandidate(agent: string, input: CreateEvolutionCandidateInput): Promise<EvolutionCandidate> {
    return this.withAgentMutation(agent, async () => {
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

  async approveCandidate(
    agent: string,
    candidateId: string,
    input: ResolveEvolutionCandidateInput,
  ): Promise<EvolutionPromotionResult> {
    return this.withAgentMutation(agent, async () => {
      const { profile, candidate } = await this.requirePendingCandidate(agent, candidateId, input);
      const promotedVersion = profile.activeVersion + 1;
      const recordedAt = this.now();
      let previousDigest: string | undefined;
      let previousSkillFiles: EvolutionSkillFile[] | undefined;
      let promotedDigest: string;

      if (candidate.target.kind === "learning") {
        const entries = await this.readLearningsUnlocked(agent);
        const learning: EvolutionLearning = {
          id: `learning-${candidate.id.slice("candidate-".length)}`,
          content: candidate.target.content,
          sourceTaskId: candidate.taskId,
          sourceReviewId: candidate.reviewId,
          approvedAt: recordedAt,
        };
        const rendered = renderEvolutionLearnings([...entries, learning]);
        await this.atomicWrite(this.learningsPath(agent), rendered);
        promotedDigest = crypto.createHash("sha256").update(rendered, "utf8").digest("hex");
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
        await this.writeSkillBundleUnlocked(agent, candidate.target.name, candidate.target.files, candidate.target.operation);
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
      await this.recordHistoryUnlocked(agent, history);

      const nextProfile: EvolutionProfile = {
        ...profile,
        activeVersion: promotedVersion,
        updatedAt: recordedAt,
      };
      await this.atomicWriteJson(this.profilePath(agent), nextProfile);
      const approved: EvolutionCandidate = {
        ...candidate,
        status: "approved",
        resolvedAt: recordedAt,
        promotedVersion,
      };
      await this.atomicWriteJson(this.candidatePath(agent, candidate.id), approved);
      return { candidate: approved, profile: nextProfile, history };
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
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.skillsDir(agent), { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory() && SAFE_SKILL_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareText);
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
        const raw = await fs.readFile(this.learningsPath(agent), "utf8");
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
      return parseLearnings(await fs.readFile(this.learningsPath(agent), "utf8"), agent);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async readSkillFilesUnlocked(agent: string, skillName: string): Promise<EvolutionSkillFile[] | undefined> {
    const root = this.skillDir(agent, skillName);
    try {
      const rootStat = await fs.lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new EvolutionStoreError("evolution/skill-invalid", `active skill '${skillName}' is not a regular directory`);
      }
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const files: EvolutionSkillFile[] = [];
    const visit = async (directory: string, prefix: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
        const absolute = path.join(directory, entry.name);
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) {
          throw new EvolutionStoreError("evolution/skill-invalid", `active skill '${skillName}' contains a symbolic link`);
        }
        if (entry.isDirectory()) {
          await visit(absolute, relative);
          continue;
        }
        if (!entry.isFile()) {
          throw new EvolutionStoreError("evolution/skill-invalid", `active skill '${skillName}' contains a special file`);
        }
        const stat = await fs.stat(absolute);
        files.push({
          path: relative,
          content: await fs.readFile(absolute, "utf8"),
          ...(stat.mode & 0o111 ? { executable: true } : {}),
        });
      }
    };
    await visit(root, "");
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
    const current = await this.readProfile(agent);
    if (current) {
      try {
        await fs.access(this.learningsPath(agent));
      } catch (error) {
        if (!isMissing(error)) throw error;
        await this.atomicWrite(this.learningsPath(agent), renderEvolutionLearnings([]));
      }
      return current;
    }
    const now = this.now();
    const profile = createInitialEvolutionProfile({ profileId: this.uuid(), agent, now });
    await this.atomicWriteJson(this.profilePath(agent), profile);
    await this.atomicWrite(this.learningsPath(agent), renderEvolutionLearnings([]));
    return profile;
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
