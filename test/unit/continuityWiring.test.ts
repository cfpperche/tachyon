import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind } from "../../src/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";

/**
 * spec 241 — headless validation of the continuity WIRING (not just the pure classifier): drive the real
 * Workspace public methods through `createForTest` + a fake tmux that CAPTURES send-keys, and assert the
 * read-brief → classify → inject-into-pane + state-transition side effects. This is as far as the dogfood
 * goes without a GUI / a real claude agent obeying the nudge.
 */

class FakeHost implements EngineHost {
  t = (m: string, ...a: (string | number | boolean)[]): string => m.replace(/\{(\d+)\}/g, (_x, i) => String(a[Number(i)] ?? ""));
  notify(_m: string, _l: NotifyLevel = "info", _act?: NoticeAction[]): void {}
  focusPrimaryView(): void {}
  watch(): { dispose(): void } {
    return { dispose() {} };
  }
  getSetting<T>(_s: string, _k: string, d: T): T {
    return d;
  }
  globalStoragePath(): string {
    return this.storageDir;
  }
  getState<T>(_k: string): T | undefined {
    return undefined;
  }
  setState(): void {}
  appVersion(): string {
    return "0.0.0-test";
  }
  mediaPath(...s: string[]): string {
    return path.join(this.storageDir, ...s);
  }
  webviewRoot(): unknown {
    return undefined;
  }
  onViewsChanged(_v: ViewKind): void {}
  constructor(private readonly storageDir: string) {}
}

/** fake tmux that records the literal text of every send-keys (the pane injections). */
function capturingTmux() {
  const sessions = new Set<string>();
  const sent: string[] = [];
  const exec = async (args: string[]): Promise<ExecResult> => {
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "has-session") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "");
      if (sessions.has(name)) return { stdout: "", stderr: "" };
      throw new Error("no session");
    }
    if (args[2] === "send-keys" && args.includes("-l")) sent.push(args[args.length - 1]); // the literal text payload (run() prefixes 2 args)
    return { stdout: "", stderr: "" };
  };
  return { sessions, sent, tmux: new TmuxService(exec) };
}

const dirs: string[] = [];
const mkdir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cont-wire-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function makeWs() {
  const root = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  claude:\n    cmd: claude\n", "utf8");
  const { tmux, sessions, sent } = capturingTmux();
  const ws = await Workspace.createForTest(root, { host: new FakeHost(mkdir()), onViewsChanged: () => {} }, { tmux, startBridge: false });
  await ws.manager.spawn("claude"); // populates the fake session so hasSession() is true
  return { ws, root, sessions, sent };
}

describe("continuity wiring (spec 241, headless via Workspace.createForTest)", () => {
  it("injectContinuity reads the brief → types the rebuild-context pointer → clears the discontinuity flag", async () => {
    const { ws, sent } = await makeWs();
    ws.continuityStore.write("claude", "# Current Goal\nship 241", { sourceActivitySeq: 0 });
    ws.continuityState.markDiscontinuity("claude", 5);
    await ws.injectContinuity("claude", "compaction-idle");
    expect(sent.some((s) => s.includes("Continuity available") && s.includes("cat .tachyon/continuity/claude.md"))).toBe(true);
    expect(ws.continuityState.read("claude").discontinuitySinceRestore).toBe(false); // restored
  });

  it("D3: a clean resume (no discontinuity) injects NOTHING; a post-compaction resume injects", async () => {
    const { ws, sent } = await makeWs();
    ws.continuityStore.write("claude", "# Current Goal\nx", {});
    await ws.injectContinuity("claude", "resume"); // no discontinuity flag → must stay silent
    expect(sent.length).toBe(0);
    ws.continuityState.markDiscontinuity("claude");
    await ws.injectContinuity("claude", "resume"); // now at-risk → injects
    expect(sent.some((s) => s.includes("Continuity available"))).toBe(true);
  });

  it("cold start (no brief) injects the create-first-brief nudge", async () => {
    const { ws, sent } = await makeWs();
    ws.continuityState.markDiscontinuity("claude");
    await ws.injectContinuity("claude", "compaction-idle");
    expect(sent.some((s) => s.includes("No continuity brief yet"))).toBe(true);
  });

  it("a malformed brief warns + does NOT clear the discontinuity (no lost restore)", async () => {
    const { ws, sent } = await makeWs();
    fs.mkdirSync(ws.continuityStore.dir, { recursive: true });
    fs.writeFileSync(ws.continuityStore.pathOf("claude"), "garbage no frontmatter", "utf8");
    ws.continuityState.markDiscontinuity("claude");
    await ws.injectContinuity("claude", "compaction-idle");
    expect(sent.some((s) => s.includes("malformed"))).toBe(true);
    expect(ws.continuityState.read("claude").discontinuitySinceRestore).toBe(true); // still outstanding
  });

  it("continuityBadge: missing → fresh after a write", async () => {
    const { ws } = await makeWs();
    expect(ws.continuityBadge("claude")).toBe("missing");
    ws.continuityStore.write("claude", "# Current Goal\nx", { sourceActivitySeq: 0 });
    expect(ws.continuityBadge("claude")).toBe("fresh");
  });

  it("snapshotContinuityForFork copies a paused snapshot with fork provenance + a re-scope note (D8)", async () => {
    const { ws } = await makeWs();
    ws.continuityStore.write("claude", "# Current Goal\nparent work", { sourceSessionId: "sess-1" });
    ws.snapshotContinuityForFork("claude", "claude-fork");
    const fork = ws.continuityStore.read("claude-fork")!;
    expect(fork.meta.status).toBe("paused");
    expect(fork.meta.forked_from_agent).toBe("claude");
    expect(fork.meta.forked_from_session_id).toBe("sess-1");
    expect(fork.body).toContain("Inherited from `claude`");
  });

  it("removeContinuity reaps the brief + state on delete", async () => {
    const { ws } = await makeWs();
    ws.continuityStore.write("claude", "# Current Goal\nx", {});
    ws.continuityState.markDiscontinuity("claude");
    ws.removeContinuity("claude");
    expect(ws.continuityStore.exists("claude")).toBe(false);
    expect(ws.continuityState.read("claude").discontinuitySinceRestore).toBe(false);
  });
});
