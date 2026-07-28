/**
 * t-a77fe6 — the ports an approval resolution needs, built once.
 *
 * `resolveApproval` was wired twice with the same closures: the editor path
 * (`extensionOperationService`, `resolvedBy: "vscode"`) and the Companion path (`Workspace`,
 * `resolvedBy: "companion"`). `currentSessionOwner` and `inject` were byte-identical in both.
 *
 * `resolvedBy` deliberately stays a per-caller argument. "vscode" and "companion" are different facts
 * about who resolved an approval, and collapsing them would trade a duplication for a lie.
 *
 * `completePin` is also left to the caller, and NOT because it varies harmlessly: the two callers
 * disagree today about whether a failing pin completion is fatal — the editor path lets it throw, the
 * Companion path swallows it best-effort. That divergence is almost certainly unintended, but picking
 * a winner changes behaviour on one of the two paths, so this preserves both exactly and the
 * disagreement is reported rather than silently resolved here.
 */
export interface ApprovalResolutionSources {
  /** Running managed entries, for attributing a session to its agent. */
  listEntries: () => Promise<Array<{ session: string; running: boolean; name: string }>>;
  /** Submit a line into a live session. */
  sendSubmittedLine: (session: string, text: string) => Promise<void>;
}

export interface ApprovalResolutionPorts {
  currentSessionOwner: (session: string) => Promise<string | undefined>;
  inject: (session: string, text: string) => Promise<{ receipt: string }>;
}

export function approvalResolutionPorts(sources: ApprovalResolutionSources): ApprovalResolutionPorts {
  return {
    currentSessionOwner: async (session) =>
      (await sources.listEntries()).find((entry) => entry.session === session && entry.running)?.name,
    inject: async (session, text) => {
      await sources.sendSubmittedLine(session, text);
      return { receipt: `tmux:${session}` };
    },
  };
}
