/**
 * t-0ab150 — session-only create progress for a worktree that is not in the registry yet.
 *
 * This is not a `ManagedWorktreeEntry.status` value and must never be written to disk. A reload
 * mid-create drops the row, which is exactly today's behavior.
 *
 * Phases are the steps the create path already crosses. Do not emit one that is not happening.
 *
 *   createChange (ManagedWorktreeService.createChange):
 *     validate → resolve-base → add → register
 *   ensure create arm (WorktreeManager.ensureLocked), only after the reuse/create split:
 *     validate → resolve-base → add → (share-dependencies if hooked) → (setup if hooked)
 */
export const WORKTREE_CREATE_PHASES = [
  "validate",
  "resolve-base",
  "add",
  "register",
  "share-dependencies",
  "setup",
] as const;

export type WorktreeCreatePhase = (typeof WORKTREE_CREATE_PHASES)[number];

export interface WorktreeCreateProgress {
  phase: WorktreeCreatePhase;
  error?: string;
}

export interface WorktreeCreateSession {
  id: string;
  kind: "agent" | "change";
  path: string;
  branch: string;
  slug?: string;
  agent?: string;
  createdAt: string;
  phase: WorktreeCreatePhase;
  error?: string;
}

/** Persisted identity wins: a registered worktree must never sit beside its own session row. */
export function mergeCreateSessions<T extends { id: string; path: string }>(
  persisted: readonly T[],
  sessions: Iterable<WorktreeCreateSession>,
): WorktreeCreateSession[] {
  const ids = new Set(persisted.map((entry) => entry.id));
  const paths = new Set(persisted.map((entry) => entry.path));
  return [...sessions].filter((session) => !ids.has(session.id) && !paths.has(session.path));
}

export function isWorktreeCreatePhase(value: string): value is WorktreeCreatePhase {
  return (WORKTREE_CREATE_PHASES as readonly string[]).includes(value);
}
