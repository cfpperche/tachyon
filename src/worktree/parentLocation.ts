/**
 * t-c9da28 — where a parent agent runs, asked of every authority that might still know.
 *
 * The order is the point. A parented child inherits its parent's directory, and until now that came
 * from ONE source: the session ledger. A ledger row can be retired while the agent it described is
 * alive and working, and when that happened the child was silently born at the workspace root — the
 * one place an isolated child least belongs — while the very same code path refused an explicit
 * `cwd` from the caller so as never to mislead them about where the child runs.
 *
 * So this asks in descending order of authority, and separates the two absences that used to look
 * identical: "we cannot locate a parent we know" (survivable, the child falls back and is told) from
 * "there is no such parent" (a caller mistake no guess can repair).
 */
export interface ParentLocationSources {
  /** The session ledger row, if the workspace still holds one. */
  ledgerRow: () => { cwd?: string; worktreePath?: string } | undefined;
  /** The managed worktree registry — a durable RECORD of where the parent was put. */
  managedWorktreePath: () => string | undefined;
  /** Live sessions. Consulted last because it costs a round-trip and answers only "it exists". */
  isLiveAgent: () => Promise<boolean>;
}

export async function resolveParentLocation(
  sources: ParentLocationSources,
): Promise<{ cwd?: string; known: boolean }> {
  const row = sources.ledgerRow();
  const recorded = row?.worktreePath ?? row?.cwd;
  // The fast path, and the only one that costs nothing.
  if (recorded) return { cwd: recorded, known: true };
  // Recovery, not guesswork: the registry recorded where this agent was actually put, and it outlives
  // a retired ledger row.
  const managed = sources.managedWorktreePath();
  if (managed) return { cwd: managed, known: true };
  // A row with no directory in it is still proof the agent exists — enough to fall back rather than
  // refuse, which is what keeps a restarted coordinator able to spawn.
  if (row) return { known: true };
  return { known: await sources.isLiveAgent() };
}
