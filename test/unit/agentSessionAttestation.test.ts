import { describe, expect, it } from "vitest";
import {
  POST_CUT_SESSION_ATTESTATION,
  POST_CUT_SESSION_ATTESTATION_ENV,
  withPostCutAttestation,
} from "@tachyon/engine/agents/legacyFleetGate.js";

/**
 * t-e73e54 — every path that creates an AGENT session must mint the post-cut attestation.
 *
 * `legacyFleetGate` refuses to activate a workspace holding an agent session without it. The mint was
 * an inline spread at the spawn door, under a comment claiming that door was the only one that creates
 * an agent session. It was not: restart/resume reached tmux through `startSessionCommandUnlocked`,
 * which passed its env straight through. A resumed Saved Agent came back unattested, the gate
 * correctly refused, and the remedy the refusal names — stop and restart the fleet — went through that
 * same unattested path. The workspace could not escape its own error message.
 *
 * The comment was the only thing holding the invariant, and a 5000-line file is where that fails.
 *
 * The behavioural half of this guard lives in `agentManager.test.ts`, where the fake tmux captures the
 * real `-e KEY=VALUE` arguments for spawn, respawn and the replacement `new-session`. Asserting on
 * observed tmux args is what actually covers a path; these tests cover the merge contract itself.
 */
describe("t-e73e54 — post-cut attestation merge contract", () => {
  it("merges the attestation last so a caller cannot forge or clear it", () => {
    const forged = withPostCutAttestation({
      TACHYON_AGENT_NAME: "ada",
      [POST_CUT_SESSION_ATTESTATION_ENV]: "agent-instance-v4-forged",
    });

    expect(forged[POST_CUT_SESSION_ATTESTATION_ENV]).toBe(POST_CUT_SESSION_ATTESTATION);
    // Everything else the caller asked for still travels.
    expect(forged.TACHYON_AGENT_NAME).toBe("ada");
  });

  it("attests an absent env rather than producing one without the proof", () => {
    expect(withPostCutAttestation()).toEqual({
      [POST_CUT_SESSION_ATTESTATION_ENV]: POST_CUT_SESSION_ATTESTATION,
    });
  });

  it("does not mutate the caller's env object", () => {
    // The spawn door passes a freshly merged object, but the restart path hands over `opts.env`, which
    // belongs to its caller. Attesting by mutation would leak the proof into unrelated envs.
    const original = { TACHYON_AGENT_NAME: "ada" };

    withPostCutAttestation(original);

    expect(original).toEqual({ TACHYON_AGENT_NAME: "ada" });
  });
});
