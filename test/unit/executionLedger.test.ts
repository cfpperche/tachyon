/**
 * SDD 480 Phase 2, slices 2.3 + 2.5 — the ledger and its per-agent budget.
 *
 * The tests are grouped around the two claims the phase gate actually rests on:
 *  - a restarted Control rebuilds the SAME graph, because the graph is a projection of the log and
 *    not state that only exists while a process is alive;
 *  - one noisy agent cannot spend the shared bound and evict everyone else's history, and when it is
 *    refused that refusal is COUNTABLE rather than silent.
 *
 * The last one is deliberately tested against a REAL `EngineEventJournal` on a real file, not only
 * the in-memory double: the 0600/append-only/schemaVersion guarantees are the reason the spec said to
 * reuse that primitive, and a ledger that only ever ran against a fake would not have exercised them.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineEventJournal } from "../../src/engine-service/eventJournal.js";
import {
  ExecutionLedger,
  EXECUTION_EVENT_KIND,
  type ExecutionJournalPort,
} from "../../src/executionGraph/executionLedger.js";
import { sealExecutionEvent, type SealedExecutionEvent } from "../../src/executionGraph/eventSchema.js";

/** In-memory stand-in with the same append/readAfter contract, for the cases that do not need a file. */
function fakeJournal(): ExecutionJournalPort & { entries: Array<{ kind: string; payload: Record<string, unknown> }> } {
  const entries: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  return {
    entries,
    append(kind, payload) { entries.push({ kind, payload: JSON.parse(JSON.stringify(payload)) }); return undefined; },
    readAfter(afterSeq, limit = 200) {
      return { events: entries.slice(afterSeq, afterSeq + limit), latestSeq: entries.length };
    },
  };
}

/**
 * Fill an agent's budget until it is refused, with a hard cap.
 *
 * The cap is the point: an unbounded `while (record(...))` would HANG rather than fail if the budget
 * check ever regressed, and a suite that hangs is far worse to diagnose than one that fails. This
 * turns that regression into a named assertion.
 */
function fillUntilRefused(ledger: ExecutionLedger, agentId: string, cap = 500): number {
  let admitted = 0;
  for (let i = 0; i < cap; i++) {
    if (!ledger.record(event({ correlation: { agentId, executionId: `exec-${agentId}-${i}` } }))) return admitted;
    admitted++;
  }
  throw new Error(`budget never refused ${agentId} after ${cap} events — the per-agent bound is not holding`);
}

function event(over: Partial<Parameters<typeof sealExecutionEvent>[0]> = {}): SealedExecutionEvent {
  return sealExecutionEvent({
    kind: "spawn",
    node: "Process",
    state: "running",
    provenance: "measured",
    correlation: { agentId: "ada", executionId: "exec-1" },
    at: "2026-07-27T12:00:00.000Z",
    ...over,
  });
}

describe("SDD 480 §2.3 — the ledger is a durable log the graph is projected from", () => {
  it("rebuilds the same graph after a restart, from the journal alone", () => {
    const journal = fakeJournal();
    const live = new ExecutionLedger({ journal });
    live.record(event({ correlation: { agentId: "ada", executionId: "exec-anchor" }, node: "TmuxSession", state: "shared" }));
    live.record(event({
      correlation: { agentId: "ada", executionId: "exec-client" },
      kind: "attach",
      edge: { kind: "attached", toExecutionId: "exec-anchor" },
    }));

    // A second ledger over the same journal is exactly what a restarted Control is: no shared memory,
    // only the log. If these differ, the graph was never really durable.
    const restarted = new ExecutionLedger({ journal });
    expect(restarted.graph()).toEqual(live.graph());
    expect(restarted.graph().edges).toEqual([{ from: "exec-client", to: "exec-anchor", kind: "attached" }]);
    expect(restarted.graph().nodes.map((n) => n.executionId).sort()).toEqual(["exec-anchor", "exec-client"]);
  });

  it("folds later events onto the same node instead of duplicating it", () => {
    const ledger = new ExecutionLedger({ journal: fakeJournal() });
    ledger.record(event({ at: "2026-07-27T12:00:00.000Z" }));
    ledger.record(event({ kind: "exit", state: "completed", at: "2026-07-27T12:05:00.000Z" }));

    const nodes = ledger.graph().nodes;
    expect(nodes).toHaveLength(1);
    // Last write wins: the newest event is the most recent thing known to be true about the execution.
    expect(nodes[0]!.state).toBe("completed");
    expect(nodes[0]!.firstSeenAt).toBe("2026-07-27T12:00:00.000Z");
    expect(nodes[0]!.lastSeenAt).toBe("2026-07-27T12:05:00.000Z");
  });

  it("shows a shared execution as claimed by every agent, and owned exclusively by none", () => {
    // The scenario that motivated the spec: two agents on one daemon. Recording an owner would be a
    // lie; the graph derives it from the fact that two agents claimed the same execution.
    const ledger = new ExecutionLedger({ journal: fakeJournal() });
    ledger.record(event({ correlation: { agentId: "ada", executionId: "exec-daemon" }, state: "shared" }));
    ledger.record(event({ correlation: { agentId: "bob", executionId: "exec-daemon" }, state: "shared" }));

    expect(ledger.graph().nodes[0]!.agentIds).toEqual(["ada", "bob"]);
    expect(ledger.isExclusivelyOwned("exec-daemon")).toBe(false);
  });

  it("ignores foreign events sharing the journal", () => {
    // The engine journal is shared infrastructure; another writer's events must not become graph nodes.
    const journal = fakeJournal();
    journal.append("engine-started", { note: "not an execution" });
    const ledger = new ExecutionLedger({ journal });
    ledger.record(event());
    expect(ledger.readAll()).toHaveLength(1);
    expect(journal.entries.filter((e) => e.kind === EXECUTION_EVENT_KIND)).toHaveLength(1);
  });
});

describe("SDD 480 §7.2 — bytes per agent first, age second", () => {
  it("refuses a noisy agent past its budget instead of letting it evict its neighbours", () => {
    const ledger = new ExecutionLedger({ journal: fakeJournal(), maxBytesPerAgent: 600 });
    let admitted = 0;
    for (let i = 0; i < 40; i++) if (ledger.record(event({ correlation: { agentId: "noisy", executionId: `exec-${i}` } }))) admitted++;

    expect(admitted).toBeGreaterThan(0);
    expect(ledger.droppedFor("noisy")).toBeGreaterThan(0);
    expect(ledger.bytesFor("noisy")).toBeLessThanOrEqual(600);

    // The point of the bound: a quiet agent is still admitted after a noisy one has been cut off.
    expect(ledger.record(event({ correlation: { agentId: "quiet", executionId: "exec-q" } }))).toBe(true);
    expect(ledger.droppedFor("quiet")).toBe(0);
  });

  it("counts refusals rather than discarding silently", () => {
    // Silent truncation reads, from outside, exactly like a graph that never saw the event — which is
    // the one impression this spec exists to prevent.
    const ledger = new ExecutionLedger({ journal: fakeJournal(), maxBytesPerAgent: 1 });
    expect(ledger.record(event())).toBe(false);
    expect(ledger.droppedFor("ada")).toBe(1);
    expect(ledger.readAll()).toHaveLength(0);
  });

  it("frees an agent's budget as its events age out, without deleting them from the log", () => {
    let clock = Date.parse("2026-07-27T12:00:00.000Z");
    const journal = fakeJournal();
    const ledger = new ExecutionLedger({ journal, maxBytesPerAgent: 400, maxAgeMs: 60_000, now: () => clock });

    fillUntilRefused(ledger, "ada");
    const stored = ledger.readAll().length;
    expect(stored).toBeGreaterThan(0);
    expect(ledger.record(event({ correlation: { agentId: "ada", executionId: "exec-over" } }))).toBe(false);

    clock += 120_000; // everything recorded above is now older than maxAgeMs
    expect(ledger.bytesFor("ada")).toBe(0);
    expect(ledger.record(event({ correlation: { agentId: "ada", executionId: "exec-after-age" }, at: "2026-07-27T12:02:00.000Z" }))).toBe(true);
    // Age frees the BUDGET; it does not rewrite history. The old events are still in the log.
    expect(ledger.readAll().length).toBe(stored + 1);
  });

  it("recovers per-agent accounting from the journal, so a restart is not a fresh budget", () => {
    // Without this a crash loop would hand the noisiest agent a clean allowance on every restart —
    // precisely when the bound matters most.
    const journal = fakeJournal();
    const first = new ExecutionLedger({ journal, maxBytesPerAgent: 600 });
    fillUntilRefused(first, "ada");
    const spent = first.bytesFor("ada");

    const restarted = new ExecutionLedger({ journal, maxBytesPerAgent: 600 });
    expect(restarted.bytesFor("ada")).toBe(spent);
    expect(restarted.record(event({ correlation: { agentId: "ada", executionId: "exec-post-restart" } }))).toBe(false);
  });
});

describe("SDD 480 §2.3 — over the real EngineEventJournal", () => {
  it("persists through a real 0600 journal file and rebuilds from it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "execution-ledger-"));
    try {
      const filePath = path.join(dir, "events.jsonl");
      const open = () => new EngineEventJournal({ filePath, engineInstanceId: "engine-instance-1" });

      const ledger = new ExecutionLedger({ journal: open() as unknown as ExecutionJournalPort });
      ledger.record(event({ correlation: { agentId: "ada", executionId: "exec-real" } }));
      ledger.record(event({ kind: "exit", state: "completed", correlation: { agentId: "ada", executionId: "exec-real" } }));

      // The reason the spec said to reuse this primitive rather than write another log.
      expect(fs.statSync(filePath).mode & 0o077).toBe(0);

      const reopened = new ExecutionLedger({ journal: open() as unknown as ExecutionJournalPort });
      expect(reopened.graph().nodes).toHaveLength(1);
      expect(reopened.graph().nodes[0]!.state).toBe("completed");
      expect(reopened.bytesFor("ada")).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a secret out of the file, because everything is sealed before it is written", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "execution-ledger-secret-"));
    try {
      const filePath = path.join(dir, "events.jsonl");
      const ledger = new ExecutionLedger({
        journal: new EngineEventJournal({ filePath, engineInstanceId: "engine-instance-1" }) as unknown as ExecutionJournalPort,
      });
      // A realistic shape: a token handed to a child on its command line, which is exactly how one
      // reaches an argv in this codebase.
      const token = "tachyon-agent-token-9f3b7c21d4e85a60";
      ledger.record(sealExecutionEvent({
        kind: "spawn", node: "Process", state: "running", provenance: "measured",
        correlation: { agentId: "ada", executionId: "exec-secret" },
        at: "2026-07-27T12:00:00.000Z",
        detail: { cmd: `claude --token ${token}` },
        knownSecrets: [token],
      }));

      const written = fs.readFileSync(filePath, "utf8");
      expect(written).not.toContain(token);
      // Absence of the token is not enough on its own: dropping the whole detail would also pass that.
      // The surrounding command must survive, or this test would keep passing if sanitization silently
      // became omission — and the graph would lose the evidence it exists to carry.
      expect(written).toContain("claude --token");
      expect(ledger.readAll()[0]!.detail.cmd).toMatch(/^claude --token /);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
