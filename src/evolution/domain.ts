/**
 * SDD 421 — runtime-neutral domain for one Tachyon Agent Evolution Profile.
 *
 * Soul and human-authored instructions are deliberately absent: evolution owns only review records,
 * proposed learning/skills, active-version metadata, and promotion history.
 */

export const EVOLUTION_SCHEMA_VERSION = 1 as const;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface EvolutionProfile {
  schemaVersion: 1;
  profileId: string;
  agent: string;
  activeVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type EvolutionReviewStatus = "pending" | "submitted" | "no-proposal" | "failed";

export interface EvolutionReview {
  schemaVersion: 1;
  id: string;
  agent: string;
  taskId: string;
  taskTitle: string;
  completionRevision: string;
  createdAt: string;
  updatedAt: string;
  status: EvolutionReviewStatus;
  sessionAnchor: {
    session: string;
    activitySeq?: number;
  };
  delivery: {
    status: "not-attempted" | "notified" | "queued" | "failed";
    detail?: string;
  };
  candidateIds: string[];
  submissionDigest?: string;
  failure?: string;
}

export interface EvolutionLearning {
  id: string;
  content: string;
  sourceTaskId: string;
  sourceReviewId: string;
  approvedAt: string;
}

export interface EvolutionSkillFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface EvolutionLearningTarget {
  kind: "learning";
  content: string;
  reason: string;
}

export interface EvolutionSkillTarget {
  kind: "skill";
  operation: "create" | "update";
  name: string;
  reason: string;
  /** Required for update proposals; checked again when a human promotes the candidate. */
  expectedTargetDigest?: string;
  files: EvolutionSkillFile[];
  digest: string;
}

export type EvolutionCandidateTarget = EvolutionLearningTarget | EvolutionSkillTarget;
export type EvolutionCandidateStatus = "pending" | "approved" | "rejected";

export interface EvolutionCandidate {
  schemaVersion: 1;
  id: string;
  agent: string;
  reviewId: string;
  taskId: string;
  createdAt: string;
  status: EvolutionCandidateStatus;
  target: EvolutionCandidateTarget;
}

export interface EvolutionHistoryRecord {
  schemaVersion: 1;
  id: string;
  agent: string;
  version: number;
  candidateId: string;
  target: "learning" | "skill";
  recordedAt: string;
  previousDigest?: string;
  promotedDigest: string;
}

export function createInitialEvolutionProfile(input: {
  profileId: string;
  agent: string;
  now: string;
}): EvolutionProfile {
  return {
    schemaVersion: EVOLUTION_SCHEMA_VERSION,
    profileId: input.profileId,
    agent: input.agent,
    activeVersion: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** Pure transition used later by the human promotion path. */
export function resolveEvolutionCandidate(
  candidate: EvolutionCandidate,
  status: Exclude<EvolutionCandidateStatus, "pending">,
): EvolutionCandidate {
  if (candidate.status !== "pending") {
    throw new Error(`evolution candidate '${candidate.id}' is already ${candidate.status}`);
  }
  return { ...candidate, status };
}

/** Stable target key: learnings are independent; one skill name is one shared promotion target. */
export function evolutionCandidateTargetKey(candidate: Pick<EvolutionCandidate, "id" | "target">): string {
  return candidate.target.kind === "skill" ? `skill:${candidate.target.name}` : `learning:${candidate.id}`;
}

/** Deterministic human-readable projection of approved individual learning entries. */
export function renderEvolutionLearnings(entries: readonly EvolutionLearning[]): string {
  const ordered = [...entries].sort((a, b) => compareText(a.approvedAt, b.approvedAt) || compareText(a.id, b.id));
  const body = ordered.map((entry) => [
    `<!-- learning:${entry.id} task:${entry.sourceTaskId} review:${entry.sourceReviewId} -->`,
    entry.content.trim(),
  ].join("\n"));
  return [
    "# Learned Context",
    "",
    "Human-approved context for this Tachyon agent.",
    ...(body.length > 0 ? ["", body.join("\n\n")] : []),
    "",
  ].join("\n");
}
