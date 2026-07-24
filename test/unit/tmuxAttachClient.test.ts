import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { buildAttachShellCommand, shellSingleQuote, TmuxAttachClient } from "../../src/presentation/TmuxAttachClient.js";
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

describe("TmuxAttachClient env", () => {
  it("forces TERM=xterm-256color so attach is not dumb (black pane root cause)", () => {
    const stdin = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; writable: boolean };
    stdin.write = vi.fn();
    stdin.end = vi.fn();
    stdin.writable = true;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (stdout as { setEncoding?: (e: string) => void }).setEncoding = () => {};
    (stderr as { setEncoding?: (e: string) => void }).setEncoding = () => {};
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: typeof stdin;
        stdout: typeof stdout;
        stderr: typeof stderr;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = vi.fn();
      return child;
    });
    // wrap to capture env arg
    const spawnWrapper = ((...args: unknown[]) => {
      capturedEnv = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
      // spawn(file, args, options) — options is 3rd
      const opts = args[2] as { env?: NodeJS.ProcessEnv };
      capturedEnv = opts?.env;
      return spawnImpl();
    }) as typeof import("node:child_process").spawn;

    const client = new TmuxAttachClient({ onData: () => {}, onExit: () => {} });
    client.start({
      session: "tachyon-test",
      cols: 80,
      rows: 24,
      socket: "/tmp/tmux-1000/tachyon",
      spawnImpl: spawnWrapper,
      env: { TERM: "dumb", PATH: "/usr/bin" },
    });
    expect(capturedEnv?.TERM).toBe("xterm-256color");
    expect(capturedEnv?.COLORTERM).toBe("truecolor");
    expect(capturedEnv?.COLUMNS).toBe("80");
    expect(capturedEnv?.LINES).toBe("24");
    client.dispose();
  });
});
