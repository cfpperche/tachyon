import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tempDir.js";
import { openExecutionLedger, executionLedgerLocation } from "../../src/executionGraph/executionLedger.js";
import { readExecutionLedger } from "../../src/executionGraph/executionLedgerReader.js";
import { sealExecutionEvent } from "../../src/executionGraph/eventSchema.js";

/**
 * t-c6a89e — Control reads the ledger the engine wrote, without becoming a second writer.
 *
 * The ledger is single-writer by design (t-d5066b) and the writer is the daemon. The obvious route,
 * `openExecutionLedger`, builds an `EngineEventJournal` whose constructor creates the parent
 * directory and rewrites the file past `maxEvents` — so "just read it" would quietly make the shell a
 * writer. These tests pin that it does not.
 */

const HASH = "a2e81f24";

function ledgerWith(count: number): string {
  const storageRoot = makeTempDir("execution-ledger-read-");
  const ledger = openExecutionLedger({ storageRoot, workspaceHash: HASH });
  for (let i = 0; i < count; i += 1) {
    ledger.record(sealExecutionEvent({
      kind: "spawn",
      node: "Process",
      state: "running",
      provenance: "measured",
      correlation: { agentId: "ada", executionId: `exec-${i}` },
      // t-2622eb — relative, never a calendar date: the ledger ages events against the real clock.
    at: new Date().toISOString(),
      detail: { cwd: "/repo" },
    }));
  }
  return storageRoot;
}

describe("t-c6a89e — the shell reads the execution ledger read-only", () => {
  it("reads back what the engine wrote", () => {
    const storageRoot = ledgerWith(3);

    const read = readExecutionLedger({ storageRoot, workspaceHash: HASH });

    expect(read.available).toBe(true);
    expect(read.events).toHaveLength(3);
    expect(read.events[0]?.correlation.executionId).toBe("exec-0");
    expect(read.events[0]?.detail.cwd).toBe("/repo");
  });

  it("never creates, moves or rewrites anything", () => {
    // The contract that matters most: the writer's bytes and mtime survive a read untouched, and a
    // read of a workspace that never recorded does not bring the directory into existence.
    const storageRoot = ledgerWith(2);
    const { filePath } = executionLedgerLocation({ storageRoot, workspaceHash: HASH });
    const before = fs.statSync(filePath);

    readExecutionLedger({ storageRoot, workspaceHash: HASH });
    readExecutionLedger({ storageRoot, workspaceHash: HASH });

    const after = fs.statSync(filePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    const virgin = makeTempDir("execution-ledger-virgin-");
    readExecutionLedger({ storageRoot: virgin, workspaceHash: HASH });
    expect(fs.existsSync(path.join(virgin, "events"))).toBe(false);
  });

  it("reports a workspace that never recorded as unavailable, not as empty", () => {
    // `available: false` is "no ledger exists"; an existing ledger with no events is a different
    // fact, and the section says different things about them.
    const read = readExecutionLedger({ storageRoot: makeTempDir("execution-ledger-none-"), workspaceHash: HASH });

    expect(read).toEqual({ events: [], available: false });
  });

  it("distinguishes an existing but empty ledger from a missing one", () => {
    const storageRoot = ledgerWith(0);
    const { filePath } = executionLedgerLocation({ storageRoot, workspaceHash: HASH });
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, "", { mode: 0o600 });

    expect(readExecutionLedger({ storageRoot, workspaceHash: HASH }))
      .toEqual({ events: [], available: true });
  });

  it("throws on a corrupt ledger instead of reporting that nothing ran", () => {
    // Fail honest. Swallowing this into an empty list would report "no executions" about a workspace
    // whose history we simply could not read — the caller turns the throw into an error state.
    const storageRoot = ledgerWith(1);
    const { filePath } = executionLedgerLocation({ storageRoot, workspaceHash: HASH });
    fs.appendFileSync(filePath, "{not json}\n");

    expect(() => readExecutionLedger({ storageRoot, workspaceHash: HASH })).toThrow();
  });

  it("refuses a ledger written under a different workspace's stream id", () => {
    // The file is addressed by workspace: reading someone else's events would attribute another
    // workspace's history to this one.
    const storageRoot = ledgerWith(1);

    expect(() => readExecutionLedger({ storageRoot, workspaceHash: "ffffffff" })).toThrow();
  });
});
