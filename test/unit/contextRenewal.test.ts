import { describe, expect, it } from "vitest";
import { contextRenewalRequestRefusal } from "@tachyon/bridge/tools.js";

describe("renew_context governance (t-6f0377)", () => {
  const safe = {
    agent: "worker",
    mode: "compact" as const,
    composerOccupied: false,
    continuityExists: false,
  };

  it("allows cheap compaction without requiring a continuity brief", () => {
    expect(contextRenewalRequestRefusal(safe)).toBeUndefined();
  });

  it("refuses destructive fresh renewal without a continuity brief", () => {
    expect(contextRenewalRequestRefusal({ ...safe, mode: "fresh" })).toMatch(/no continuity brief exists/);
  });

  it("names each unsafe in-flight surface", () => {
    expect(contextRenewalRequestRefusal({ ...safe, composerOccupied: true })).toMatch(/composer contains a draft/);
    expect(contextRenewalRequestRefusal({ ...safe, pendingApprovalId: "a-123" })).toMatch(/approval 'a-123' is pending/);
    expect(contextRenewalRequestRefusal({ ...safe, attention: "needs-input" })).toMatch(/attention state is 'needs-input'/);
  });
});
