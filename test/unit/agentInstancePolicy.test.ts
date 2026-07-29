import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { legacyFallbackUsed } from "../../src/agents/agentInstancePolicy.js";

/**
 * SDD 482 phase 2 (`t-5e1113`) + t-04052d — `lifetime` and `resumePolicy` are DECLARED, never inferred.
 *
 * `declared: boolean` answered "which store owns this definition" and was then read as though it
 * answered "what kind of worker is this". These two fields separate those questions; t-04052d then
 * removed `declared`, so they are the ONLY answer a ledger row carries.
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

describe("declared Agent Instance policy (SDD 482 phase 2, t-04052d)", () => {
  /**
   * t-04052d — the field is GONE from a persisted row, not merely unread.
   *
   * Written as a round-trip through the real file rather than a type assertion, because the type
   * disappearing is what the compiler proves and this proves the other half: nothing on the write path
   * still puts `declared` on disk, where a later build could find it and read it back.
   */
  it("writes neither `declared` nor anything derived from it", () => {
    const ws = workspace();
    const ledger = new SessionLedger(ws);
    ledger.record("saved-one", {
      def: { cmd: "claude", kind: "agent" }, cwd: ws,
      instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true },
    });
    ledger.record("temp-one", {
      def: { cmd: "claude", kind: "agent" }, cwd: ws,
      instance: { lifetime: "temporary", resumePolicy: "collected", lifecycleHooks: false },
    });

    const onDisk = JSON.parse(fs.readFileSync(ledger.path, "utf8")) as { sessions: Record<string, Record<string, unknown>> };
    for (const [name, row] of Object.entries(onDisk.sessions)) {
      expect(Object.keys(row), `${name} still writes the retired field`).not.toContain("declared");
    }
    expect(onDisk.sessions["saved-one"]!.instance).toEqual({ lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true });
    expect(onDisk.sessions["temp-one"]!.instance).toEqual({ lifetime: "temporary", resumePolicy: "collected", lifecycleHooks: false });

    const reread = new SessionLedger(ws);
    expect(reread.get("saved-one")?.instance?.lifetime).toBe("saved");
    expect(reread.get("temp-one")?.instance?.lifetime).toBe("temporary");
  });

  it("round-trips both axes through the ledger", () => {
    const ws = workspace();
    const ledger = new SessionLedger(ws);
    ledger.record("saved-one", {
      def: { cmd: "claude", kind: "agent" }, cwd: ws, instance: { lifetime: "saved", resumePolicy: "restartable" },
    });
    ledger.record("temp-one", {
      def: { cmd: "claude", kind: "agent" }, cwd: ws, instance: { lifetime: "temporary", resumePolicy: "collected" },
    });

    const reread = new SessionLedger(ws);
    expect(reread.get("saved-one")?.instance).toEqual({ lifetime: "saved", resumePolicy: "restartable" });
    expect(reread.get("temp-one")?.instance).toEqual({ lifetime: "temporary", resumePolicy: "collected" });
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
      def: { cmd: "claude", kind: "agent", fork: true }, cwd: ws, instance: { lifetime: "temporary", resumePolicy: "restartable" },
    });

    const reread = new SessionLedger(ws).get("claude-fork-1");
    expect(reread?.instance).toEqual({ lifetime: "temporary", resumePolicy: "restartable" });
    // …and the fork's definition still reloads, which is the property this phase must preserve.
    expect(reread?.def?.cmd).toBe("claude");
    expect(reread?.def?.fork).toBe(true);
  });

  /**
   * t-04052d — a pre-cut row must SURVIVE the parse while yielding no policy.
   *
   * Both halves are load-bearing and pull in opposite directions. Yielding no policy is what stops
   * this build reinterpreting a retired species. Surviving is what lets the activation gate SEE it:
   * `inspectLegacyFleet` refuses a workspace on exactly these rows, so dropping them at parse time
   * would turn that check into a no-op and silently discard a pre-cut operator's fleet instead of
   * telling them what is in the way.
   */
  it("keeps a pre-cut row readable while refusing to invent a policy for it", () => {
    const ws = workspace();
    const ledger = new SessionLedger(ws);
    fs.mkdirSync(path.dirname(ledger.path), { recursive: true });
    fs.writeFileSync(
      ledger.path,
      `${JSON.stringify({ sessions: { legacy: { def: { cmd: "claude", kind: "agent" }, cwd: ws, declared: true, updatedAt: "t" } } }, null, 2)}\n`,
      "utf8",
    );
    const row = new SessionLedger(ws).get("legacy");
    expect(row).toBeDefined();                            // the gate can still see it…
    expect(row?.def?.cmd).toBe("claude");
    expect(row?.instance).toBeUndefined();                // …and nothing was invented from it
    expect(legacyFallbackUsed(row!)).toBe(true);          // which is precisely what the gate refuses on
    expect("declared" in (row as object)).toBe(false);    // the retired field is not carried forward
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

/**
 * t-04052d — the ratified vocabulary, and the reason it is TWO fields.
 *
 * `lifetime` answers durability of the definition; `resumePolicy` answers whether the instance can be
 * started again. The fork is the case that forbids collapsing them, and it is asserted here rather
 * than assumed: one value would have to lie about one of the two, most likely about the fork
 * surviving — which is the reload this cut must not break.
 */
describe("the two axes are separate, and the fork is why (t-04052d)", () => {
  it("round-trips a fork as temporary AND restartable", () => {
    const ws = workspace();
    const ledger = new SessionLedger(ws);
    ledger.record("claude-fork-1", {
      def: { cmd: "claude", kind: "agent", fork: true }, cwd: ws, instance: { lifetime: "temporary", resumePolicy: "restartable" },
    });
    const reread = new SessionLedger(ws).get("claude-fork-1");
    expect(reread?.instance).toEqual({ lifetime: "temporary", resumePolicy: "restartable" });
    // The property the two axes exist to protect: the fork's definition still reloads.
    expect(reread?.def?.fork).toBe(true);
  });

  /**
   * A PRE-CUT row carries the old `identity` key and no `resumePolicy`. It must yield NO policy rather
   * than a half-read one — this build has no rules for the retired shape, and inventing one is the
   * inference the whole cut removes. Nothing reinterprets it: t-fab832's activation gate refuses the
   * workspace before this parser is reached with such a row.
   */
  it("refuses a pre-cut policy outright instead of half-reading it", () => {
    const ws = workspace();
    const ledger = new SessionLedger(ws);
    fs.mkdirSync(path.dirname(ledger.path), { recursive: true });
    fs.writeFileSync(ledger.path, `${JSON.stringify({
      sessions: {
        "pre-cut": {
          def: { cmd: "claude", kind: "agent" }, cwd: ws, declared: false, updatedAt: "t",
          instance: { identity: "temporary", lifetime: "restartable" },
        },
      },
    }, null, 2)}\n`, "utf8");
    expect(new SessionLedger(ws).get("pre-cut")?.instance).toBeUndefined();
  });

  it("refuses a row that carries only one of the two axes", () => {
    const ws = workspace();
    const ledger = new SessionLedger(ws);
    fs.mkdirSync(path.dirname(ledger.path), { recursive: true });
    fs.writeFileSync(ledger.path, `${JSON.stringify({
      sessions: {
        half: {
          def: { cmd: "claude", kind: "agent" }, cwd: ws, declared: false, updatedAt: "t",
          instance: { lifetime: "saved" },
        },
      },
    }, null, 2)}\n`, "utf8");
    expect(new SessionLedger(ws).get("half")?.instance).toBeUndefined();
  });
});
