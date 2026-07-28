/**
 * t-d5066b — the execution ledger has exactly ONE writer, and this pins it.
 *
 * SDD 480 §3.1.1 rejects option (b) — letting the standalone `_tachyon-external` shim write execution
 * events directly — on the strength of this invariant. The shim CAN find the file: `engineStorageRoot`
 * is a pure function of the workspace root, so the path is derivable from outside the extension host.
 * Feasible-looking is exactly why the rejection needs a test rather than a paragraph.
 *
 * `EngineEventJournal.append` computes `seq` from its own in-memory tail. Two independent writers
 * therefore both believe they are writing seq N+1, and the file ends up with a duplicate. The next
 * open refuses it outright — so a second writer does not degrade the graph, it DESTROYS it, including
 * every event the legitimate writer had already filed.
 *
 * If a future change makes the journal genuinely multi-writer (file locking, an O_APPEND protocol with
 * server-assigned sequence, a separate spool that one process ingests), this test is the thing that
 * should be revisited — and option (b) reopened with it. Until then, it is the guard rail.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineEventJournal } from "../../src/engine-service/eventJournal.js";
import { openExecutionLedger } from "../../src/executionGraph/executionLedger.js";

const STREAM = "execution-graph-abc12345";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ledger-single-writer-"));
}

describe("t-d5066b — a second writer corrupts the journal, so the ledger stays single-writer", () => {
  it("produces a duplicate sequence when two independent writers append", () => {
    const dir = tempDir();
    try {
      const filePath = path.join(dir, "events.jsonl");
      const engine = new EngineEventJournal({ filePath, engineInstanceId: STREAM });
      // What a shim opening the same derived path would be: a second, independent view of one file.
      const shim = new EngineEventJournal({ filePath, engineInstanceId: STREAM });

      engine.append("execution", { who: "engine" });
      shim.append("execution", { who: "shim" });

      const seqs = fs.readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line).seq);
      // Both wrote 1: neither can see the other's in-memory tail.
      expect(seqs).toEqual([1, 1]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses to reopen the file at all afterwards — the graph is lost, not merely incomplete", () => {
    const dir = tempDir();
    try {
      const filePath = path.join(dir, "events.jsonl");
      const engine = new EngineEventJournal({ filePath, engineInstanceId: STREAM });
      const shim = new EngineEventJournal({ filePath, engineInstanceId: STREAM });
      engine.append("execution", { who: "engine" });
      shim.append("execution", { who: "shim" });

      // This is the cost that decided §3.1.1: not a lost event, but every event already filed.
      expect(() => new EngineEventJournal({ filePath, engineInstanceId: STREAM }))
        .toThrow(/sequence is not contiguous/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("is healthy through the single writer the production ledger actually uses", () => {
    // The counterpart: with one writer, reopening reads back everything. The invariant is about
    // concurrent writers, not about the journal being fragile.
    const storageRoot = tempDir();
    try {
      const first = openExecutionLedger({ storageRoot, workspaceHash: "abc12345" });
      for (let i = 0; i < 3; i++) {
        first.record({
          kind: "spawn", node: "Process", state: "running", provenance: "measured",
          correlation: { agentId: "ada", executionId: `exec-${i}` },
          at: "2026-07-27T12:00:00.000Z", detail: {},
        });
      }
      const reopened = openExecutionLedger({ storageRoot, workspaceHash: "abc12345" });
      expect(reopened.graph().nodes.map((n) => n.executionId)).toEqual(["exec-0", "exec-1", "exec-2"]);
    } finally { fs.rmSync(storageRoot, { recursive: true, force: true }); }
  });
});
