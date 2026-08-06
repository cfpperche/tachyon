/**
 * t-181925 / Codex C-06 — reply must not resolve the wrong turn's wait.
 *
 * RED-before-green proof lives in the match rules: a late reply (prior turn id)
 * or a wrong-agent reply must fail closed without resolving the current wait.
 */
import { describe, expect, it } from "vitest";
import {
  agentSwitchRetargetsWait,
  matchDmChatReplyToWait,
  mintDmChatTurnId,
  waitPollAgent,
  type DmChatTurnWait,
} from "../../src/webview/ide-browser-bridge/designModeChatTurn.js";

function wait(partial: Partial<DmChatTurnWait> & Pick<DmChatTurnWait, "turnId" | "agent">): DmChatTurnWait {
  return { sawBusy: false, ...partial };
}

describe("designModeChatTurn identity (t-181925 / C-06)", () => {
  it("mints distinct host turn ids with a stable prefix", () => {
    const a = mintDmChatTurnId(() => "aaa");
    const b = mintDmChatTurnId(() => "bbb");
    expect(a).toBe("dm-turn-aaa");
    expect(b).toBe("dm-turn-bbb");
    expect(a).not.toBe(b);
  });

  it("rejects a late reply that carries a prior turn id (wrong-turn resolve)", () => {
    // Scenario: human sent turn-1, then turn-2; agent replies for turn-1 late.
    // Pre-fix: any reply cleared the single global wait → turn-2 looked answered.
    const pending = wait({ turnId: "dm-turn-2", agent: "alice", sawBusy: true });
    const late = matchDmChatReplyToWait(pending, {
      turnId: "dm-turn-1",
      agent: "alice",
    });
    expect(late).toEqual({
      ok: false,
      error: expect.stringMatching(/does not match pending turn 'dm-turn-2'/),
    });
    // Wait identity is unchanged by a failed match (caller must not clear).
    expect(pending.turnId).toBe("dm-turn-2");
  });

  it("rejects a reply with no turn id while a wait is outstanding", () => {
    const pending = wait({ turnId: "dm-turn-9", agent: "alice" });
    const bare = matchDmChatReplyToWait(pending, { agent: "alice" });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error).toMatch(/turnId required/i);
  });

  it("rejects a reply for a different agent even with the right turn id", () => {
    const pending = wait({ turnId: "dm-turn-3", agent: "alice" });
    const wrongAgent = matchDmChatReplyToWait(pending, {
      turnId: "dm-turn-3",
      agent: "bob",
    });
    expect(wrongAgent.ok).toBe(false);
    if (!wrongAgent.ok) expect(wrongAgent.error).toMatch(/does not match pending turn agent/);
  });

  it("accepts a matching turn id + agent and marks the wait resolved", () => {
    const pending = wait({ turnId: "dm-turn-4", agent: "alice" });
    expect(matchDmChatReplyToWait(pending, { turnId: "dm-turn-4", agent: "alice" })).toEqual({
      ok: true,
      resolvesWait: true,
    });
    // Agent may be omitted when turnId already binds (caller identity can fill speaker).
    expect(matchDmChatReplyToWait(pending, { turnId: "dm-turn-4" })).toEqual({
      ok: true,
      resolvesWait: true,
    });
  });

  it("allows orphan replies when no wait is pending (does not invent a resolve)", () => {
    expect(matchDmChatReplyToWait(null, { turnId: "dm-turn-x", agent: "alice" })).toEqual({
      ok: true,
      resolvesWait: false,
    });
    expect(matchDmChatReplyToWait(null, { text: "hi" } as { turnId?: string })).toEqual({
      ok: true,
      resolvesWait: false,
    });
  });

  it("never retargets an in-flight wait when the UI switches agents", () => {
    const pending = wait({ turnId: "dm-turn-5", agent: "alice", sawBusy: true });
    // Pre-fix: pollChatAgentState read this.designAgent, so a switch made the
    // wait follow bob while alice still owned the turn.
    expect(agentSwitchRetargetsWait(pending, "bob")).toBe(false);
    expect(waitPollAgent(pending, "bob")).toBe("alice");
    expect(waitPollAgent(pending, "alice")).toBe("alice");
    expect(waitPollAgent(null, "bob")).toBeNull();
  });
});
