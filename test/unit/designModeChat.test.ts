import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendDmChatEvent,
  designModeChatPath,
  extractDmChatReplyMarkers,
  formatDmChatPrompt,
  loadDmChatBefore,
  tailDmChat,
  DM_CHAT_REPLY_END,
  DM_CHAT_REPLY_START,
} from "../../src/webview/ide-browser-bridge/designModeChat.js";

describe("designModeChat JSONL store", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-chat-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("appends to a single workspace chat.jsonl with growing lineNo", () => {
    const a = appendDmChatEvent(root, {
      kind: "message",
      role: "user",
      text: "hello",
      activeAgent: "grok",
    });
    const b = appendDmChatEvent(root, {
      kind: "message",
      role: "agent",
      agent: "grok",
      text: "hi",
      activeAgent: "grok",
      source: "tool",
    });
    expect(a.lineNo).toBe(1);
    expect(b.lineNo).toBe(2);
    expect(fs.existsSync(designModeChatPath(root))).toBe(true);
    const tail = tailDmChat(root, 10);
    expect(tail.items).toHaveLength(2);
    expect(tail.hasMoreBefore).toBe(false);
  });

  it("tail and loadBefore support on-demand windows", () => {
    for (let i = 0; i < 25; i++) {
      appendDmChatEvent(root, {
        kind: "message",
        role: "user",
        text: `m${i}`,
        activeAgent: "grok",
      });
    }
    const tail = tailDmChat(root, 10);
    expect(tail.items).toHaveLength(10);
    expect(tail.hasMoreBefore).toBe(true);
    expect(tail.oldestLineNo).toBe(16);
    const older = loadDmChatBefore(root, tail.oldestLineNo!, 10);
    expect(older.items).toHaveLength(10);
    expect(older.hasMoreBefore).toBe(true);
    expect(older.items[0]!.lineNo).toBe(6);
    expect(older.items.every((e) => e.lineNo < 16)).toBe(true);
  });

  it("extracts marker replies but rejects instruction residue 'and'", () => {
    const pane = `noise\n${DM_CHAT_REPLY_START}\nplain answer\n${DM_CHAT_REPLY_END}\nmore`;
    expect(extractDmChatReplyMarkers(pane)).toBe("plain answer");
    expect(extractDmChatReplyMarkers("no markers")).toBeNull();
    // Historic bug: prompt said "between START and END" → extracted body "and".
    const instruction =
      `put the plain answer alone between ${DM_CHAT_REPLY_START} and ${DM_CHAT_REPLY_END}.`;
    expect(extractDmChatReplyMarkers(instruction)).toBeNull();
  });

  it("formatDmChatPrompt points at chat.jsonl instead of pasting history", () => {
    const p = formatDmChatPrompt({
      agent: "claude",
      text: "Qual url aberta?",
      pageUrl: "https://www.youtube.com/",
      workspaceRoot: root,
      recent: [
        { role: "user", text: "hi" },
        { role: "agent", agent: "claude", text: "A".repeat(5000) },
        { role: "user", text: "Qual url aberta?" },
      ],
    });
    expect(p).toContain("Human: Qual url aberta?");
    expect(p).toContain("Open page: https://www.youtube.com/");
    expect(p).toContain(designModeChatPath(root));
    expect(p).toMatch(/Chat log \(append-only JSONL/);
    expect(p).toMatch(/read\/tail that file with tools/i);
    expect(p).toMatch(/Required:.*design_mode_chat_reply/);
    expect(p).toMatch(/ONLY via Bridge tool design_mode_chat_reply/i);
    // Happy path is tool-only — do not advertise pane markers (agents skip the tool).
    expect(p).not.toContain(DM_CHAT_REPLY_START);
    expect(p).not.toContain(DM_CHAT_REPLY_END);
    expect(p).toMatch(/Do not wrap the answer in markers/i);
    // Prior turns / giant agent replies must not be re-injected.
    expect(p).not.toContain("Human: hi");
    expect(p).not.toContain("A".repeat(100));
    expect(p.match(/Qual url aberta\?/g)?.length).toBe(1);
  });

  it("formatDmChatPrompt can attach pick context for the unified chat channel", () => {
    const p = formatDmChatPrompt({
      agent: "codex",
      text: "increase padding",
      workspaceRoot: root,
      pickContext: "## Design Mode pick\n- Selector: `button#go`",
    });
    expect(p).toContain("page element is attached");
    expect(p).toContain("## Design Mode pick");
    expect(p).toContain("button#go");
    expect(p).toContain("Human: increase padding");
    expect(p).toMatch(/design_mode_chat_reply/);
  });
});
