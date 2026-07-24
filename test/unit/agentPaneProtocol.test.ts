import { describe, expect, it } from "vitest";
import { AGENT_PANE_READY, isAgentPaneToHost } from "../../src/webview/agent-pane/protocol.js";

describe("isAgentPaneToHost", () => {
  it("accepts ready, input, resize", () => {
    expect(isAgentPaneToHost({ type: AGENT_PANE_READY })).toBe(true);
    expect(isAgentPaneToHost({ type: "agent-pane/input", data: "x" })).toBe(true);
    expect(isAgentPaneToHost({ type: "agent-pane/resize", cols: 80, rows: 24 })).toBe(true);
  });

  it("accepts Slice 1 stage/submit/inject-template", () => {
    expect(isAgentPaneToHost({ type: "agent-pane/stage", text: "hi" })).toBe(true);
    expect(isAgentPaneToHost({ type: "agent-pane/submit", text: "hi\n" })).toBe(true);
    expect(isAgentPaneToHost({ type: "agent-pane/inject-template" })).toBe(true);
  });

  it("rejects malformed payloads", () => {
    expect(isAgentPaneToHost(null)).toBe(false);
    expect(isAgentPaneToHost({ type: "agent-pane/stage" })).toBe(false);
    expect(isAgentPaneToHost({ type: "agent-pane/resize", cols: 0, rows: 24 })).toBe(false);
    expect(isAgentPaneToHost({ type: "agent-pane/nope" })).toBe(false);
  });
});
