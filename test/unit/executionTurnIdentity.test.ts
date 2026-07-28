/**
 * SDD 480 Phase 2, slice 2.1 — turn identity, minted by Tachyon at input submission.
 *
 * §7.1 settled this: Tachyon mints `turnId`, and a runtime's own turn id is an ALIAS — evidence,
 * corroboration — never authority. These tests pin the part of that decision that is easy to erode
 * later, because the eroded version still looks like it works: a native id that quietly becomes the
 * correlation key would pass any test that only checked "a turn was recorded".
 */
import { describe, it, expect } from "vitest";
import { mintTurn } from "../../src/executionGraph/executionIdentity.js";
import { sendManagedAgentInput, type ManagedAgentInputSource } from "../../src/agents/agentInputService.js";
import type { SealedExecutionEvent } from "../../src/executionGraph/eventSchema.js";

function source(over: { running?: boolean; sinkThrows?: boolean } = {}) {
  const events: SealedExecutionEvent[] = [];
  const sent: Array<{ session: string; text: string; submit: boolean }> = [];
  const src: ManagedAgentInputSource = {
    manager: {
      list: async () => [{ name: "ada", kind: "agent", running: over.running ?? true, dead: false, stopping: false } as never],
      session: (agent) => `tachyon-ws-${agent}`,
    },
    tmux: { sendKeys: async (session, text, submit) => { sent.push({ session, text, submit }); } },
    recordExecution: (e) => {
      if (over.sinkThrows) throw new Error("ledger is on fire");
      events.push(e);
    },
  };
  return { src, events, sent };
}

describe("SDD 480 §7.1 — Tachyon mints the turn id", () => {
  it("mints a turn on submit and records it as a Turn node", async () => {
    const { src, events } = source();
    const turnId = await sendManagedAgentInput(src, "ada", "do the thing", true);

    expect(turnId).toMatch(/^turn-/);
    const turn = events.find((e) => e.node === "Turn");
    expect(turn, `no Turn recorded; got ${JSON.stringify(events.map((e) => e.node))}`).toBeDefined();
    expect(turn!.correlation.turnId).toBe(turnId);
    // Tachyon watched the submission happen, so this is the rare thing it can call measured outright.
    expect(turn!.provenance).toBe("measured");
  });

  it("does not mint a turn for text that was typed but never submitted", async () => {
    // Typing has not started anything. Minting here would fill the graph with turns that never ran.
    const { src, events, sent } = source();
    const turnId = await sendManagedAgentInput(src, "ada", "half a thought", false);

    expect(turnId).toBeUndefined();
    expect(events).toHaveLength(0);
    expect(sent[0]!.submit).toBe(false);
  });

  it("keeps a runtime's own turn id as an alias, never as the correlation key", async () => {
    // The erosion this guards against: a native id promoted to authority still records a turn, so a
    // weaker test would keep passing while the §7.1 decision had been silently reversed.
    const { src, events } = source();
    const turnId = await sendManagedAgentInput(src, "ada", "go", true, "codex-native-turn-777");

    const turn = events.find((e) => e.node === "Turn")!;
    expect(turn.correlation.turnId).toBe(turnId);
    expect(turn.correlation.turnId).not.toBe("codex-native-turn-777");
    // Present as evidence, under a name that cannot be mistaken for the authority.
    expect(turn.detail.nativeTurnAlias).toBe("codex-native-turn-777");
  });

  it("mints for every runtime on the same terms, alias or not", async () => {
    // The reason §7.1 chose Tachyon-minted: a runtime that exposes nothing must still get a turn id,
    // or turn identity becomes a per-runtime accident.
    const { src, events } = source();
    await sendManagedAgentInput(src, "ada", "go", true);
    const turn = events.find((e) => e.node === "Turn")!;
    expect(turn.correlation.turnId).toMatch(/^turn-/);
    expect(turn.detail.nativeTurnAlias).toBeUndefined();
  });

  it("never records the submitted text", async () => {
    // A prompt is the most likely place a caller pasted a secret, and the graph does not need it.
    const { src, events } = source();
    await sendManagedAgentInput(src, "ada", "deploy with key sk-not-a-real-key-000", true);
    expect(JSON.stringify(events)).not.toContain("sk-not-a-real-key-000");
  });

  it("still delivers the input when the ledger throws", async () => {
    const { src, sent } = source({ sinkThrows: true });
    await expect(sendManagedAgentInput(src, "ada", "go", true)).resolves.toBeDefined();
    expect(sent).toHaveLength(1);
  });

  it("records nothing for an agent that is not available", async () => {
    // The liveness check must still run first: a refused submission never became a turn.
    const { src, events } = source({ running: false });
    await expect(sendManagedAgentInput(src, "ada", "go", true)).rejects.toThrow(/not available/);
    expect(events).toHaveLength(0);
  });
});

describe("SDD 480 §7.1 — mintTurn itself", () => {
  it("mints a distinct id per call", () => {
    expect(mintTurn({ agentId: "ada" }).turnId).not.toBe(mintTurn({ agentId: "ada" }).turnId);
  });

  it("ignores a blank native id rather than recording an empty alias", () => {
    expect(mintTurn({ agentId: "ada", nativeTurnId: "   " }).nativeAlias).toBeUndefined();
  });
});
