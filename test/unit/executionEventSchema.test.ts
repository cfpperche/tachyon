import { describe, expect, it } from "vitest";
import {
  sealExecutionEvent,
  isExclusivelyOwned,
  MAX_DETAIL_VALUE_CHARS,
  MAX_DETAIL_KEYS,
  type RawExecutionEvent,
  type SealedExecutionEvent,
} from "../../src/executionGraph/eventSchema.js";

/**
 * SDD 480 Phase 2 slice 1 — the write boundary.
 *
 * The spec's two hard rules are enforced at this seam rather than trusted to emitters: attribution is
 * proven or `unproven` and never inferred (§2), and command/args/env are redacted BEFORE persistence
 * (§4.5). Both are the kind of rule that decays silently — a sanitizer nobody can observe failing,
 * and a provenance field nobody is forced to fill — so they get tests before they get callers.
 */

const raw = (over: Partial<RawExecutionEvent> = {}): RawExecutionEvent => ({
  kind: "spawn",
  node: "Process",
  state: "running",
  provenance: "measured",
  correlation: { agentId: "claude-opus5-2", executionId: "exec-01" },
  at: "2026-07-28T00:00:00.000Z",
  ...over,
});

describe("SDD 480 — execution event write boundary", () => {
  describe("secrets never reach a sealed event", () => {
    it("redacts a caller-declared secret out of the command line", () => {
      // The literal is deliberately NOT key-shaped: the repo's secret scanner is right to flag a
      // realistic one, and a fixture is not worth teaching it to ignore. `knownSecrets` redacts any
      // literal, so the path under test is identical.
      const sealed = sealExecutionEvent(raw({
        detail: { argv: "curl -H 'Authorization: Bearer FAKE-FIXTURE-VALUE-NOT-A-KEY' https://api.test" },
        knownSecrets: ["FAKE-FIXTURE-VALUE-NOT-A-KEY"],
      }));

      expect(sealed.detail.argv).not.toContain("FAKE-FIXTURE-VALUE-NOT-A-KEY");
      expect(sealed.detail.argv).toContain("[redacted]");
    });

    it("redacts a token-shaped env assignment the caller never declared", () => {
      const sealed = sealExecutionEvent(raw({
        detail: { env: "TACHYON_AGENT_BRIDGE_TOKEN=abc123secretvalue PATH=/usr/bin" },
      }));

      expect(sealed.detail.env).not.toContain("abc123secretvalue");
      expect(sealed.detail.env).toContain("PATH=/usr/bin");
    });

    it("redacts inside a nested value, not just a top-level string", () => {
      const sealed = sealExecutionEvent(raw({
        detail: { spawn: { cmd: "run", token: "FAKE-FIXTURE-VALUE-NOT-A-KEY" } },
        knownSecrets: ["FAKE-FIXTURE-VALUE-NOT-A-KEY"],
      }));

      expect(sealed.detail.spawn).not.toContain("FAKE-FIXTURE-VALUE-NOT-A-KEY");
    });

    it("redacts the KEY too — an emitter can leak in a key as easily as in a value", () => {
      const sealed = sealExecutionEvent(raw({
        detail: { "FAKE-FIXTURE-VALUE-NOT-A-KEY": "whatever" },
        knownSecrets: ["FAKE-FIXTURE-VALUE-NOT-A-KEY"],
      }));

      expect(Object.keys(sealed.detail).join(" ")).not.toContain("FAKE-FIXTURE-VALUE-NOT-A-KEY");
    });
  });

  describe("volume is bounded at the boundary, not later", () => {
    it("caps a runaway value", () => {
      const sealed = sealExecutionEvent(raw({ detail: { argv: "x".repeat(5_000) } }));

      expect(sealed.detail.argv.length).toBeLessThanOrEqual(MAX_DETAIL_VALUE_CHARS);
      expect(sealed.detail.argv.endsWith("…")).toBe(true);
    });

    it("caps the number of keys", () => {
      const detail = Object.fromEntries(Array.from({ length: MAX_DETAIL_KEYS + 20 }, (_, i) => [`k${i}`, "v"]));

      expect(Object.keys(sealExecutionEvent(raw({ detail })).detail).length).toBeLessThanOrEqual(MAX_DETAIL_KEYS);
    });

    it("flattens control characters instead of dropping the event", () => {
      const sealed = sealExecutionEvent(raw({ detail: { argv: "echo hi\nrm -rf /" } }));


      expect(sealed.detail.argv).not.toMatch(/[\u0000-\u001f]/);
      expect(sealed.detail.argv).toContain("echo hi");
    });
  });

  describe("an event that cannot be correlated is refused", () => {
    it.each([
      ["empty agentId", { agentId: "", executionId: "exec-01" }],
      ["empty executionId", { agentId: "a", executionId: "" }],
      ["agentId with a newline", { agentId: "a\nb", executionId: "exec-01" }],
    ])("rejects %s", (_label, correlation) => {
      expect(() => sealExecutionEvent(raw({ correlation }))).toThrow(/usable id/);
    });

    it("rejects a timestamp that is not a date", () => {
      expect(() => sealExecutionEvent(raw({ at: "yesterday" }))).toThrow(/timestamp/);
    });

    it("keeps optional correlation absent rather than empty", () => {
      const sealed = sealExecutionEvent(raw());

      expect(sealed.correlation).not.toHaveProperty("turnId");
      expect(sealed.correlation).not.toHaveProperty("toolCallId");
    });
  });

  describe("provenance and sharing are structural, not conventions", () => {
    it("carries provenance through unchanged — including unproven", () => {
      for (const provenance of ["measured", "declared", "unproven"] as const) {
        expect(sealExecutionEvent(raw({ provenance })).provenance).toBe(provenance);
      }
    });

    it("a resource two agents use is not exclusively owned by either", () => {
      const shared: SealedExecutionEvent[] = [
        sealExecutionEvent(raw({ correlation: { agentId: "alpha", executionId: "daemon-1" }, state: "shared" })),
        sealExecutionEvent(raw({ correlation: { agentId: "beta", executionId: "daemon-1" }, state: "shared" })),
      ];

      expect(isExclusivelyOwned(shared, "daemon-1")).toBe(false);
      expect(isExclusivelyOwned([shared[0]!], "daemon-1")).toBe(true);
    });

    it("an unproven claim never establishes ownership", () => {
      const events = [
        sealExecutionEvent(raw({ correlation: { agentId: "alpha", executionId: "p-1" }, state: "running" })),
        sealExecutionEvent(raw({
          correlation: { agentId: "beta", executionId: "p-1" },
          state: "unproven",
          provenance: "unproven",
        })),
      ];

      // beta's unproven claim must not make the process look shared, nor take it from alpha.
      expect(isExclusivelyOwned(events, "p-1")).toBe(true);
    });
  });
});
