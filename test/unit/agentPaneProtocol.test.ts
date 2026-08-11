import { describe, expect, it } from "vitest";
import {
  AGENT_PANE_READY,
  isAgentPaneToHost,
  pinTitleFromSelection,
} from "../../src/webview/agent-pane/protocol.js";

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
    expect(isAgentPaneToHost({ type: "agent-pane/picker-result", requestId: "picker-1", selectedId: "review" })).toBe(true);
    expect(isAgentPaneToHost({ type: "agent-pane/picker-result", requestId: "picker-1" })).toBe(true);
    expect(isAgentPaneToHost({ type: "agent-pane/picker-result", selectedId: "review" })).toBe(false);
  });

  it("accepts Slice 2 pin-selection", () => {
    expect(isAgentPaneToHost({ type: "agent-pane/pin-selection", text: "picked" })).toBe(true);
    expect(isAgentPaneToHost({ type: "agent-pane/pin-selection" })).toBe(false);
  });

  it("rejects malformed payloads", () => {
    expect(isAgentPaneToHost(null)).toBe(false);
    expect(isAgentPaneToHost({ type: "agent-pane/stage" })).toBe(false);
    expect(isAgentPaneToHost({ type: "agent-pane/resize", cols: 0, rows: 24 })).toBe(false);
    expect(isAgentPaneToHost({ type: "agent-pane/nope" })).toBe(false);
  });
});

describe("pinTitleFromSelection", () => {
  it("prefixes agent and collapses whitespace", () => {
    expect(pinTitleFromSelection("  hello\n  world  ", "claude")).toBe("[claude] hello world");
  });

  it("truncates long selections", () => {
    const long = "x".repeat(200);
    const title = pinTitleFromSelection(long, "codex", 40);
    expect(title.startsWith("[codex] ")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(50);
  });

  it("returns empty for blank selection", () => {
    expect(pinTitleFromSelection("  \n\t ", "a")).toBe("");
  });
});
