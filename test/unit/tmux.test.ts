import { describe, it, expect } from "vitest";
import {
  TmuxService,
  sessionName,
  agentFromSession,
  workspaceHash,
  parseTmuxVersion,
  doctor,
  type ExecResult,
} from "../../src/tmux/TmuxService.js";

function recordingExecutor(results: Record<string, ExecResult | Error> = {}) {
  const calls: string[][] = [];
  const exec = async (args: string[]): Promise<ExecResult> => {
    calls.push(args);
    const key = args.join(" ");
    for (const [pattern, result] of Object.entries(results)) {
      if (key.includes(pattern)) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, exec };
}

describe("session naming", () => {
  it("builds and parses namespaced session names", () => {
    const hash = workspaceHash("/home/me/project");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    const session = sessionName(hash, "claude");
    expect(session).toBe(`tachyon-${hash}-claude`);
    expect(agentFromSession(hash, session)).toBe("claude");
  });

  it("is stable for the same path and distinct across paths", () => {
    expect(workspaceHash("/a")).toBe(workspaceHash("/a"));
    expect(workspaceHash("/a")).not.toBe(workspaceHash("/b"));
  });

  it("rejects sessions from other workspaces", () => {
    expect(agentFromSession("aaaaaaaa", "tachyon-bbbbbbbb-claude")).toBeNull();
    expect(agentFromSession("aaaaaaaa", "unrelated")).toBeNull();
  });
});

describe("parseTmuxVersion", () => {
  it("parses common version strings", () => {
    expect(parseTmuxVersion("tmux 3.6")).toBe(3.6);
    expect(parseTmuxVersion("tmux 3.2a")).toBe(3.2);
    expect(parseTmuxVersion("tmux next-3.4")).toBe(3.4);
  });
  it("returns null on garbage", () => {
    expect(parseTmuxVersion("no version here")).toBeNull();
  });
});

describe("doctor", () => {
  it("fails closed on native Windows with a WSL pointer", async () => {
    const result = await doctor({ platform: "win32", isWsl: false, tmuxVersion: async () => "tmux 3.6" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("native-windows");
      expect(result.message).toContain("WSL");
    }
  });

  it("fails with apt hint when tmux missing on WSL", async () => {
    const result = await doctor({ platform: "linux", isWsl: true, tmuxVersion: async () => null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("tmux-missing");
      expect(result.message).toContain("apt install tmux");
      expect(result.message).toContain("WSL");
    }
  });

  it("fails with brew hint on macOS", async () => {
    const result = await doctor({ platform: "darwin", isWsl: false, tmuxVersion: async () => null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("brew install tmux");
  });

  it("fails on too-old tmux", async () => {
    const result = await doctor({ platform: "linux", isWsl: false, tmuxVersion: async () => "tmux 2.9" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("tmux-too-old");
  });

  it("passes on modern tmux", async () => {
    const result = await doctor({ platform: "linux", isWsl: false, tmuxVersion: async () => "tmux 3.6" });
    expect(result.ok).toBe(true);
  });
});

describe("TmuxService argument construction", () => {
  it("prepends the dedicated socket to every call", async () => {
    const { calls, exec } = recordingExecutor();
    const tmux = new TmuxService(exec);
    await tmux.hasSession("tachyon-x-claude");
    expect(calls[0].slice(0, 2)).toEqual(["-L", "tachyon"]);
  });

  it("builds new-session with cwd, env (-e), exact command, and race-free remain-on-exit", async () => {
    const { calls, exec } = recordingExecutor();
    const tmux = new TmuxService(exec);
    await tmux.newSession({
      name: "tachyon-x-dev",
      cmd: "npm run dev",
      cwd: "/repo",
      env: { PORT: "3000", MODE: "dev" },
    });
    expect(calls[0]).toEqual([
      "-L", "tachyon",
      "start-server", ";",
      "set-option", "-g", "remain-on-exit", "on", ";",
      "new-session", "-d", "-s", "tachyon-x-dev",
      "-c", "/repo",
      "-e", "PORT=3000",
      "-e", "MODE=dev",
      "npm run dev",
    ]);
  });

  it("sessionStates parses alive and dead panes, filtered by prefix", async () => {
    const { exec } = recordingExecutor({
      "list-panes": { stdout: "tachyon-x-a\t0\t\ntachyon-x-b\t1\t7\nother\t1\t1\n", stderr: "" },
    });
    const tmux = new TmuxService(exec);
    const states = await tmux.sessionStates("tachyon-x-");
    expect(states.get("tachyon-x-a")).toEqual({ dead: false, exitCode: undefined });
    expect(states.get("tachyon-x-b")).toEqual({ dead: true, exitCode: 7 });
    expect(states.has("other")).toBe(false);

    const dead = recordingExecutor({ "list-panes": new Error("no server running") });
    expect((await new TmuxService(dead.exec).sessionStates("tachyon-")).size).toBe(0);
  });

  it("uses exact-match (=) targeting for kill/capture/send", async () => {
    const { calls, exec } = recordingExecutor();
    const tmux = new TmuxService(exec);
    await tmux.killSession("s1");
    await tmux.capturePane("s1");
    await tmux.sendKeys("s1", "hello", true);
    expect(calls[0]).toContain("=s1"); // session target
    expect(calls[1]).toContain("=s1:"); // pane target (trailing colon)
    expect(calls[2]).toContain("=s1:");
  });

  it("capturePane reaches scrollback only when lines is given", async () => {
    const { calls, exec } = recordingExecutor({ "capture-pane": { stdout: "out\n\n", stderr: "" } });
    const tmux = new TmuxService(exec);
    const visible = await tmux.capturePane("s1");
    expect(visible).toBe("out");
    expect(calls[0]).not.toContain("-S");
    await tmux.capturePane("s1", 500);
    expect(calls[1]).toContain("-S");
    expect(calls[1]).toContain("-500");
  });

  it("sendKeys sends literal text (-l) and Enter separately on submit", async () => {
    const { calls, exec } = recordingExecutor();
    const tmux = new TmuxService(exec);
    await tmux.sendKeys("s1", "-rf looks-like-flags", true);
    expect(calls[0]).toEqual(["-L", "tachyon", "send-keys", "-t", "=s1:", "-l", "--", "-rf looks-like-flags"]);
    expect(calls[1]).toEqual(["-L", "tachyon", "send-keys", "-t", "=s1:", "C-m"]);
  });

  it("sendKeys without submit sends no Enter", async () => {
    const { calls, exec } = recordingExecutor();
    const tmux = new TmuxService(exec);
    await tmux.sendKeys("s1", "draft", false);
    expect(calls).toHaveLength(1);
  });

  it("listSessions filters by prefix and tolerates a dead server", async () => {
    const ok = recordingExecutor({
      "list-sessions": { stdout: "tachyon-x-a\ntachyon-y-b\nother\n", stderr: "" },
    });
    const tmux = new TmuxService(ok.exec);
    expect(await tmux.listSessions("tachyon-x-")).toEqual(["tachyon-x-a"]);

    const dead = recordingExecutor({ "list-sessions": new Error("no server running") });
    const tmux2 = new TmuxService(dead.exec);
    expect(await tmux2.listSessions("tachyon-")).toEqual([]);
  });
});
