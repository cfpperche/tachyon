import { describe, it, expect } from "vitest";
import {
  ROLES,
  isRole,
  roleTemplate,
  composeInstructions,
  bridgeGuidanceTail,
  withBridgeGuidance,
  roleReminder,
  buildRoleDoc,
} from "../../src/roles/templates.js";

// Identity / persona language we must NOT ship in a task contract (context-engineering, not role-play).
const PERSONA_RE = /\b(you are an? (?:senior|expert|brilliant|10x|world-class)|act as|pretend|persona)\b/i;

describe("role templates (spec 216)", () => {
  describe("isRole", () => {
    it("accepts known roles, rejects others", () => {
      for (const r of ROLES) expect(isRole(r)).toBe(true);
      expect(isRole("architect")).toBe(false);
      expect(isRole("")).toBe(false);
    });
  });

  describe("roleTemplate", () => {
    it("each preset is a non-empty task contract with no persona language", () => {
      for (const r of ["coder", "reviewer", "tester", "orchestrator"] as const) {
        const t = roleTemplate(r);
        expect(t.length).toBeGreaterThan(40);
        expect(t).not.toMatch(PERSONA_RE);
        expect(t.toLowerCase()).toContain("task");
      }
    });
    it("custom returns a Studio placeholder (not delivered)", () => {
      expect(roleTemplate("custom").toLowerCase()).toContain("describe this agent");
    });
  });

  describe("composeInstructions — template then instructions (D-D: compose at delivery)", () => {
    it("role only → template", () => {
      expect(composeInstructions("reviewer", undefined)).toBe(roleTemplate("reviewer"));
      expect(composeInstructions("coder", "   ")).toBe(roleTemplate("coder"));
    });
    it("role + instructions → template, blank line, instructions", () => {
      const out = composeInstructions("coder", "Focus on the parser.");
      expect(out).toBe(`${roleTemplate("coder")}\n\nFocus on the parser.`);
    });
    it("no role → instructions unchanged (today's behavior)", () => {
      expect(composeInstructions(undefined, "do X")).toBe("do X");
      expect(composeInstructions(undefined, undefined)).toBeUndefined();
    });
    it("custom → just the instructions, never the placeholder", () => {
      expect(composeInstructions("custom", "my contract")).toBe("my contract");
      expect(composeInstructions("custom", undefined)).toBeUndefined();
    });
  });

  describe("bridge guidance (Part B)", () => {
    it("tail mentions the Bridge and the native-subagent caveat", () => {
      const t = bridgeGuidanceTail();
      expect(t).toMatch(/Bridge/);
      expect(t).toMatch(/Task\/Explore/);
    });
    it("appends to a body when enabled, passthrough when disabled", () => {
      expect(withBridgeGuidance("hi", false)).toBe("hi");
      expect(withBridgeGuidance("hi", true)).toBe(`hi\n\n${bridgeGuidanceTail()}`);
    });
    it("guidance-only when there is no body", () => {
      expect(withBridgeGuidance(undefined, true)).toBe(bridgeGuidanceTail());
      expect(withBridgeGuidance("  ", true)).toBe(bridgeGuidanceTail());
    });
  });

  describe("roleReminder (Part C) — compact, points at the role doc", () => {
    it("names the role and references the given doc path", () => {
      expect(roleReminder("reviewer", ".tachyon/roles/rev.md")).toMatch(/reviewer/);
      expect(roleReminder("reviewer", ".tachyon/roles/rev.md")).toMatch(/cat \.tachyon\/roles\/rev\.md/);
      expect(roleReminder(undefined, ".tachyon/roles/x.md")).toMatch(/your assigned agent/);
    });
  });

  describe("buildRoleDoc (Part C)", () => {
    it("embeds the role, the composed contract, and a recover hint", () => {
      const doc = buildRoleDoc("rev", "reviewer", "focus on the parser");
      expect(doc).toMatch(/# Tachyon role — rev/);
      expect(doc).toMatch(/Role: reviewer/);
      expect(doc).toMatch(/review for quality/); // template
      expect(doc).toMatch(/focus on the parser/); // instructions
      expect(doc).toMatch(/compaction/i);
    });
    it("handles a roleless agent with only instructions", () => {
      expect(buildRoleDoc("x", undefined, "do the thing")).toMatch(/do the thing/);
      expect(buildRoleDoc("x", "custom", undefined)).toMatch(/no task contract/);
    });
  });
});
