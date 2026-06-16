import { describe, it, expect } from "vitest";
import { isAdhocItem } from "../../src/presentation/contextValue.js";

describe("isAdhocItem (contextValue ad-hoc detection)", () => {
  it("matches an ad-hoc agent whether or not trailing segments follow `-adhoc`", () => {
    // plain ad-hoc
    expect(isAdhocItem("agent-stopped-ai-adhoc")).toBe(true);
    expect(isAdhocItem("agent-running-ai-adhoc")).toBe(true);
    // ad-hoc WITH trailing segments — the regression: a stopped fork has a worktree, so `-adhoc` is
    // mid-string. endsWith("-adhoc") / /-adhoc$/ wrongly returned false → Delete hit the yml path.
    expect(isAdhocItem("agent-stopped-ai-adhoc-worktree")).toBe(true);
    expect(isAdhocItem("agent-stopped-ai-adhoc-worktree-verifiable")).toBe(true);
    expect(isAdhocItem("agent-running-ai-adhoc-forkable")).toBe(true);
    expect(isAdhocItem("agent-running-ai-adhoc-worktree-verifiable-forkable")).toBe(true);
  });

  it("does NOT match a declared agent (no -adhoc segment)", () => {
    expect(isAdhocItem("agent-stopped-ai")).toBe(false);
    expect(isAdhocItem("agent-running-ai-worktree")).toBe(false);
    expect(isAdhocItem("agent-running-ai-worktree-forkable")).toBe(false);
    expect(isAdhocItem("agent-crashed-ai")).toBe(false);
    expect(isAdhocItem(undefined)).toBe(false);
    expect(isAdhocItem("")).toBe(false);
  });
});
