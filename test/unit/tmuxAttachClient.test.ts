import { describe, expect, it, vi } from "vitest";
import {
  buildAttachArgv,
  buildAttachShellCommand,
  shellSingleQuote,
  TmuxAttachClient,
  type PtyProcess,
  type PtySpawn,
} from "../../src/presentation/TmuxAttachClient.js";
import { isAgentPaneToHost, AGENT_PANE_READY } from "../../src/webview/agent-pane/protocol.js";

describe("buildAttachArgv", () => {
  it("matches integrated-terminal attach shape (exclusive -d)", () => {
    const { file, args } = buildAttachArgv({
      socket: "/tmp/tmux-1000/tachyon",
      session: "tachyon-abc-agent",
      exclusive: true,
    });
    expect(file).toBe("tmux");
    expect(args).toEqual([
      "-u",
      "-S",
      "/tmp/tmux-1000/tachyon",
      "attach-session",
      "-d",
      "-t",
      "=tachyon-abc-agent",
    ]);
  });

  it("omits -d when not exclusive", () => {
    const { args } = buildAttachArgv({
      socket: "/tmp/s",
      session: "s1",
      exclusive: false,
    });
    expect(args).not.toContain("-d");
    expect(args).toContain("attach-session");
  });
});

describe("buildAttachShellCommand (legacy)", () => {
  it("still shell-quotes for documentation parity", () => {
    expect(shellSingleQuote("a'b")).toBe(`'a'\\''b'`);
    const cmd = buildAttachShellCommand({
      socket: "/tmp/tmux-1000/tachyon",
      session: "tachyon-abc-agent",
      exclusive: true,
    });
    expect(cmd).toContain("tmux");
    expect(cmd).toContain("attach-session");
    expect(cmd).toContain("-d");
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

describe("TmuxAttachClient (node-pty)", () => {
  function fakePtySpawn(capture: {
    file?: string;
    args?: string[];
    options?: { name?: string; cols?: number; rows?: number; env?: NodeJS.ProcessEnv };
  }): { spawn: PtySpawn; proc: PtyProcess & { _data?: (d: string) => void; _exit?: (e: { exitCode: number; signal?: number }) => void } } {
    const proc = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      _data: undefined as ((d: string) => void) | undefined,
      _exit: undefined as ((e: { exitCode: number; signal?: number }) => void) | undefined,
      onData(cb: (data: string) => void) {
        this._data = cb;
      },
      onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
        this._exit = cb;
      },
    };
    const spawn: PtySpawn = (file, args, options) => {
      capture.file = file;
      capture.args = args;
      capture.options = options;
      return proc;
    };
    return { spawn, proc };
  }

  it("spawns tmux attach via PTY with TERM=xterm-256color and correct geometry", () => {
    const capture: {
      file?: string;
      args?: string[];
      options?: { name?: string; cols?: number; rows?: number; env?: NodeJS.ProcessEnv };
    } = {};
    const { spawn } = fakePtySpawn(capture);
    const onData = vi.fn();
    const client = new TmuxAttachClient({ onData, onExit: () => {} });
    client.start({
      session: "tachyon-test",
      cols: 100,
      rows: 30,
      socket: "/tmp/tmux-1000/tachyon",
      exclusive: true,
      ptySpawn: spawn,
      env: { TERM: "dumb", PATH: "/usr/bin" },
    });
    expect(capture.file).toBe("tmux");
    expect(capture.args).toEqual([
      "-u",
      "-S",
      "/tmp/tmux-1000/tachyon",
      "attach-session",
      "-d",
      "-t",
      "=tachyon-test",
    ]);
    expect(capture.options?.name).toBe("xterm-256color");
    expect(capture.options?.cols).toBe(100);
    expect(capture.options?.rows).toBe(30);
    expect(capture.options?.env?.TERM).toBe("xterm-256color");
    expect(capture.options?.env?.COLORTERM).toBe("truecolor");
    client.dispose();
  });

  it("forwards PTY data and exit to handlers", () => {
    const capture: {
      file?: string;
      args?: string[];
      options?: { name?: string; cols?: number; rows?: number; env?: NodeJS.ProcessEnv };
    } = {};
    const { spawn, proc } = fakePtySpawn(capture);
    const onData = vi.fn();
    const onExit = vi.fn();
    const client = new TmuxAttachClient({ onData, onExit });
    client.start({
      session: "s",
      cols: 80,
      rows: 24,
      socket: "/tmp/s",
      ptySpawn: spawn,
    });
    proc._data?.("\x1b[Hhello");
    expect(onData).toHaveBeenCalledWith("\x1b[Hhello");
    // node-pty says signal 0 for "no signal". This is the shape of a clean detach — another client
    // attached with `-d` — and passing the 0 through made the pane announce "attach ended
    // (signal 0)", which reads as a kill when nothing was killed (t-feaaea).
    proc._exit?.({ exitCode: 0, signal: 0 });
    expect(onExit).toHaveBeenCalledWith(0, null);
    client.dispose();
  });

  it("still reports a real terminating signal", () => {
    const capture: {
      file?: string;
      args?: string[];
      options?: { name?: string; cols?: number; rows?: number; env?: NodeJS.ProcessEnv };
    } = {};
    const { spawn, proc } = fakePtySpawn(capture);
    const onExit = vi.fn();
    const client = new TmuxAttachClient({ onData: () => {}, onExit });
    client.start({ session: "s", cols: 80, rows: 24, socket: "/tmp/s", ptySpawn: spawn });
    proc._exit?.({ exitCode: 0, signal: 9 });
    expect(onExit).toHaveBeenCalledWith(0, 9);
    client.dispose();
  });

  it("resize and write hit the PTY process", () => {
    const capture: {
      file?: string;
      args?: string[];
      options?: { name?: string; cols?: number; rows?: number; env?: NodeJS.ProcessEnv };
    } = {};
    const { spawn, proc } = fakePtySpawn(capture);
    const client = new TmuxAttachClient({ onData: () => {}, onExit: () => {} });
    client.start({
      session: "s",
      cols: 80,
      rows: 24,
      socket: "/tmp/s",
      ptySpawn: spawn,
    });
    client.write("a");
    expect(proc.write).toHaveBeenCalledWith("a");
    client.resize(132, 43);
    expect(proc.resize).toHaveBeenCalledWith(132, 43);
    client.dispose();
    expect(proc.kill).toHaveBeenCalled();
  });
});
