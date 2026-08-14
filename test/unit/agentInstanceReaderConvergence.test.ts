import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { degradedRosterExtras } from "@tachyon/engine/config/configFailure.js";
import type { SessionRecord } from "@tachyon/engine/resume/SessionLedger.js";

/**
 * SDD 482 phase 3 (`t-5e1113`) — per-reader proof for the GROUPED delivery.
 *
 * Fleet's five reads and the handoff pair were proven in their own slices. This covers the rest of
 * the readers that were genuinely asking "what kind of instance is this?", each with its own
 * assertion rather than one blanket check:
 *
 *  1. the Bridge dismiss family (`canDismiss`, the kill_agent hint, the dismiss guard);
 *  2. Board's live-Temporary filter;
 *  3. the degraded roster's `adhoc` flag, including the LKG row that has no policy to read.
 *
 * t-04052d then removed `declared` outright, so the readers below ask `lifetime` — the roster's
 * resolved answer — rather than the instance policy directly. That distinction is load-bearing and the
 * last two cases exist to keep it: a Saved agent with no ledger row (never started, or restored from
 * an LKG config snapshot) has NO instance policy, and asking the policy would classify it Temporary —
 * rendering it as Temporary and offering to dismiss it through the Bridge.
 */
const SOURCE = (rel: string): string => fs.readFileSync(path.resolve(__dirname, "../..", rel), "utf8");

function record(over: Partial<SessionRecord>): SessionRecord {
  return { def: { cmd: "claude", kind: "agent" }, cwd: "/ws", updatedAt: "t", ...over } as SessionRecord;
}

describe("reader convergence, grouped delivery (SDD 482 phase 3)", () => {
  /**
   * Reader 1. The three dismiss-family reads sat next to each other in `bridge/tools.ts` and all
   * asked the identity question through `declared`. A behavioural test cannot see a fourth one
   * appearing beside them, which is exactly how the first three drifted apart from Fleet's answer.
   */
  it("the Bridge dismiss family asks the roster's resolved lifetime, and nothing beside it asks `declared`", () => {
    // t-3b47ad — capability helpers live in tools/shared.ts; dismiss/kill handlers in tools/fleet.ts.
    const src = SOURCE("packages/engine/src/bridge/tools/shared.ts") + "\n" + SOURCE("packages/engine/src/bridge/tools/fleet.ts");
    expect(src).toMatch(/const canDismiss = info\.lifetime === "temporary" && !info\.running;/);
    // t-28bf8f narrowed this hint with a further conjunct (it must not answer a worktree-release
    // refusal with "use dismiss_agent"), so the pin stops at the reader it is actually about. What it
    // asserts is unchanged: this read asks `info.lifetime`, the roster's resolved answer.
    expect(src).toMatch(/if \(info && info\.lifetime === "temporary" && !info\.running/);
    expect(src).toMatch(/if \(info\.lifetime === "saved"\) \{/);

    // t-04052d — these ask the ROSTER row, not the instance policy, and the difference is a security
    // one rather than a style one: a Saved agent that has never been started has no ledger row, so
    // `isTemporaryInstance` would report it Temporary and make it Bridge-dismissible.
    expect(src).not.toMatch(/isTemporaryInstance/);
    expect(src.match(/info\.declared/g) ?? []).toEqual([]);
  });

  /**
   * Phase 3 deliberately left this wording alone; phase 5 renamed it — and KEPT the old term inside
   * the new sentence. That is what a compatibility alias means for a message: an operator or agent
   * grepping logs for the old phrase still lands here, instead of finding nothing and concluding the
   * refusal was removed.
   */
  it("renames the refusal to the ratified vocabulary while keeping the old term findable", () => {
    const source = SOURCE("packages/engine/src/bridge/tools/fleet.ts");
    expect(source).toContain("is a Saved Agent (declared in tachyon.yml)");
  });

  /** Reader 2. Board's live-Temporary filter, and its second guard which is NOT the same question. */
  it("Board filters live Temporary instances by policy, keeping the config-ownership guard separate", () => {
    const src = SOURCE("apps/vscode-extension/src/webview/board/boardVm.ts");
    expect(src).toMatch(/\.filter\(\(a\) => a\.lifetime === "temporary" && !declared\.has\(a\.name\)\)/);
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
        ["temp", record({ instance: { lifetime: "temporary", resumePolicy: "collected" } })],
        ["fork", record({ instance: { lifetime: "temporary", resumePolicy: "restartable" } })],
        ["legacy", record({})], // a pre-cut row: no instance policy at all
      ],
      lkg: { agents: [{ name: "from-config", kind: "agent", cmd: "claude" }] } as never,
    });
    const by = new Map(extras.map((e) => [e.name, e]));

    expect(by.get("temp")?.instance).toEqual({ lifetime: "temporary", resumePolicy: "collected" });
    expect(by.get("fork")?.instance).toEqual({ lifetime: "temporary", resumePolicy: "restartable" });
    expect(by.get("legacy")?.instance).toBeUndefined();     // pre-cut row: nothing invented
    expect(by.get("from-config")?.instance).toBeUndefined(); // a config snapshot has no instance

    // And every row still answers the question the sidebar asks — off `lifetime`, which is what the
    // LKG row makes necessary: it has no instance policy to read, and being in the last-known-good
    // config snapshot IS its durable Profile. Asking the policy would call it Temporary.
    expect(by.get("temp")?.lifetime).toBe("temporary");
    expect(by.get("fork")?.lifetime).toBe("temporary");
    expect(by.get("legacy")?.lifetime).toBe("temporary");
    expect(by.get("from-config")?.lifetime).toBe("saved");
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
      ledger: [["odd", record({ instance: { lifetime: "temporary", resumePolicy: "collected" } })]],
      lkg: null,
    });
    expect(extras[0]?.lifetime).toBe("temporary"); // the projected row states the policy's answer
    expect(extras[0]?.instance).toEqual({ lifetime: "temporary", resumePolicy: "collected" }); // carried, not rewritten
  });

  it("the sidebar's degraded rows go through the resolver too", () => {
    const src = SOURCE("packages/engine/src/sidebar/sidebarFleetService.ts");
    expect(src).not.toMatch(/adhoc: !extra\.declared/);
    expect((src.match(/adhoc: extra\.lifetime === "temporary"/g) ?? []).length).toBe(2);
  });

  /**
   * THE BOUNDARY, INVERTED — and the inversion is the deliverable, not an incidental edit.
   *
   * Phase 3 ratified decision 7 froze `declared` on the wire: a Bridge client on an older build read
   * that field, so it could not be removed, renamed, or reinterpreted without a protocol bump and a
   * compatibility window. This test enforced that freeze, and it was right to.
   *
   * `t-fab832` bought the removal by taking ENGINE_SHELL_PROTOCOL to 5 and gating activation on any
   * pre-cut state, which is exactly the bump-and-window decision 7 required. So the guard now asserts
   * the opposite fact: these projections must NOT carry `declared`, and a future change that
   * reintroduces it — as a compatibility alias, a dual-write, or a "harmless" extra field — fails here
   * rather than quietly restoring the species this cut removed.
   */
  it("keeps `declared` OFF the wire — the freeze is discharged, not merely lifted", () => {
    for (const rel of [
      "packages/engine/src/runtime-api/handoffProjection.ts",
      "apps/vscode-extension/src/runtime-api/workspaceProjection.ts",
      "packages/engine/src/runtime-api/activityProjection.ts",
      "packages/engine/src/engine-service/engineService.ts",
    ]) {
      const src = SOURCE(rel);
      // Match the FIELD, not the English word — the prose above these projections still discusses
      // `declared` by name, and it should. `declaredOwner`/`declaredAgent` are different edges.
      const retired = src.match(/(?<![A-Za-z])declared\s*:|\.declared\b(?![A-Za-z])/g) ?? [];
      expect(retired, `${rel} must not carry the retired declared field`).toEqual([]);
      expect(src, `${rel} should state lifetime instead`).toMatch(/lifetime/);
    }
  });
});
