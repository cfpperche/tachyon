import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendDmChatEvent,
  designModeChatPath,
  extractDmChatReplyMarkers,
  formatDmChatPrompt,
  inspectDmChatFile,
  loadDmChatBefore,
  tailDmChat,
  DM_CHAT_MAX_BYTES,
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

  it("appends to a single workspace chat.jsonl with growing lineNo", async () => {
    const a = await appendDmChatEvent(root, {
      kind: "message",
      role: "user",
      text: "hello",
      activeAgent: "grok",
    });
    const b = await appendDmChatEvent(root, {
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

  it("tail and loadBefore support on-demand windows", async () => {
    for (let i = 0; i < 25; i++) {
      await appendDmChatEvent(root, {
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

  it("distinguishes missing, empty, ok, and corrupt chat files (t-9b2741)", async () => {
    expect(inspectDmChatFile(root).status).toBe("missing");

    const file = designModeChatPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, "", "utf8");
    expect(inspectDmChatFile(root)).toMatchObject({
      status: "empty",
      eventCount: 0,
      corruptLineCount: 0,
      physicalLines: 0,
    });

    fs.writeFileSync(file, "   \n\n", "utf8");
    expect(inspectDmChatFile(root).status).toBe("empty");

    await appendDmChatEvent(root, {
      kind: "message",
      role: "user",
      text: "ok",
      activeAgent: "grok",
    });
    expect(inspectDmChatFile(root)).toMatchObject({
      status: "ok",
      eventCount: 1,
      corruptLineCount: 0,
      physicalLines: 1,
    });

    fs.appendFileSync(file, "not-json\n{broken\n", "utf8");
    const corrupt = inspectDmChatFile(root);
    expect(corrupt.status).toBe("corrupt");
    expect(corrupt.eventCount).toBe(1);
    expect(corrupt.corruptLineCount).toBe(2);
    expect(corrupt.physicalLines).toBe(3);
    // Empty and corrupt are never the same status.
    expect(corrupt.status).not.toBe("empty");
  });

  it("refuses append past DM_CHAT_MAX_BYTES (t-9b2741)", async () => {
    const file = designModeChatPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Leave room for a small header so the next real append exceeds the cap.
    const pad = "x".repeat(DM_CHAT_MAX_BYTES - 32);
    fs.writeFileSync(file, `${pad}\n`, "utf8");
    await expect(
      appendDmChatEvent(root, {
        kind: "message",
        role: "user",
        text: "overflow",
        activeAgent: "grok",
      }),
    ).rejects.toThrow(/exceeds .* bytes/);
  });
});

describe("designModeChat concurrent writers (t-9b2741 C-07)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-chat-conc-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("assigns unique sequential lineNo under multi-process concurrent append", async () => {
    // Proves the production door: separate processes (multi-window) race read→append.
    // Observed RED before lock (unique.size 77 of 100); must stay green with sequencer.
    const repoRoot = process.cwd();
    const workerPath = path.join(root, "dm-chat-writer.ts");
    const modUrl = pathToFileURL(path.join(repoRoot, "src/webview/ide-browser-bridge/designModeChat.ts")).href;
    fs.writeFileSync(workerPath, `
      import { appendDmChatEvent } from ${JSON.stringify(modUrl)};
      const workspaceRoot = process.argv[2]!;
      const writer = process.argv[3]!;
      const count = Number(process.argv[4]!);
      for (let i = 0; i < count; i++) {
        await appendDmChatEvent(workspaceRoot, {
          kind: "message",
          role: "user",
          text: writer + "-" + i,
          activeAgent: "grok",
        });
      }
    `, "utf8");

    const workerCount = 4;
    const perWorker = 25;
    const viteNode = path.join(repoRoot, "node_modules", ".bin", "vite-node");
    await Promise.all(Array.from({ length: workerCount }, (_, i) => new Promise<void>((resolve, reject) => {
      const child = spawn(viteNode, ["--root", repoRoot, workerPath, root, `w${i}`, String(perWorker)], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`writer w${i} exited ${code}: ${stderr}`));
      });
    })));

    const file = designModeChatPath(root);
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(workerCount * perWorker);

    const storedLineNos = lines.map((l) => (JSON.parse(l) as { lineNo: number }).lineNo);
    const unique = new Set(storedLineNos);
    // No duplicates in the durable JSONL payload (not just after re-numbering on read).
    expect(unique.size).toBe(workerCount * perWorker);
    expect(Math.min(...storedLineNos)).toBe(1);
    expect(Math.max(...storedLineNos)).toBe(workerCount * perWorker);
    // Dense sequence: every k in 1..N appears exactly once.
    for (let k = 1; k <= workerCount * perWorker; k++) {
      expect(storedLineNos.filter((n) => n === k)).toHaveLength(1);
    }
  }, 60_000);
});
