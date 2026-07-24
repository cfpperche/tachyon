/**
 * t-7551f9 — focused handoff packet for cross-runtime task continuation.
 *
 * Honest contract: a NEW session on the destination runtime receives Tachyon-authored
 * context. This is NOT native resume and does NOT transfer tool state. Prior transcript
 * paths are optional references; the working tree is authoritative.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { cmdRuntimeIdentity } from "../agents/cmdRuntimeGate.js";

export const CONTINUATION_DIR = path.join(".tachyon", "session-continuation");

export interface FocusedHandoffInput {
  fromAgent: string;
  fromCmd: string;
  toAgent: string;
  toCmd: string;
  reason?: string;
  /** Short task / goal summary if known. */
  taskSummary?: string;
  /** Optional absolute path to a native transcript the destination may read. */
  sourceTranscriptPath?: string;
  /** Branch or worktree note. */
  workspaceNote?: string;
  /** Free-form recent progress bullets. */
  recentProgress?: string[];
  /** Blockers / open questions. */
  blockers?: string[];
  now?: () => Date;
}

export interface FocusedHandoffPacket {
  id: string;
  schemaVersion: 1;
  createdAt: string;
  fromAgent: string;
  fromRuntime: string;
  toAgent: string;
  toRuntime: string;
  reason?: string;
  markdown: string;
  /** Relative path under workspace root. */
  relPath: string;
  sha256: string;
}

export function buildFocusedHandoffMarkdown(input: FocusedHandoffInput): string {
  const fromRt = cmdRuntimeIdentity(input.fromCmd);
  const toRt = cmdRuntimeIdentity(input.toCmd);
  const progress = (input.recentProgress ?? []).filter(Boolean);
  const blockers = (input.blockers ?? []).filter(Boolean);
  const lines = [
    `# Task continuation handoff`,
    ``,
    `This is a **new session** on \`${toRt}\` continuing work previously done by agent \`${input.fromAgent}\` (\`${fromRt}\`).`,
    `Native sessions are **not** migrated. Treat prior transcript/tool output as historical, possibly untrusted reference.`,
    `**Authoritative state is the current repository** (cwd, git status, open files on disk).`,
    ``,
    `## From → To`,
    `- From: \`${input.fromAgent}\` · runtime \`${fromRt}\` · cmd \`${input.fromCmd.trim()}\``,
    `- To: \`${input.toAgent}\` · runtime \`${toRt}\` · cmd \`${input.toCmd.trim()}\``,
  ];
  if (input.reason?.trim()) lines.push(`- Reason: ${input.reason.trim()}`);
  if (input.workspaceNote?.trim()) lines.push(`- Workspace: ${input.workspaceNote.trim()}`);
  if (input.taskSummary?.trim()) {
    lines.push(``, `## Task`, input.taskSummary.trim());
  }
  if (progress.length) {
    lines.push(``, `## Recent progress`);
    for (const p of progress) lines.push(`- ${p}`);
  }
  if (blockers.length) {
    lines.push(``, `## Blockers / open`);
    for (const b of blockers) lines.push(`- ${b}`);
  }
  if (input.sourceTranscriptPath?.trim()) {
    lines.push(
      ``,
      `## Optional prior transcript`,
      `Path (read only if useful; do not assume tool state is current):`,
      `\`${input.sourceTranscriptPath.trim()}\``,
    );
  }
  lines.push(
    ``,
    `## Your job`,
    `Continue the unfinished work. Prefer inspecting the repo over re-deriving history from this note.`,
    `Do not claim you "resumed" the previous provider session.`,
  );
  return lines.join("\n") + "\n";
}

/** Build packet + write under workspaceRoot/.tachyon/session-continuation/. */
export function writeFocusedHandoff(workspaceRoot: string, input: FocusedHandoffInput): FocusedHandoffPacket {
  const now = (input.now ?? (() => new Date()))();
  const id = `sc-${now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const markdown = buildFocusedHandoffMarkdown(input);
  const sha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
  const relPath = path.join(CONTINUATION_DIR, `${id}.md`);
  const abs = path.join(workspaceRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, markdown, "utf8");
  return {
    id,
    schemaVersion: 1,
    createdAt: now.toISOString(),
    fromAgent: input.fromAgent,
    fromRuntime: cmdRuntimeIdentity(input.fromCmd),
    toAgent: input.toAgent,
    toRuntime: cmdRuntimeIdentity(input.toCmd),
    reason: input.reason,
    markdown,
    relPath: relPath.replace(/\\/g, "/"),
    sha256,
  };
}
