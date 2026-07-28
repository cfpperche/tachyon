import { describe, expect, it } from "vitest";
import {
  mintExecution,
  readCarriedExecution,
  attributionFor,
  EXECUTION_ID_ENV,
  EXECUTION_AGENT_ENV,
} from "../../src/executionGraph/executionIdentity.js";
import { sealExecutionEvent } from "../../src/executionGraph/eventSchema.js";

/**
 * SDD 480 Phase 2 slice 2 — identity minted before the child exists.
 *
 * The measured case this defends: `t-41f496` found 73 processes reparented to `systemd --user` after
 * their launcher died. PPID said they belonged to systemd. An id the process was born holding says
 * otherwise, and keeps saying it after the parent is gone.
 *
 * The other half is the fail-closed rule. A seam that cannot carry env does not get to fall back on
 * "the PPID looked right" — it gets `unproven`, and `unproven` is a useful answer.
 */

let counter = 0;
const newId = () => `fixed-${++counter}`;

describe("SDD 480 — execution identity", () => {
  describe("minting happens before the child, and the child carries it", () => {
    it("hands the child both the execution and the agent it belongs to", () => {
      const minted = mintExecution({ agentId: "claude-opus5-2", carrier: "carried", newId });

      expect(minted.env[EXECUTION_ID_ENV]).toBe(minted.executionId);
      expect(minted.env[EXECUTION_AGENT_ENV]).toBe("claude-opus5-2");
      expect(minted.provenance).toBe("measured");
    });

    it("mints a distinct id per execution", () => {
      const a = mintExecution({ agentId: "x", carrier: "carried", newId });
      const b = mintExecution({ agentId: "x", carrier: "carried", newId });

      expect(a.executionId).not.toBe(b.executionId);
    });

    it("carries the full correlation through, omitting what was not supplied", () => {
      const minted = mintExecution({
        agentId: "x", sessionId: "s-1", turnId: "t-1", toolCallId: "tc-1", carrier: "carried", newId,
      });

      expect(minted.correlation).toMatchObject({ agentId: "x", sessionId: "s-1", turnId: "t-1", toolCallId: "tc-1" });
      expect(mintExecution({ agentId: "x", carrier: "carried", newId }).correlation).not.toHaveProperty("turnId");
    });

    it("produces a correlation the write boundary already accepts", () => {
      const minted = mintExecution({ agentId: "claude-opus5-2", carrier: "carried", newId });

      // The two slices must agree: an id minted here has to survive sealing there.
      expect(() => sealExecutionEvent({
        kind: "spawn", node: "Process", state: "running",
        provenance: minted.provenance, correlation: minted.correlation,
        at: "2026-07-28T00:00:00.000Z",
      })).not.toThrow();
    });
  });

  describe("a seam that cannot carry env says so", () => {
    it("mints no env and reports unproven", () => {
      const minted = mintExecution({ agentId: "x", carrier: "absent", newId });

      expect(minted.env).toEqual({});
      expect(minted.provenance).toBe("unproven");
      // It still gets an id — the execution happened, and is worth recording as unattributable.
      expect(minted.executionId).toBeTruthy();
    });
  });

  describe("reading identity back off a running process", () => {
    it("reads what was carried", () => {
      expect(readCarriedExecution({ [EXECUTION_ID_ENV]: "exec-1", [EXECUTION_AGENT_ENV]: "alpha" }))
        .toEqual({ executionId: "exec-1", agentId: "alpha" });
    });

    it.each([
      ["nothing carried", {}],
      ["only the execution", { [EXECUTION_ID_ENV]: "exec-1" }],
      ["only the agent", { [EXECUTION_AGENT_ENV]: "alpha" }],
      ["blank values", { [EXECUTION_ID_ENV]: "  ", [EXECUTION_AGENT_ENV]: "  " }],
    ])("returns undefined for %s — an answer, not a failure", (_label, env) => {
      expect(readCarriedExecution(env)).toBeUndefined();
    });
  });

  describe("attribution is fail-closed", () => {
    const expected = { executionId: "exec-1", agentId: "alpha" };

    it("is measured only when the process carries exactly what we minted", () => {
      expect(attributionFor(expected, { [EXECUTION_ID_ENV]: "exec-1", [EXECUTION_AGENT_ENV]: "alpha" }))
        .toBe("measured");
    });

    it("stays unproven for a reparented process that carries nothing — the t-41f496 case", () => {
      // This is the shape of the 73 orphans: alive, reparented, no way to prove whose it was.
      expect(attributionFor(expected, {})).toBe("unproven");
    });

    it("stays unproven when the ids do not match, rather than preferring the expected one", () => {
      expect(attributionFor(expected, { [EXECUTION_ID_ENV]: "exec-2", [EXECUTION_AGENT_ENV]: "alpha" }))
        .toBe("unproven");
    });

    it("stays unproven when the agent differs — a shared daemon is not quietly claimed", () => {
      expect(attributionFor(expected, { [EXECUTION_ID_ENV]: "exec-1", [EXECUTION_AGENT_ENV]: "beta" }))
        .toBe("unproven");
    });
  });
});
