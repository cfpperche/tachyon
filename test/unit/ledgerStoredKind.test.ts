import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionLedger } from "../../src/resume/SessionLedger.js";

function tmpWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-ledger-kind-"));
}

function writeSessions(ws: string, sessions: Record<string, unknown>): void {
  const dir = path.join(ws, ".tachyon");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({ sessions }), "utf8");
}

/**
 * SDD 478 M4 — a persisted entry's kind is a STORED FACT, read back as written.
 *
 * Before this, `SessionLedger` rehydrated as `kind: inferKind(o.cmd)` and fell back to the same
 * derivation whenever the stored kind was missing or not one of the two literals. That made editing
 * a 15-element array of binaries silently reclassify rows already on disk — retroactively, with no
 * human in the loop, at the one boundary where the answer should never be recomputed.
 */
describe("SessionLedger — kind is read back, never re-derived (SDD 478 M4)", () => {
  it("reads the stored kind as written, for both arms", () => {
    const ws = tmpWs();
    writeSessions(ws, {
      worker: { def: { cmd: "codex", kind: "agent" }, cwd: ws, declared: false, updatedAt: "2026-07-27T00:00:00.000Z" },
      dev: { def: { cmd: "npm run dev", kind: "terminal" }, cwd: ws, declared: false, updatedAt: "2026-07-27T00:00:00.000Z" },
    });
    const ledger = new SessionLedger(ws);
    expect(ledger.get("worker")?.def?.kind).toBe("agent");
    expect(ledger.get("dev")?.def?.kind).toBe("terminal");
  });

  it("keeps a stored kind that CONTRADICTS what the command would suggest", () => {
    // The regression this step exists for: `claude` suggests `agent` and `sh` suggests `terminal`.
    // A row that says otherwise was written that way deliberately, and re-deriving would overwrite a
    // human's decision with an array lookup.
    const ws = tmpWs();
    writeSessions(ws, {
      declared_terminal: { def: { cmd: "claude", kind: "terminal" }, cwd: ws, declared: true, updatedAt: "2026-07-27T00:00:00.000Z" },
      declared_agent: { def: { cmd: "sh", kind: "agent" }, cwd: ws, declared: true, updatedAt: "2026-07-27T00:00:00.000Z" },
    });
    const ledger = new SessionLedger(ws);
    expect(ledger.get("declared_terminal")?.def?.kind).toBe("terminal");
    expect(ledger.get("declared_agent")?.def?.kind).toBe("agent");
  });

  it("refuses a def whose kind was never written, instead of guessing it", () => {
    const ws = tmpWs();
    writeSessions(ws, {
      kindless: { def: { cmd: "claude" }, cwd: ws, declared: false, updatedAt: "2026-07-27T00:00:00.000Z" },
      bogus: { def: { cmd: "claude", kind: "robot" }, cwd: ws, declared: false, updatedAt: "2026-07-27T00:00:00.000Z" },
    });
    const ledger = new SessionLedger(ws);
    // The def is refused. `claude` is a known AI CLI, so the old fallback would have restored these
    // rows as agents — a restartable identity invented at read time.
    expect(ledger.get("kindless")?.def).toBeUndefined();
    expect(ledger.get("bogus")?.def).toBeUndefined();
  });

  it("drops a row that carried nothing but a kindless def", () => {
    const ws = tmpWs();
    writeSessions(ws, {
      onlydef: { def: { cmd: "claude" }, cwd: ws, declared: false, updatedAt: "2026-07-27T00:00:00.000Z" },
    });
    expect(new SessionLedger(ws).get("onlydef")).toBeUndefined();
  });

  it("keeps the rest of a row whose def was refused", () => {
    // Resume state is a separate concern from restart identity: refusing an unidentifiable def must
    // not throw away a session the runtime can still resume.
    const ws = tmpWs();
    writeSessions(ws, {
      mixed: {
        def: { cmd: "claude" },
        resume: { runtime: "claude", sessionId: "abc" },
        cwd: ws,
        declared: false,
        updatedAt: "2026-07-27T00:00:00.000Z",
      },
    });
    const row = new SessionLedger(ws).get("mixed");
    expect(row?.def).toBeUndefined();
    expect(row?.resume?.sessionId).toBe("abc");
  });

  it("refuses the pre-211 flat record, which never carried a kind at all", () => {
    const ws = tmpWs();
    writeSessions(ws, {
      ancient: { cmd: "claude", runtime: "claude", sessionId: "old", cwd: ws, declared: false },
    });
    expect(new SessionLedger(ws).get("ancient")).toBeUndefined();
  });

  it("does not let the authoring suggestion reach the persistence path", () => {
    // The rule is structural, so the check is too: the ledger must not even import the helper. A
    // renamed-but-still-called helper would pass a behavioral test on today's binary list and fail
    // the moment the list changes — which is exactly the failure mode M4 removes.
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "resume", "SessionLedger.ts"),
      "utf8",
    );
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect(imports.some((line) => line.includes("suggestKindForCommand"))).toBe(false);
    expect(source).not.toMatch(/\bsuggestKindForCommand\s*\(/);
    expect(source).not.toMatch(/\binferKind\s*\(/);
  });
});
