import crypto from "node:crypto";
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
  type EvolutionSkillTarget,
} from "./domain.js";
import {
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
  | "evolution/profile-malformed"
  | "evolution/candidate-malformed"
  | "evolution/candidate-conflict"
  | "evolution/review-malformed"
  | "evolution/review-conflict"
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

export interface EvolutionStoreOptions {
  now?: () => string;
  uuid?: () => string;
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
  ) {
    throw new EvolutionStoreError("evolution/candidate-malformed", `Evolution candidate '${expectedId}' has an invalid v1 shape`);
  }
  return candidate as EvolutionCandidate;
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
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly workspaceRoot: string,
    options: EvolutionStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
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
      ) {
        throw new EvolutionStoreError("evolution/history-invalid", "Evolution history record has an invalid v1 shape");
      }
      assertRecordId("history", record.id);
      const file = path.join(this.historyDir(agent), `${String(record.version).padStart(6, "0")}-${record.id}.json`);
      await this.atomicWriteJson(file, record);
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
    assertAgentName(agent);
    const previous = this.mutationTails.get(agent) ?? Promise.resolve();
    const result = previous.then(action, action);
    const tail = result.then(() => undefined, () => undefined);
    this.mutationTails.set(agent, tail);
    try {
      return await result;
    } finally {
      if (this.mutationTails.get(agent) === tail) this.mutationTails.delete(agent);
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
