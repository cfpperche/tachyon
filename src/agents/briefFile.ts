/**
 * t-11a2d1 — a long composed spawn contract embedded inline risks two failure modes at delivery:
 * upstream composers may silently ellipsis-clip it (the ~5KB brief cut mid-`done_when` that this
 * task investigated), and independently, tmux itself hard-REJECTS ("command too long") a single
 * `new-session <cmd>` argument or `send-keys -l` literal once it crosses ~16.3KB (measured live,
 * tmux 3.6 — not a truncation, a thrown error with zero prior safety margin). BRIEF_FILE_THRESHOLD
 * stays well clear of that ceiling even after primer/before-finishing framing and shell-quoting
 * overhead are added on top.
 *
 * Mirrors the manual "file = deliverable, notify = doorbell" pattern already used by hand for
 * review briefs (spec 363 notes) and reanchor's `.tachyon/roles/<agent>.md` (Workspace.reanchor):
 * the long artifact goes to a file under the gitignored `.tachyon/` dir, the pane gets a pointer.
 */
import fs from "node:fs";
import path from "node:path";

/** Comfortably under the measured ~16.3KB tmux hard-fail ceiling, with headroom for primer +
 *  before-finishing framing and shell-quoting overhead added after this check runs. */
export const BRIEF_FILE_THRESHOLD = 4000;

/** Measured tmux hard-reject range was ~16292-16334B for a single pane payload. 12KB leaves
 *  roughly 4KB for primer, before-finishing framing, and shell/tmux quoting overhead if file
 *  delivery fails and we must fall back to inline delivery. */
export const SAFE_INLINE_CEILING = 12 * 1024;

export function briefFilePath(workspaceRoot: string, agent: string): string {
  return path.join(workspaceRoot, ".tachyon", "briefs", "spawn", `${agent}.md`);
}

/**
 * Returns `body` unchanged when it's at or under BRIEF_FILE_THRESHOLD (byte-identical short-brief
 * delivery). Past the threshold, writes the full body to the agent's brief file and returns a
 * short pointer to embed in the pane instead — the file carries the contract in full, the pane
 * payload stays small. Best-effort: a write failure falls back to inlining the full body while it
 * remains below SAFE_INLINE_CEILING; above that, fail at the file-write boundary with the original
 * fs error instead of sending an oversized body onward to tmux's less actionable hard reject.
 */
export function deliverableBody(workspaceRoot: string, agent: string, body: string): string {
  if (body.length <= BRIEF_FILE_THRESHOLD) return body;
  const file = briefFilePath(workspaceRoot, agent);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, "utf8");
  } catch (err) {
    if (body.length > SAFE_INLINE_CEILING) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `spawn brief is ${body.length} chars, above the safe inline ceiling (${SAFE_INLINE_CEILING} chars), ` +
          `and writing it to ${file} failed: ${message}`,
      );
    }
    return body;
  }
  return `Your full spawn contract is long (${body.length} chars) — written in full to ${file}. Read it before starting; this pane only carries the primer + this pointer.`;
}
