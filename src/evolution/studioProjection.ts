import type { EvolutionCandidate, EvolutionReview, EvolutionSkillFile } from "./domain.js";
import type { EvolutionStore } from "./EvolutionStore.js";

const MAX_STUDIO_CANDIDATES = 50;
const MAX_ACTIVE_ITEMS = 100;

function compareNewest(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

export interface EvolutionStudioReviewSummary {
  id: string;
  taskId: string;
  taskTitle: string;
  createdAt: string;
  status: EvolutionReview["status"];
  failure?: string;
}

export interface EvolutionStudioCandidateSummary {
  id: string;
  reviewId: string;
  taskId: string;
  taskTitle?: string;
  createdAt: string;
  status: EvolutionCandidate["status"];
  kind: EvolutionCandidate["target"]["kind"];
  reason: string;
  operation?: "create" | "update";
  skillName?: string;
}

export interface EvolutionStudioSummary {
  agent: string;
  enabled: boolean;
  profilePresent: boolean;
  activeVersion: number;
  pendingCount: number;
  lastReview?: EvolutionStudioReviewSummary;
  activeLearnings: Array<{ id: string; content: string }>;
  activeSkillNames: string[];
}

export interface EvolutionStudioOverview {
  summary: EvolutionStudioSummary;
  candidates: EvolutionStudioCandidateSummary[];
}

export interface EvolutionStudioCandidateDetail extends EvolutionStudioCandidateSummary {
  expectedActiveVersion: number;
  expectedTargetDigest?: string;
  learningContent?: string;
  files?: EvolutionSkillFile[];
  currentFiles?: EvolutionSkillFile[];
}

function summarizeCandidate(
  candidate: EvolutionCandidate,
  taskTitle?: string,
): EvolutionStudioCandidateSummary {
  return {
    id: candidate.id,
    reviewId: candidate.reviewId,
    taskId: candidate.taskId,
    ...(taskTitle !== undefined ? { taskTitle } : {}),
    createdAt: candidate.createdAt,
    status: candidate.status,
    kind: candidate.target.kind,
    reason: candidate.target.reason,
    ...(candidate.target.kind === "skill"
      ? { operation: candidate.target.operation, skillName: candidate.target.name }
      : {}),
  };
}

/** Bounded host projection: lists stay small; exact proposal bodies are loaded separately on demand. */
export async function readEvolutionStudioOverview(
  store: EvolutionStore,
  agent: string,
  enabled: boolean,
): Promise<EvolutionStudioOverview> {
  const [profile, candidates, reviews, learnings, skillNames] = await Promise.all([
    store.readProfile(agent),
    store.listCandidates(agent),
    store.listReviews(agent),
    store.readLearnings(agent),
    store.listSkillNames(agent),
  ]);
  const reviewTitles = new Map(reviews.map((review) => [review.id, review.taskTitle]));
  const newestReviews = [...reviews].sort(compareNewest);
  const lastReview = newestReviews[0];

  return {
    summary: {
      agent,
      enabled,
      profilePresent: profile !== undefined,
      activeVersion: profile?.activeVersion ?? 0,
      pendingCount: candidates.filter((candidate) => candidate.status === "pending").length,
      ...(lastReview !== undefined
        ? {
            lastReview: {
              id: lastReview.id,
              taskId: lastReview.taskId,
              taskTitle: lastReview.taskTitle,
              createdAt: lastReview.createdAt,
              status: lastReview.status,
              ...(lastReview.failure !== undefined ? { failure: lastReview.failure } : {}),
            },
          }
        : {}),
      activeLearnings: learnings.slice(-MAX_ACTIVE_ITEMS).map(({ id, content }) => ({ id, content })),
      activeSkillNames: skillNames.slice(0, MAX_ACTIVE_ITEMS),
    },
    candidates: [...candidates]
      .sort(compareNewest)
      .slice(0, MAX_STUDIO_CANDIDATES)
      .map((candidate) => summarizeCandidate(candidate, reviewTitles.get(candidate.reviewId))),
  };
}

/** Exact candidate projection used only after the human opens one proposal. */
export async function readEvolutionStudioCandidateDetail(
  store: EvolutionStore,
  agent: string,
  candidateId: string,
): Promise<EvolutionStudioCandidateDetail> {
  const detail = await store.candidateDetail(agent, candidateId);
  const review = await store.readReview(agent, detail.candidate.reviewId);
  const summary = summarizeCandidate(detail.candidate, review?.taskTitle);
  if (detail.candidate.target.kind === "learning") {
    return {
      ...summary,
      expectedActiveVersion: detail.activeVersion,
      ...(detail.currentTargetDigest !== undefined ? { expectedTargetDigest: detail.currentTargetDigest } : {}),
      learningContent: detail.candidate.target.content,
    };
  }

  const currentFiles = await store.readSkillFiles(agent, detail.candidate.target.name);
  return {
    ...summary,
    expectedActiveVersion: detail.activeVersion,
    ...(detail.currentTargetDigest !== undefined ? { expectedTargetDigest: detail.currentTargetDigest } : {}),
    files: detail.candidate.target.files,
    ...(currentFiles !== undefined ? { currentFiles } : {}),
  };
}
