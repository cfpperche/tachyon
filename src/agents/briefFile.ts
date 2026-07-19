/**
 * t-11a2d1 — a long composed startup brief embedded inline risks two failure modes at delivery:
 * upstream composers may silently ellipsis-clip it (the ~5KB brief cut mid-`done_when` that this
 * task investigated), and independently, tmux itself hard-REJECTS ("command too long") a single
 * `new-session <cmd>` argument or `send-keys -l` literal once it crosses ~16.3KB (measured live,
 * tmux 3.6 — not a truncation, a thrown error with zero prior safety margin). BRIEF_FILE_THRESHOLD
 * stays well clear of that ceiling even after primer/before-finishing framing and shell-quoting
 * overhead are added on top.
 *
 * Mirrors the manual "file = deliverable, notify = doorbell" pattern already used by hand for
 * review briefs (spec 363 notes) and reanchor's `.tachyon/roles/<agent>.md` (Workspace.reanchor):
 * the long artifact goes to a purpose-specific file under the gitignored `.tachyon/` dir, the pane
 * gets a pointer. Separate spawn/reanchor paths keep a refresh from destroying startup context.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import {
  renderStartupBriefInventory,
  renderStartupBriefSummary,
  type StartupBriefManifest,
} from "./startupBrief.js";

/** Comfortably under the measured ~16.3KB tmux hard-fail ceiling, with headroom for primer +
 *  before-finishing framing and shell-quoting overhead added after this check runs. */
export const BRIEF_FILE_THRESHOLD = 4000;

/** Measured tmux hard-reject range was ~16292-16334B for a single pane payload. 12KB leaves
 *  roughly 4KB for primer, before-finishing framing, and shell/tmux quoting overhead if file
 *  delivery fails and we must fall back to inline delivery. */
export const SAFE_INLINE_CEILING = 12 * 1024;

/** `composeCommand` wraps instructions in POSIX single quotes and expands each embedded apostrophe
 * from one byte to four (`'\\''`). Measure that expansion before deciding an inline body is small;
 * raw UTF-8 length alone can undercount the eventual tmux argv by almost 4x. The two outer quote
 * bytes are covered by the existing framing headroom. */
export function shellEscapedBodyBytes(body: string): number {
  let apostrophes = 0;
  for (const char of body) if (char === "'") apostrophes++;
  return Buffer.byteLength(body, "utf8") + apostrophes * 3;
}

/**
 * Guard the complete pane-bound brief after all primer/gate/config framing has been added. Body
 * diversion normally keeps it small; this catches oversized dynamic protocol facts (for example a
 * configured verify command or gate identifier) before tmux can reject the argv opaquely.
 */
export function assertSafeBriefTransport(body: string, context: string): void {
  const transportBytes = shellEscapedBodyBytes(body);
  if (transportBytes <= SAFE_INLINE_CEILING) return;
  throw new Error(
    `${context} is ${Buffer.byteLength(body, "utf8")} UTF-8 bytes ` +
      `(${transportBytes} shell-escaped transport bytes), above the safe pane-delivery ceiling ` +
      `(${SAFE_INLINE_CEILING} bytes); shorten configured verification/gate facts or task framing`,
  );
}

export type BriefPurpose = "spawn" | "reanchor";

export function briefFilePath(workspaceRoot: string, agent: string, purpose: BriefPurpose = "spawn"): string {
  return path.join(workspaceRoot, ".tachyon", "briefs", purpose, `${agent}.md`);
}

/** Pure preview of the body that deliverableBody will return after a successful file write. Callers
 * can frame and size-check this exact pointer before replacing an existing durable brief. */
export function previewDeliverableBody(
  workspaceRoot: string,
  agent: string,
  body: string,
  purpose: BriefPurpose = "spawn",
  startupManifest?: StartupBriefManifest,
): string {
  if (shellEscapedBodyBytes(body) <= BRIEF_FILE_THRESHOLD) return body;
  const file = briefFilePath(workspaceRoot, agent, purpose);
  const label = purpose === "spawn" ? "startup brief" : "re-anchor context";
  const timing = purpose === "spawn" ? "before starting" : "before continuing";
  const storedBody = purpose === "spawn" && startupManifest
    ? `${renderStartupBriefInventory(startupManifest)}\n\n${body}`
    : body;
  const summary = purpose === "spawn" && startupManifest
    ? `\n${renderStartupBriefSummary(startupManifest)}`
    : "";
  const paneContents = purpose === "spawn" && startupManifest
    ? "the primer, this summary, the pointer, and the before-finishing reminder"
    : "the primer, this pointer, and the before-finishing reminder";
  return `Your full ${label} is long (${Buffer.byteLength(storedBody, "utf8")} UTF-8 bytes) — written in full to ${file}.${summary}\nRead it ${timing}; this pane carries only ${paneContents}.`;
}

/**
 * Returns `body` unchanged when its UTF-8 encoding is at or under BRIEF_FILE_THRESHOLD (byte-identical short-brief
 * delivery). Past the threshold, writes the full body to the agent's brief file and returns a
 * short pointer to embed in the pane instead — the file carries the contract in full, the pane
 * payload stays small. Best-effort: a write failure falls back to inlining the full body while it
 * remains below SAFE_INLINE_CEILING; above that, fail at the file-write boundary with the original
 * fs error instead of sending an oversized body onward to tmux's less actionable hard reject.
 */
export function deliverableBody(
  workspaceRoot: string,
  agent: string,
  body: string,
  purpose: BriefPurpose = "spawn",
  startupManifest?: StartupBriefManifest,
): string {
  const bodyBytes = Buffer.byteLength(body, "utf8");
  const transportBytes = shellEscapedBodyBytes(body);
  if (transportBytes <= BRIEF_FILE_THRESHOLD) return body;
  const file = briefFilePath(workspaceRoot, agent, purpose);
  const briefLabel = purpose === "spawn" ? "startup brief" : "re-anchor context";
  const storedBody = purpose === "spawn" && startupManifest
    ? `${renderStartupBriefInventory(startupManifest)}\n\n${body}`
    : body;
  let temporaryFile: string | undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Preserve an already-delivered contract if this replacement write fails. The temporary lives
    // beside the destination so rename is atomic on the same filesystem; `wx` also prevents an
    // improbable pid/random collision from overwriting another writer's file.
    temporaryFile = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    fs.writeFileSync(temporaryFile, storedBody, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporaryFile, file);
    temporaryFile = undefined;
  } catch (err) {
    if (temporaryFile) {
      try {
        fs.rmSync(temporaryFile, { force: true });
      } catch {
        // Keep the primary delivery error. A stale uniquely-named temp is safer than masking it.
      }
    }
    if (transportBytes > SAFE_INLINE_CEILING) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${briefLabel} is ${bodyBytes} UTF-8 bytes (${transportBytes} shell-escaped transport bytes), ` +
          `above the safe inline ceiling (${SAFE_INLINE_CEILING} bytes), ` +
          `and writing it to ${file} failed: ${message}`,
      );
    }
    return body;
  }
  return previewDeliverableBody(workspaceRoot, agent, body, purpose, startupManifest);
}
