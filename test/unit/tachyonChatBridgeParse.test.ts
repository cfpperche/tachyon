import { describe, expect, it } from "vitest";
import {
  formatAgentListMarkdown,
  parseTachyonChat,
} from "../../src/webview/chat-bridge/parse.js";
import { normalizeAgentRows, preferredRunnableAgents } from "../../src/webview/chat-bridge/ops.js";

describe("parseTachyonChat", () => {
  it("parses /list and bare list", () => {
    expect(parseTachyonChat("", "list").kind).toBe("list");
    expect(parseTachyonChat("list").kind).toBe("list");
    expect(parseTachyonChat("list agents").kind).toBe("list");
  });

  it("parses /send agent message", () => {
    const p = parseTachyonChat("grok fix the button", "send");
    expect(p).toEqual({ kind: "send", agent: "grok", text: "fix the button" });
  });

  it("parses free-form agent: message", () => {
    const p = parseTachyonChat("claude: run tests please");
    expect(p).toEqual({ kind: "send", agent: "claude", text: "run tests please" });
  });

  it("parses to agent: message", () => {
    const p = parseTachyonChat("to solo: hi");
    expect(p).toEqual({ kind: "send", agent: "solo", text: "hi" });
  });

  it("returns help for empty", () => {
    expect(parseTachyonChat("").kind).toBe("help");
    expect(parseTachyonChat("help").kind).toBe("help");
  });

  it("ambiguous without agent", () => {
    const p = parseTachyonChat("just some text without agent");
    expect(p.kind).toBe("ambiguous");
  });
});

describe("normalizeAgentRows", () => {
  it("filters invalid rows", () => {
    const rows = normalizeAgentRows([
      { name: "grok", running: true, kind: "agent", lifetime: "saved" },
      { name: "" },
      null,
      { running: true },
    ]);
    expect(rows).toEqual([{ name: "grok", running: true, kind: "agent", lifetime: "saved" }]);
  });

  it("prefers non-terminal agents", () => {
    const preferred = preferredRunnableAgents([
      { name: "sh", kind: "terminal" },
      { name: "grok", kind: "agent" },
    ]);
    expect(preferred.map((a) => a.name)).toEqual(["grok"]);
  });
});

describe("formatAgentListMarkdown", () => {
  it("includes agent names", () => {
    const md = formatAgentListMarkdown(
      [{ name: "grok", running: false, kind: "agent", lifetime: "saved" }],
      "sample",
    );
    expect(md).toContain("grok");
    expect(md).toContain("sample");
  });
});
