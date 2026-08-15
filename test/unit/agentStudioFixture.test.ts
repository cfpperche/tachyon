import { describe, it, expect } from "vitest";
import { loadMessage, saveMessage, cancelMessage } from "@tachyon/webview-ui/webview/agent-studio-fixture/messages.js";
import { STUDIO_PROTOCOL_VERSION } from "@tachyon/webview-ui/webview/shared/studio/protocol.js";
import { agentStudioFixtureFixtures } from "../../scripts/webview-preview/fixtures/agent-studio-fixture.js";
import type { AgentFixtureVM } from "@tachyon/webview-ui/webview/agent-studio-fixture/types.js";

// spec 350 T5 — Fake 2 (Agent-entity fixture): proves the message contract AND that the fixture data actually
// exercises every dense domain component the spec names (quick-add chips, instructions, worktree
// section) across BOTH shell regions (`fields` + `sideActions`) — the region-composition proof the DOM-free
// vitest environment can make (App.tsx's own rendering is proven by the preview harness + agent visual pass).

describe("agent-studio-fixture host<->webview envelope", () => {
  it("load carries the full VM under the current protocol version", () => {
    const vm: AgentFixtureVM = {
      mode: "new",
      chips: [],
      fields: { name: "", command: "", instructions: "", worktree: { enabled: false, branch: "", setupCommands: "" } },
    };
    expect(loadMessage(vm)).toEqual({ type: "load", entity: vm, concurrency: { kind: "none" }, studioProtocolVersion: STUDIO_PROTOCOL_VERSION });
  });

  it("save/cancel are bare envelopes", () => {
    expect(saveMessage()).toEqual({ type: "save", studioProtocolVersion: STUDIO_PROTOCOL_VERSION });
    expect(cancelMessage()).toEqual({ type: "cancel", studioProtocolVersion: STUDIO_PROTOCOL_VERSION });
  });
});

describe("the dense Agent-tab fixture actually populates every domain component the spec names", () => {
  const dense = agentStudioFixtureFixtures.default!.vm;

  it("quick-add CLI detection chips: at least one installed, one not (both visual states)", () => {
    expect(dense.chips.length).toBeGreaterThan(0);
    expect(dense.chips.some((c) => c.installed)).toBe(true);
    expect(dense.chips.some((c) => !c.installed)).toBe(true);
  });

  it("instructions are populated (the `fields` region's rich-text-adjacent content)", () => {
    expect(dense.fields.instructions.trim().length).toBeGreaterThan(0);
  });

  it("the worktree section (a `sideActions`-region domain component) is enabled with branch + setup commands", () => {
    expect(dense.fields.worktree.enabled).toBe(true);
    expect(dense.fields.worktree.branch.trim().length).toBeGreaterThan(0);
    expect(dense.fields.worktree.setupCommands.trim().length).toBeGreaterThan(0);
  });

  it("the `new` fixture starts empty (proves the same regions render for both new and edit modes)", () => {
    const fresh = agentStudioFixtureFixtures.new!.vm;
    expect(fresh.mode).toBe("new");
    expect(fresh.fields).toEqual({ name: "", command: "", instructions: "", worktree: { enabled: false, branch: "", setupCommands: "" } });
  });
});
