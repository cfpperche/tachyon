import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { degradedRosterExtras } from "../../src/config/configFailure.js";
import { isTemporaryInstance } from "../../src/agents/agentInstancePolicy.js";
import type { SessionRecord } from "../../src/resume/SessionLedger.js";

/**
 * SDD 482 phase 3 (`t-5e1113`) — per-reader proof for the GROUPED delivery.
 *
 * Fleet's five reads and the handoff pair were proven in their own slices. This covers the rest of
 * the readers that were genuinely asking "what kind of instance is this?", each with its own
 * assertion rather than one blanket check:
 *
 *  1. the Bridge dismiss family (`canDismiss`, the kill_agent hint, the dismiss guard);
 *  2. Mission Control's live-Temporary filter;
 *  3. the degraded roster's `adhoc` flag, including the LKG row that has no policy to read.
 *
 * It also PINS THE BOUNDARY the sweep found. `declared` still appears in four projections and in
 * `declaredAgentNames`, and those are not stragglers — they are a wire field and a storage question
 * respectively. A future convergence pass that "finishes the job" by converting them would widen the
 * Bridge protocol without a version bump, which `t-5e1113` forbids. The assertions below fail if
 * that happens, so the boundary is enforced rather than merely documented.
 */
const SOURCE = (rel: string): string => fs.readFileSync(path.resolve(__dirname, "../..", rel), "utf8");

function record(over: Partial<SessionRecord>): SessionRecord {
  return { def: { cmd: "claude", kind: "agent" }, cwd: "/ws", declared: false, updatedAt: "t", ...over } as SessionRecord;
}

describe("reader convergence, grouped delivery (SDD 482 phase 3)", () => {
  /**
   * Reader 1. The three dismiss-family reads sat next to each other in `bridge/tools.ts` and all
   * asked the identity question through `declared`. A behavioural test cannot see a fourth one
   * appearing beside them, which is exactly how the first three drifted apart from Fleet's answer.
   */
  it("the Bridge dismiss family asks the resolver, and nothing beside it asks `declared`", () => {
    const src = SOURCE("src/bridge/tools.ts");
    expect(src).toMatch(/const canDismiss = isTemporaryInstance\(info\) && !info\.running;/);
    expect(src).toMatch(/if \(info && isTemporaryInstance\(info\) && !info\.running\)/);
    expect(src).toMatch(/if \(!isTemporaryInstance\(info\)\) return fail/);

    // No remaining identity read of an entry row. `info.declared` may still appear as the REASON
    // string's input (it explains which store owns the row), which is what `declared` means.
    const identityReads = src.match(/[!(]\s*info\.declared\s*(?:&&|\)|;)/g) ?? [];
    expect(identityReads).toEqual([]);
  });

  /**
   * The user-visible refusal wording is deliberately UNCHANGED. This slice's claim is that the
   * question moved and the behaviour did not; renaming a Bridge-visible message inside it would make
   * that claim untestable from the outside. The rename belongs to the terminology phase.
   */
  it("does not rename the Bridge-visible refusal while claiming behaviour is unchanged", () => {
    expect(SOURCE("src/bridge/tools.ts")).toContain("is declared in tachyon.yml and cannot be dismissed through the Bridge");
  });

  /** Reader 2. Mission Control's live-Temporary filter, and its second guard which is NOT the same question. */
  it("Mission Control filters live Temporary instances by policy, keeping the config-ownership guard separate", () => {
    const src = SOURCE("src/cockpit/missionVm.ts");
    expect(src).toMatch(/\.filter\(\(a\) => isTemporaryInstance\(a\) && !declared\.has\(a\.name\)\)/);
    // `declared.has(name)` is a set of CONFIG-OWNED NAMES — a different question, correctly kept.
    expect(src).toMatch(/const declared = new Set\(ws\.declaredAgentNames\(\)\)/);
  });

  /**
   * Reader 3. The degraded roster is the interesting one: it is built when config fails to parse, so
   * half its rows come from the ledger (which now carries a policy) and half from the last-known-good
   * CONFIG snapshot (which never did). The LKG half must fall back rather than invent.
   */
  it("carries the ledger's declared policy into the degraded roster, and leaves LKG rows without one", () => {
    const extras = degradedRosterExtras({
      existingNames: new Set<string>(),
      ledger: [
        ["temp", record({ declared: false, instance: { identity: "temporary", lifetime: "collected" } })],
        ["fork", record({ declared: false, instance: { identity: "temporary", lifetime: "restartable" } })],
        ["legacy", record({ declared: false })],
      ],
      lkg: { agents: [{ name: "from-config", kind: "agent", cmd: "claude" }] } as never,
    });
    const by = new Map(extras.map((e) => [e.name, e]));

    expect(by.get("temp")?.instance).toEqual({ identity: "temporary", lifetime: "collected" });
    expect(by.get("fork")?.instance).toEqual({ identity: "temporary", lifetime: "restartable" });
    expect(by.get("legacy")?.instance).toBeUndefined();     // pre-split row: nothing invented
    expect(by.get("from-config")?.instance).toBeUndefined(); // a config snapshot has no instance

    // And every row still answers the question the sidebar asks, legacy rows included.
    expect(isTemporaryInstance(by.get("temp")!)).toBe(true);
    expect(isTemporaryInstance(by.get("fork")!)).toBe(true);
    expect(isTemporaryInstance(by.get("legacy")!)).toBe(true);
    expect(isTemporaryInstance(by.get("from-config")!)).toBe(false);
  });

  /**
   * The divergence that justifies the whole split, on the reader that would be hurt most by it. A row
   * whose STORAGE says config-owned but whose declared POLICY says temporary must be dismissible: the
   * policy is the answer. Under `!declared` this row was undismissable and the user had to edit a
   * `tachyon.yml` that does not describe it.
   */
  it("follows the policy, not the store, when the two disagree", () => {
    const extras = degradedRosterExtras({
      existingNames: new Set<string>(),
      ledger: [["odd", record({ declared: true, instance: { identity: "temporary", lifetime: "collected" } })]],
      lkg: null,
    });
    expect(extras[0]?.declared).toBe(true);            // the storage fact is preserved, not rewritten
    expect(isTemporaryInstance(extras[0]!)).toBe(true); // and the policy still decides
  });

  it("the sidebar's degraded rows go through the resolver too", () => {
    const src = SOURCE("src/sidebar/sidebarFleetService.ts");
    expect(src).not.toMatch(/adhoc: !extra\.declared/);
    expect((src.match(/adhoc: isTemporaryInstance\(extra\)/g) ?? []).length).toBe(2);
  });

  /**
   * The boundary. These four sites carry `declared` ACROSS THE WIRE — a Bridge client on an older
   * build reads that field. Converting them changes a protocol field's meaning silently, which is a
   * versioned change and not a reader convergence. Left as-is on purpose; this fails if someone
   * "finishes" the migration through them.
   */
  it("leaves `declared` on the wire alone — protocol widening is not part of this migration", () => {
    for (const rel of [
      "src/runtime-api/handoffProjection.ts",
      "src/runtime-api/workspaceProjection.ts",
      "src/runtime-api/activityProjection.ts",
      "src/engine-service/engineService.ts",
    ]) {
      const src = SOURCE(rel);
      expect(src, `${rel} should still carry declared on the wire`).toMatch(/declared/);
      expect(src, `${rel} must not read instance policy`).not.toMatch(/isTemporaryInstance/);
    }
  });
});
