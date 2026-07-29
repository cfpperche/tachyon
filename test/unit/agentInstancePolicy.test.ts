import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionLedger } from "../../src/resume/SessionLedger.js";

/**
 * SDD 482 phase 2 (`t-5e1113`) — `identity` and `lifetime` are DECLARED, never inferred.
 *
 * `declared: boolean` answered "which store owns this definition" and was then read as though it
 * answered "what kind of worker is this". These two fields separate those questions. This slice is
 * the WRITE side only: readers still use `declared`, and moving them is phase 3, deliberately apart
 * so the write side can be proven before anything depends on it.
 */
const dirs: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-instance-policy-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("declared Agent Instance policy (SDD 482 phase 2)", () => {
  it("round-trips both axes through the ledger", () => {
    const ws = workspace();
    const ledger = new SessionLedger(ws);
    ledger.record("saved-one", {
      def: { cmd: "claude", kind: "agent" }, cwd: ws, declared: true,
      instance: { identity: "saved", lifetime: "restartable" },
    });
    ledger.record("temp-one", {
      def: { cmd: "claude", kind: "agent" }, cwd: ws, declared: false,
      instance: { identity: "temporary", lifetime: "collected" },
    });

    const reread = new SessionLedger(ws);
    expect(reread.get("saved-one")?.instance).toEqual({ identity: "saved", lifetime: "restartable" });
    expect(reread.get("temp-one")?.instance).toEqual({ identity: "temporary", lifetime: "collected" });
  });

  /**
   * The case that justifies two fields instead of one enum. A fork has no durable Profile, so it is
   * `temporary`; it owns a resume block, so it is `restartable`. One value would have to lie about
   * one of the two — most likely about whether the fork survives, which is the reload this phase
   * must not break.
   */
  it("carries a temporary identity with a restartable lifetime — the axes are independent", () => {
    const ws = workspace();
    const ledger = new SessionLedger(ws);
    ledger.record("claude-fork-1", {
      def: { cmd: "claude", kind: "agent", fork: true }, cwd: ws, declared: false,
      instance: { identity: "temporary", lifetime: "restartable" },
    });

    const reread = new SessionLedger(ws).get("claude-fork-1");
    expect(reread?.instance).toEqual({ identity: "temporary", lifetime: "restartable" });
    // …and the fork's definition still reloads, which is the property this phase must preserve.
    expect(reread?.def?.cmd).toBe("claude");
    expect(reread?.def?.fork).toBe(true);
    expect(reread?.declared).toBe(false);
  });

  /**
   * A row written before the split has no honest value. Absent must stay absent: synthesising one
   * from `declared` at read time would re-create the very inference this replaces.
   */
  it("leaves a pre-split row's policy absent rather than inventing one", () => {
    const ws = workspace();
    const ledger = new SessionLedger(ws);
    fs.mkdirSync(path.dirname(ledger.path), { recursive: true });
    fs.writeFileSync(
      ledger.path,
      `${JSON.stringify({ sessions: { legacy: { def: { cmd: "claude", kind: "agent" }, cwd: ws, declared: true, updatedAt: "t" } } }, null, 2)}\n`,
      "utf8",
    );
    const row = new SessionLedger(ws).get("legacy");
    expect(row?.declared).toBe(true);      // the storage fact still parses
    expect(row?.instance).toBeUndefined(); // and nothing was invented from it
  });

  it("drops a policy this build does not understand instead of coercing it", () => {
    const ws = workspace();
    const ledger = new SessionLedger(ws);
    fs.mkdirSync(path.dirname(ledger.path), { recursive: true });
    fs.writeFileSync(
      ledger.path,
      `${JSON.stringify({
        sessions: {
          future: {
            def: { cmd: "claude", kind: "agent" }, cwd: ws, declared: false, updatedAt: "t",
            instance: { identity: "leased", lifetime: "restartable" },
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    // Fail closed: an unknown identity must not be read as one of the two values this build knows.
    expect(new SessionLedger(ws).get("future")?.instance).toBeUndefined();
  });
});
