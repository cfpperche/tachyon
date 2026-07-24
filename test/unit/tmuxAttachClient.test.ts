import { describe, expect, it } from "vitest";
import { buildAttachShellCommand, shellSingleQuote } from "../../src/presentation/TmuxAttachClient.js";
import { isAgentPaneToHost, AGENT_PANE_READY } from "../../src/webview/agent-pane/protocol.js";

describe("buildAttachShellCommand", () => {
  it("builds exclusive attach with absolute socket", () => {
    const cmd = buildAttachShellCommand({
      socket: "/tmp/tmux-1000/tachyon",
      session: "tachyon-abc-agent",
      exclusive: true,
    });
    expect(cmd).toBe(
      "tmux -u -S '/tmp/tmux-1000/tachyon' attach-session -d -t '=tachyon-abc-agent'",
    );
  });

  it("omits -d when not exclusive", () => {
    const cmd = buildAttachShellCommand({
      socket: "/tmp/s",
      session: "s1",
      exclusive: false,
    });
    expect(cmd).toContain("attach-session -t");
    expect(cmd).not.toContain(" -d ");
  });

  it("shell-quotes sockets with spaces and quotes", () => {
    expect(shellSingleQuote("a'b")).toBe(`'a'\\''b'`);
    const cmd = buildAttachShellCommand({
      socket: "/tmp/weird'sock",
      session: "x",
      exclusive: true,
    });
    expect(cmd).toContain(`'/tmp/weird'\\''sock'`);
  });
});

describe("agent-pane protocol", () => {
  it("accepts ready and input messages", () => {
    expect(isAgentPaneToHost({ type: AGENT_PANE_READY })).toBe(true);
    expect(isAgentPaneToHost({ type: "agent-pane/input", data: "hi" })).toBe(true);
    expect(isAgentPaneToHost({ type: "agent-pane/resize", cols: 80, rows: 24 })).toBe(true);
  });

  it("rejects malformed messages", () => {
    expect(isAgentPaneToHost(null)).toBe(false);
    expect(isAgentPaneToHost({ type: "agent-pane/input" })).toBe(false);
    expect(isAgentPaneToHost({ type: "agent-pane/resize", cols: 0, rows: 24 })).toBe(false);
    expect(isAgentPaneToHost({ type: "other" })).toBe(false);
  });
});
