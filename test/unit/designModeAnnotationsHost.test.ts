import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { formatDesignAnnotationBatch, IdeBrowserBridgeManager } from "../../src/webview/ide-browser-bridge/manager.js";

// Exercise the production queue handler while replacing only its CDP delivery edge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ManagerHarness = any;

describe("Design Mode host annotation batch", () => {
  let root: string;
  let manager: ManagerHarness;
  let evaluateInPage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (vscode as unknown as { debug: unknown }).debug = {
      onDidTerminateDebugSession: () => ({ dispose() {} }),
      onDidStartDebugSession: () => ({ dispose() {} }),
      activeDebugSession: undefined,
      startDebugging: async () => false,
      stopDebugging: async () => {},
    };
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-annotations-host-"));
    manager = new IdeBrowserBridgeManager(root, { appendLine() {} } as unknown as vscode.OutputChannel);
    evaluateInPage = vi.fn(async () => undefined);
    manager.session.cdp.evaluateInPage = evaluateInPage;
  });

  afterEach(async () => {
    await manager.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("owns indexes, strips screenshots, syncs, and deletes", async () => {
    const capture = { target: { selector: "#cta", tag: "BUTTON" }, screenshot: "data:image/png;base64,large", screenshotPath: "/tmp/pick.png" };
    await manager.handleDesignPickRaw(JSON.stringify({ __annotation: "add", intent: "change", comment: "  Clarify this action  ", capture }));

    expect(manager.designAnnotations).toEqual([{ target: { selector: "#cta", tag: "BUTTON" }, index: 1, intent: "change", comment: "Clarify this action" }]);
    expect(evaluateInPage).toHaveBeenLastCalledWith(expect.stringContaining('"index":1'));
    expect(evaluateInPage).toHaveBeenLastCalledWith(expect.not.stringContaining("screenshot"));

    evaluateInPage.mockClear();
    await manager.handleDesignPickRaw(JSON.stringify({ __annotation: "sync" }));
    expect(evaluateInPage).toHaveBeenCalledOnce();

    await manager.handleDesignPickRaw(JSON.stringify({ __annotation: "delete", index: 1 }));
    expect(manager.designAnnotations).toEqual([]);
    expect(manager.nextDesignAnnotationIndex).toBe(2);
    expect(evaluateInPage).toHaveBeenLastCalledWith(expect.stringContaining("([])"));
  });

  function connect(agents: string[], sendAgentInput: ReturnType<typeof vi.fn> = vi.fn(async () => ({ status: "submitted" as const, reason: "composer-cleared" as const, attempts: 1 }))) {
    manager.session.cdp.state = "connected";
    manager.getWorkspace = () => ({
      extension: { query: async () => agents.map((name) => ({ name, kind: "agent", running: true, dead: false })) },
      activity: { sendAgentInput },
    });
    return sendAgentInput;
  }

  async function add(comment = "Fix the button") {
    await manager.handleDesignPickRaw(JSON.stringify({
      __annotation: "add", intent: "change", comment,
      capture: { page: { url: "https://example.test/page" }, target: { selector: "#cta", tag: "BUTTON", text: "Buy", bounds: { x: 1, y: 2, width: 0, height: 0 } } },
    }));
  }

  it("formats the whole batch as one Markdown prompt and clears only after a confirmed live-target receipt", async () => {
    const send = connect(["ada"]);
    await add("Increase contrast");
    await add("Clarify the label");

    await manager.handleDesignPickRaw(JSON.stringify({ action: "annotation.send", targetAgent: "ada" }));

    expect(send).toHaveBeenCalledOnce();
    const prompt = send.mock.calls[0]![1] as string;
    expect(prompt).toContain("## Design Feedback: https://example.test/page");
    expect(prompt).toContain("### 1. change: #cta");
    expect(prompt).toContain("Increase contrast");
    expect(prompt).toContain("### 2. change: #cta");
    expect(manager.designAnnotations).toEqual([]);
    expect(evaluateInPage).toHaveBeenCalledWith(expect.stringContaining('__tachyonDmApplySendState({"status":"sent"'));
  });

  it("preserves the batch when the selected destination became stale between roster and click", async () => {
    const send = connect(["new-agent"]);
    await add();
    await manager.handleDesignPickRaw(JSON.stringify({ action: "annotation.send", targetAgent: "gone-agent" }));
    expect(send).not.toHaveBeenCalled();
    expect(manager.designAnnotations).toHaveLength(1);
    expect(evaluateInPage).toHaveBeenCalledWith(expect.stringContaining("is no longer available"));
  });

  it("preserves the batch when the fresh composer guard refuses a human draft", async () => {
    const send = connect(["ada"], vi.fn(async () => { throw new Error("refused-composer: composer draft"); }));
    await add();
    await manager.handleDesignPickRaw(JSON.stringify({ action: "annotation.send", targetAgent: "ada" }));
    expect(send).toHaveBeenCalledOnce();
    expect(manager.designAnnotations).toHaveLength(1);
    expect(evaluateInPage).toHaveBeenCalledWith(expect.stringContaining("has a draft in the terminal"));
  });

  it("preserves the batch when sendSubmittedLine returns an unconfirmed receipt", async () => {
    connect(["ada"], vi.fn(async () => ({ status: "submit-unconfirmed" as const, reason: "composer still shows the line", attempts: 3 })));
    await add();
    await manager.handleDesignPickRaw(JSON.stringify({ action: "annotation.send", targetAgent: "ada" }));
    expect(manager.designAnnotations).toHaveLength(1);
    expect(evaluateInPage).toHaveBeenCalledWith(expect.stringContaining("was not confirmed"));
  });

  it("refreshes the host-owned roster so a newly started agent becomes selectable", async () => {
    const agents = ["ada"];
    manager.session.cdp.state = "connected";
    manager.getWorkspace = () => ({ extension: { query: async () => agents.map((name) => ({ name, kind: "agent", running: true, dead: false })) } });
    await manager.handleDesignPickRaw(JSON.stringify({ __annotation: "agents" }));
    expect(evaluateInPage).toHaveBeenLastCalledWith(expect.stringContaining('"agents":["ada"]'));
    agents.push("new-agent");
    await manager.handleDesignPickRaw(JSON.stringify({ __annotation: "agents" }));
    expect(evaluateInPage).toHaveBeenLastCalledWith(expect.stringContaining('"agents":["ada","new-agent"]'));
  });

  it("keeps screenshot paths in Markdown while allowing annotations without one", () => {
    expect(formatDesignAnnotationBatch([
      { index: 1, intent: "change", comment: "With image", screenshotPath: "/workspace/.tachyon/ide-browser-picks/pick.png", target: { selector: "#one" } },
      { index: 2, intent: "question", comment: "Without image", target: { selector: "#two" } },
    ])).toContain("Screenshot: /workspace/.tachyon/ide-browser-picks/pick.png");
  });

  it("materializes a PNG path for a valid crop and degrades to text when capture fails", async () => {
    manager.session.cdp.screenshotPngBase64 = vi.fn(async () => Buffer.from("png").toString("base64"));
    await manager.handleDesignPickRaw(JSON.stringify({ __annotation: "add", intent: "change", comment: "With crop", capture: { target: { selector: "#one", tag: "BUTTON", bounds: { x: 1, y: 2, width: 30, height: 20 } } } }));
    expect(manager.designAnnotations[0].screenshotPath).toMatch(/\.tachyon\/ide-browser-picks\/pick-.*\.png$/);
    expect(fs.existsSync(manager.designAnnotations[0].screenshotPath)).toBe(true);

    manager.session.cdp.screenshotPngBase64 = vi.fn(async () => { throw new Error("capture unavailable"); });
    await manager.handleDesignPickRaw(JSON.stringify({ __annotation: "add", intent: "question", comment: "Text still matters", capture: { target: { selector: "#two", tag: "DIV", bounds: { x: 1, y: 2, width: 30, height: 20 } } } }));
    expect(manager.designAnnotations[1]).toMatchObject({ comment: "Text still matters" });
    expect(manager.designAnnotations[1].screenshotPath).toBeUndefined();
  });

  it("serves preview bytes through sync and removes the PNG on Clear", async () => {
    manager.session.cdp.screenshotPngBase64 = vi.fn(async () => Buffer.from("png-preview").toString("base64"));
    await manager.handleDesignPickRaw(JSON.stringify({ __annotation: "add", intent: "change", comment: "Preview", capture: { target: { selector: "#one", tag: "BUTTON", bounds: { x: 1, y: 2, width: 30, height: 20 } } } }));
    const file = manager.designAnnotations[0].screenshotPath as string;
    expect(fs.existsSync(file)).toBe(true);
    expect(evaluateInPage).toHaveBeenLastCalledWith(expect.stringContaining("data:image/png;base64,"));
    await manager.handleDesignPickRaw(JSON.stringify({ action: "annotation.clear" }));
    expect(manager.designAnnotations).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps only the host as viewport backend and syncs the effective preset or error", async () => {
    manager.session.cdp.setResponsivePreset = vi.fn(async () => undefined);
    await manager.handleDesignPickRaw(JSON.stringify({ action: "viewport.set", preset: "phone" }));
    expect(manager.session.cdp.setResponsivePreset).toHaveBeenCalledWith("phone", expect.any(Function));
    expect(evaluateInPage).toHaveBeenLastCalledWith(expect.stringContaining('"preset":"phone","status":"success"'));
    manager.session.cdp.setResponsivePreset = vi.fn(async () => { throw new Error("CDP refused"); });
    await manager.handleDesignPickRaw(JSON.stringify({ action: "viewport.set", preset: "tablet" }));
    expect(evaluateInPage).toHaveBeenLastCalledWith(expect.stringContaining('"preset":"phone","status":"error","text":"CDP refused"'));
  });

  it("owns the frozen markup across sync and sends its composed PNG through the confirmed batch ladder", async () => {
    const send = connect(["ada"]);
    manager.session.cdp.screenshotPngBase64 = vi.fn(async () => Buffer.from("frozen-png").toString("base64"));
    await manager.handleDesignPickRaw(JSON.stringify({ action: "markup.capture" }));
    expect(manager.designMarkup).toMatchObject({ sourceUrl: expect.any(String), shapes: [] });
    expect(manager.designMarkup.frozen).toMatch(/^data:image\/png;base64,/);
    const shapes = [{ kind: "rect", from: { x: 0.1, y: 0.2 }, to: { x: 0.5, y: 0.6 } }];
    await manager.handleDesignPickRaw(JSON.stringify({ action: "markup.update", shapes }));
    evaluateInPage.mockClear();
    await manager.handleDesignPickRaw(JSON.stringify({ action: "markup.sync" }));
    expect(evaluateInPage).toHaveBeenCalledWith(expect.stringContaining('"kind":"rect"'));
    const composed = `data:image/png;base64,${Buffer.from("composed-png").toString("base64")}`;
    await manager.handleDesignPickRaw(JSON.stringify({ action: "markup.export", intent: "send", targetAgent: "ada", dataUrl: composed }));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]).toContain("Apply the viewport markup");
    expect(send.mock.calls[0]![1]).toContain("Screenshot:");
    expect(manager.designAnnotations).toEqual([]);
    expect(manager.designMarkup).toMatchObject({ shapes: [], status: "sent" });
  });

  it("preserves vectors when markup delivery is stale and bounds persisted Copy to one replaceable PNG", async () => {
    connect(["ada"]);
    manager.designMarkup = { frozen: "data:image/png;base64,AA==", sourceUrl: "https://before.test", shapes: [{ kind: "pen", points: [{ x: 0, y: 0 }] }] };
    const composed = `data:image/png;base64,${Buffer.from("copy-one").toString("base64")}`;
    await manager.handleDesignPickRaw(JSON.stringify({ action: "markup.export", intent: "copy", dataUrl: composed }));
    const first = manager.copiedMarkupPath;
    expect(fs.existsSync(first)).toBe(true);
    await manager.handleDesignPickRaw(JSON.stringify({ action: "markup.export", intent: "copy", dataUrl: composed }));
    expect(fs.existsSync(first)).toBe(false);
    await manager.handleDesignPickRaw(JSON.stringify({ action: "markup.export", intent: "send", targetAgent: "gone", dataUrl: composed }));
    expect(manager.designMarkup.shapes).toHaveLength(1);
    expect(manager.designMarkup.status).toBe("error");
    expect(manager.designAnnotations).toHaveLength(1);
    await manager.handleDesignPickRaw(JSON.stringify({ action: "markup.export", intent: "send", targetAgent: "gone", dataUrl: composed }));
    expect(manager.designAnnotations).toHaveLength(1);
  });
});
