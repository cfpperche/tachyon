import { describe, it, expect } from "vitest";
import {
  TmuxService,
  sessionName,
  agentFromSession,
  workspaceHash,
  parseTmuxVersion,
  doctor,
  isolatedArgs,
  utf8LocaleEnv,
  looksLikeStrandedSubmittedLine,
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

describe("isolatedArgs", () => {
  it("prepends -f /dev/null so the user's ~/.tmux.conf is never loaded", () => {
    expect(isolatedArgs(["-L", "tachyon", "new-session"])).toEqual(["-f", "/dev/null", "-L", "tachyon", "new-session"]);
  });
});

describe("utf8LocaleEnv (mojibake fix — force a UTF-8 locale only when none is declared)", () => {
  it("is a no-op when the env already declares UTF-8 (LANG, LC_CTYPE, or LC_ALL)", () => {
    expect(utf8LocaleEnv({ LANG: "en_US.UTF-8" })).toEqual({});
    expect(utf8LocaleEnv({ LC_CTYPE: "pt_BR.utf8" })).toEqual({});
    expect(utf8LocaleEnv({ LC_ALL: "C.UTF-8", LANG: "C" })).toEqual({}); // LC_ALL UTF-8 wins
  });

  it("forces C.UTF-8 on Linux when the env declares no UTF-8 locale", () => {
    expect(utf8LocaleEnv({}, "linux")).toEqual({ LANG: "C.UTF-8", LC_CTYPE: "C.UTF-8" });
    expect(utf8LocaleEnv({ LANG: "C" }, "linux")).toEqual({ LANG: "C.UTF-8", LC_CTYPE: "C.UTF-8" }); // non-UTF-8 LANG overridden
  });

  it("uses en_US.UTF-8 on macOS (no C.UTF-8 there)", () => {
    expect(utf8LocaleEnv({}, "darwin")).toEqual({ LANG: "en_US.UTF-8", LC_CTYPE: "en_US.UTF-8" });
  });
});

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
      "set-option", "-g", "mouse", "on", ";",
      "set-option", "-g", "focus-events", "on", ";",
      "set-option", "-g", "history-limit", "10000", ";",
      "set-option", "-g", "remain-on-exit", "on", ";",
      // spec 219 — no clipboard helper set → idempotent unwind to the OSC 52 default + tmux's true
      // default copy bind (copy-pipe-and-cancel with no command, the 3.6 built-in)
      "set-option", "-gu", "set-clipboard", ";",
      "bind-key", "-T", "copy-mode", "MouseDragEnd1Pane", "send-keys", "-X", "copy-pipe-and-cancel", ";",
      "bind-key", "-T", "copy-mode-vi", "MouseDragEnd1Pane", "send-keys", "-X", "copy-pipe-and-cancel", ";",
      "new-session", "-d", "-s", "tachyon-x-dev",
      "-c", "/repo",
      "-e", "PORT=3000",
      "-e", "MODE=dev",
      "npm run dev",
    ]);
  });

  it("applyLiveOptions re-asserts options on a LIVE server without a new-session (spec 220 219-followup)", async () => {
    const { calls, exec } = recordingExecutor(); // default: list-sessions succeeds → server alive
    const tmux = new TmuxService(exec);
    await tmux.applyLiveOptions();
    const start = calls.find((c) => c.includes("start-server"));
    expect(start).toBeDefined();
    expect(start).toContain("set-clipboard"); // the clipboard chain is applied
    expect(start).not.toContain("new-session"); // but NO session is created
  });

  it("applyLiveOptions is a no-op when no server is running (never spins up a phantom server)", async () => {
    const { calls, exec } = recordingExecutor({ "list-sessions": new Error("no server running") });
    const tmux = new TmuxService(exec);
    await tmux.applyLiveOptions();
    expect(calls.some((c) => c.includes("start-server"))).toBe(false); // only the probing list-sessions ran
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
    await tmux.sendKey("s1", "C-d");
    expect(calls[0]).toContain("=s1"); // session target
    expect(calls[1]).toContain("=s1:"); // pane target (trailing colon)
    expect(calls[2]).toContain("=s1:");
    expect(calls[4]).toContain("=s1:");
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

  it("sendKey sends a tmux key token without literal mode", async () => {
    const { calls, exec } = recordingExecutor();
    const tmux = new TmuxService(exec);
    await tmux.sendKey("s1", "C-d");
    expect(calls[0]).toEqual(["-L", "tachyon", "send-keys", "-t", "=s1:", "C-d"]);
  });

  it("sendSubmittedLine retries Enter only when the line still looks stranded", async () => {
    const { calls, exec } = recordingExecutor({ "capture-pane": { stdout: "❯ [tachyon] a → b: done\n", stderr: "" } });
    const tmux = new TmuxService(exec);
    await tmux.sendSubmittedLine("s1", "[tachyon] a → b: done", { delayMs: 0 });
    expect(calls).toEqual([
      ["-L", "tachyon", "send-keys", "-t", "=s1:", "-l", "--", "[tachyon] a → b: done"],
      ["-L", "tachyon", "send-keys", "-t", "=s1:", "C-m"],
      ["-L", "tachyon", "capture-pane", "-p", "-t", "=s1:"],
      ["-L", "tachyon", "send-keys", "-t", "=s1:", "C-m"],
    ]);
  });

  it("sendSubmittedLine does not blind-retry when the line is only in history", async () => {
    const { calls, exec } = recordingExecutor({ "capture-pane": { stdout: "[tachyon] a → b: done\nassistant response\n", stderr: "" } });
    const tmux = new TmuxService(exec);
    await tmux.sendSubmittedLine("s1", "[tachyon] a → b: done", { delayMs: 0 });
    expect(calls.filter((c) => c.at(-1) === "C-m")).toHaveLength(1);
  });

  it("detects stranded submitted lines only at the bottom of the pane", () => {
    expect(looksLikeStrandedSubmittedLine("old\n> notice", "notice")).toBe(true);
    expect(looksLikeStrandedSubmittedLine("notice\nnew output", "notice")).toBe(false);
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

describe("wedged-server detection (zombie: holds the socket, fails every command)", async () => {
  const { probeServer, findServerPids, recoverWedgedServer, socketPath } = await import("../../src/tmux/TmuxService.js");
  const noSleep = async () => {};

  it("healthy when list-sessions answers", async () => {
    const probe = await probeServer({ exec: async () => ({ stdout: "a\n", stderr: "" }), sleep: noSleep });
    expect(probe).toEqual({ state: "healthy" });
  });

  it("no-server on the normal not-running errors (no retries burned)", async () => {
    let calls = 0;
    const probe = await probeServer({
      exec: async () => {
        calls++;
        throw new Error("no server running on /tmp/tmux-1000/tachyon");
      },
      sleep: noSleep,
    });
    expect(probe).toEqual({ state: "no-server" });
    expect(calls).toBe(1);
  });

  it("wedged when every attempt dies mid-handshake AND the socket file is still there", async () => {
    const probe = await probeServer({
      exec: async () => {
        throw new Error("server exited unexpectedly");
      },
      socketExists: () => true,
      findPids: async () => [4242],
      sleep: noSleep,
    });
    expect(probe).toEqual({ state: "wedged", pids: [4242] });
  });

  it("NOT wedged when the socket vanished (server died for real between checks)", async () => {
    const probe = await probeServer({
      exec: async () => {
        throw new Error("server exited unexpectedly");
      },
      socketExists: () => false,
      sleep: noSleep,
    });
    expect(probe).toEqual({ state: "no-server" });
  });

  it("a single transient failure followed by success is healthy", async () => {
    let calls = 0;
    const probe = await probeServer({
      exec: async () => {
        if (++calls === 1) throw new Error("lost server");
        return { stdout: "", stderr: "" };
      },
      socketExists: () => true,
      sleep: noSleep,
    });
    expect(probe).toEqual({ state: "healthy" });
  });

  it("findServerPids matches only exact `-L <socket>` tmux processes", async () => {
    const ps = [
      " 297325 tmux -f /dev/null -L tachyon new-session -d -s tachyon-ctl-x tail -f /dev/null",
      " 319101 /usr/bin/tmux -L tachyon attach-session -d -t =tachyon-x-claude",
      "   1000 tmux -L tachyonfoo list-sessions", // other socket
      "   1001 vim tmux -L tachyon",              // not a tmux binary
      "   1002 tmux -L other attach",
    ].join("\n");
    expect(await findServerPids("tachyon", async () => ps)).toEqual([297325, 319101]);
  });

  it("recoverWedgedServer kills every pid then removes the socket", async () => {
    const events: string[] = [];
    await recoverWedgedServer({
      pids: [11, 22],
      kill: (pid) => events.push(`kill:${pid}`),
      removeSocket: () => events.push("rm"),
      sleep: noSleep,
    });
    expect(events).toEqual(["kill:11", "kill:22", "rm"]);
  });

  it("socketPath honors TMUX_TMPDIR and falls back to /tmp", () => {
    expect(socketPath("tachyon", { TMUX_TMPDIR: "/x/y/" }, 1000)).toBe("/x/y/tmux-1000/tachyon");
    expect(socketPath("tachyon", {}, 1000)).toBe("/tmp/tmux-1000/tachyon");
  });

  it("snapshotServerPids returns the ps text, empty for no pids, '' on failure (spec 217)", async () => {
    const { snapshotServerPids } = await import("../../src/tmux/TmuxService.js");
    expect(await snapshotServerPids([])).toBe("");
    let gotPids: number[] = [];
    expect(await snapshotServerPids([7, 9], async (p) => { gotPids = p; return "  PID %CPU\n7 99.0\n"; })).toContain("99.0");
    expect(gotPids).toEqual([7, 9]);
    expect(await snapshotServerPids([7], async () => { throw new Error("ps blew up"); })).toBe("");
  });
});

describe("renameSession", () => {
  it("renames with exact-match targeting", async () => {
    const { TmuxService: T } = await import("../../src/tmux/TmuxService.js");
    const calls: string[][] = [];
    const tmux = new T(async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    await tmux.renameSession("tachyon-x-old", "tachyon-x-new");
    expect(calls[0]).toEqual(["-L", "tachyon", "rename-session", "-t", "=tachyon-x-old", "tachyon-x-new"]);
  });
});

describe("server options (settings.tmux overlay over Tachyon defaults)", () => {
  it("new-session asserts Tachyon defaults + reserved remain-on-exit, then creates", async () => {
    const { calls, exec } = recordingExecutor();
    const tmux = new TmuxService(exec);
    await tmux.newSession({ name: "tachyon-x-a", cmd: "sh" });
    const flat = calls[0].join(" ");
    expect(flat).toContain("set-option -g mouse on");
    expect(flat).toContain("set-option -g focus-events on");
    expect(flat).toContain("set-option -g history-limit 10000");
    expect(flat).toContain("set-option -g remain-on-exit on"); // reserved, always present
    expect(flat).toContain("new-session -d -s tachyon-x-a sh");
  });

  it("setServerOptions: user overlay overrides a default; reserved still wins", async () => {
    const { calls, exec } = recordingExecutor();
    const tmux = new TmuxService(exec);
    tmux.setServerOptions({ mouse: "off", "history-limit": "50000", "mode-keys": "vi" });
    await tmux.newSession({ name: "tachyon-x-a", cmd: "sh" });
    const flat = calls[0].join(" ");
    expect(flat).toContain("set-option -g mouse off"); // user override beat the default "on"
    expect(flat).toContain("set-option -g history-limit 50000");
    expect(flat).toContain("set-option -g mode-keys vi"); // user addition
    expect(flat).toContain("set-option -g remain-on-exit on"); // reserved survives the overlay
  });

  it("a user cannot disable remain-on-exit via setServerOptions", async () => {
    const { calls, exec } = recordingExecutor();
    const tmux = new TmuxService(exec);
    tmux.setServerOptions({ "remain-on-exit": "off" }); // (parse layer rejects this; defense in depth here)
    await tmux.newSession({ name: "tachyon-x-a", cmd: "sh" });
    expect(calls[0].join(" ")).toContain("set-option -g remain-on-exit on");
  });
});

describe("clean clipboard wiring (spec 219)", () => {
  it("with a helper set: disables OSC 52 + binds copy-mode drag-end to pipe through it", async () => {
    const { calls, exec } = recordingExecutor();
    const tmux = new TmuxService(exec);
    tmux.setClipboardHelper("/ext path/media/clipboard-copy.sh");
    await tmux.newSession({ name: "tachyon-x-a", cmd: "sh" });
    const flat = calls[0].join(" ");
    expect(flat).toContain("set-option -g set-clipboard off");
    expect(flat).toContain("bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel sh '/ext path/media/clipboard-copy.sh'");
    expect(flat).toContain("bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel sh '/ext path/media/clipboard-copy.sh'");
  });

  it("POSIX-escapes a single quote in the helper path (codex r1 m3)", async () => {
    const { calls, exec } = recordingExecutor();
    const tmux = new TmuxService(exec);
    tmux.setClipboardHelper("/home/o'connor/clip.sh");
    await tmux.newSession({ name: "tachyon-x-a", cmd: "sh" });
    expect(calls[0].join(" ")).toContain("sh '/home/o'\\''connor/clip.sh'");
  });

  it("no helper (opted out / no tool): UNWINDS to OSC 52 default + default copy bind, idempotently (codex r3)", async () => {
    const { calls, exec } = recordingExecutor();
    const tmux = new TmuxService(exec);
    // null regardless of prior state (process-local memory is unreliable across a VS Code reload — the
    // -L tachyon server outlives the extension host — so the unwind is unconditional + idempotent).
    await tmux.newSession({ name: "tachyon-x-a", cmd: "sh" });
    const flat = calls[0].join(" ");
    expect(flat).toContain("set-option -gu set-clipboard"); // unset → back to default external (OSC 52)
    // rebinds to tmux's TRUE 3.6 default: copy-pipe-and-cancel with NO command (codex r4)
    expect(flat).toContain("bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel ;");
    expect(flat).toContain("bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel ;");
    expect(flat).not.toContain("copy-pipe-and-cancel sh"); // NOT the helper pipe
    expect(flat).not.toContain("copy-selection-and-cancel"); // not the wrong default
  });

  it("unwind respects a user-pinned set-clipboard (settings.tmux) → does NOT -gu unset it", async () => {
    const { calls, exec } = recordingExecutor();
    const tmux = new TmuxService(exec);
    tmux.setServerOptions({ "set-clipboard": "on" });
    await tmux.newSession({ name: "tachyon-x-a", cmd: "sh" });
    const flat = calls[0].join(" ");
    expect(flat).toContain("set-option -g set-clipboard on"); // the user's value, applied in the options loop
    expect(flat).not.toContain("set-option -gu set-clipboard"); // reset skipped it
  });
});
