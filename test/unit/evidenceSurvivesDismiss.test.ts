import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { forgetAgent } from "@tachyon/engine/agents/forgetAgent.js";
import { SessionLedger } from "@tachyon/engine/resume/SessionLedger.js";
import { EVIDENCE_SCHEMA_VERSION, type WorktreeEvidence } from "@tachyon/engine/worktree/evidence.js";
import { loadEvidenceRecords, persistEvidenceRecord } from "@tachyon/engine/worktree/evidenceStore.js";

/**
 * t-1d198e — the caption must outlive the Temporary that produced it.
 *
 * Today attach writes the record into sessions.json and copyEvidenceArtifacts writes the bytes
 * under .tachyon/evidence/. dismissTemporary → forgetAgent → ledger.remove takes the caption
 * and leaves the bytes. This test dismisses after a real persist and fails if the summary is gone.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-evidence-dismiss-"));
  dirs.push(dir);
  return dir;
}

function record(over: Partial<WorktreeEvidence> = {}): WorktreeEvidence {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    id: "ev-2026-08-15T12:00:00.000Z-0",
    targetAgent: "oneshot",
    producer: "oneshot",
    atCommit: "abc123",
    producedAt: "2026-08-15T12:00:00.000Z",
    kind: "judgment",
    severity: "info",
    summary: "Visual QA: pass — the row heights match",
    ...over,
  };
}

describe("t-1d198e — evidence caption survives Temporary dismiss", () => {
  it("list_evidence still reads the summary after forgetAgent removes the ledger row", () => {
    const root = workspace();
    const ledger = new SessionLedger(root);
    ledger.record("oneshot", {
      cwd: root,
      def: { cmd: "claude", kind: "agent" },
      worktree: { path: root, branch: "tachyon/oneshot", tachyonCreatedBranch: true, baseRef: "HEAD", createdAt: "2026-08-15T12:00:00.000Z" },
      instance: { lifetime: "temporary", resumePolicy: "collected", lifecycleHooks: false },
    });
    const ev = record();
    // The product attach path must persist here. Writing ONLY the ledger is the defect.
    persistEvidenceRecord(root, ev);
    ledger.appendEvidence("oneshot", ev);

    forgetAgent("oneshot", { workspaceRoot: root, ledger });
    expect(ledger.get("oneshot")).toBeUndefined();

    const listed = loadEvidenceRecords(root, "oneshot");
    expect(listed.map((row) => row.summary)).toContain(ev.summary);
  });
});
