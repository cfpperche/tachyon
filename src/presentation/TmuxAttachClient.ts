/**
 * Layer-2 agent pane transport: attach to an existing Tachyon tmux session through a
 * **real PTY** (`node-pty`), matching VS Code integrated terminal semantics.
 *
 * Why node-pty (not `script`/pipes):
 * - Extension Host has no controlling TTY; pipes leave TERM dumb and TUIs die
 *   ("open terminal failed: terminal does not support clear").
 * - Spec 186 rejected node-pty for the *default* path (layer 1 = integrated terminal).
 *   Layer 2 owns the viewport, so it must own a PTY client — same model as Ghostty-in-webview.
 *
 * Attach args mirror `Terminals.open`: `tmux -u -S <socket> attach-session -d -t =<session>`.
 */
import { attachSocketPath } from "./Terminals.js";
import { utf8LocaleEnv } from "../tmux/TmuxService.js";

export interface TmuxAttachClientHandlers {
  onData: (chunk: string) => void;
  onExit: (code: number | null, signal: number | null) => void;
  onError?: (err: Error) => void;
}

export interface TmuxAttachClientOptions {
  session: string;
  cols: number;
  rows: number;
  /** Detach other clients on attach (matches layer-1 `attach -d`). Default true. */
  exclusive?: boolean;
  /** Absolute tmux socket; defaults to `attachSocketPath()`. */
  socket?: string;
  /** Injectable env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Injectable pty spawn (tests). Signature mirrors node-pty's spawn.
   * Production uses `require("node-pty").spawn`.
   */
  ptySpawn?: PtySpawn;
}

/** Minimal node-pty surface we depend on (keeps unit tests free of the native module). */
export type PtySpawn = (
  file: string,
  args: string[],
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
) => PtyProcess;

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): { dispose?: () => void } | void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose?: () => void } | void;
}

/** Build tmux attach argv (no shell). Exported for unit tests. */
export function buildAttachArgv(opts: {
  socket: string;
  session: string;
  exclusive: boolean;
}): { file: string; args: string[] } {
  const args = ["-u", "-S", opts.socket, "attach-session"];
  if (opts.exclusive) args.push("-d");
  args.push("-t", `=${opts.session}`);
  return { file: "tmux", args };
}

/** @deprecated shell form kept only for older tests — prefer buildAttachArgv. */
export function buildAttachShellCommand(opts: {
  socket: string;
  session: string;
  exclusive: boolean;
}): string {
  const { file, args } = buildAttachArgv(opts);
  return [file, ...args.map(shellSingleQuote)].join(" ");
}

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function loadPtySpawn(): PtySpawn {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require("node-pty") as { spawn: PtySpawn };
  if (typeof pty?.spawn !== "function") {
    throw new Error("node-pty is not available (native module failed to load)");
  }
  return pty.spawn;
}

/**
 * Live attach client for one session. dispose() kills the PTY client only —
 * it never kills the underlying tmux session / agent process.
 */
export class TmuxAttachClient {
  private proc: PtyProcess | null = null;
  private disposed = false;

  constructor(private readonly handlers: TmuxAttachClientHandlers) {}

  get alive(): boolean {
    return this.proc !== null && !this.disposed;
  }

  start(opts: TmuxAttachClientOptions): void {
    if (this.disposed) throw new Error("TmuxAttachClient is disposed");
    if (this.proc) throw new Error("TmuxAttachClient already started");

    const socket = opts.socket ?? attachSocketPath(opts.env);
    const exclusive = opts.exclusive !== false;
    const cols = Math.max(2, Math.floor(opts.cols));
    const rows = Math.max(1, Math.floor(opts.rows));
    const { file, args } = buildAttachArgv({ socket, session: opts.session, exclusive });

    const baseEnv = opts.env ?? process.env;
    // Force a capable terminal identity — Extension Host has no TTY inheritance.
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      ...utf8LocaleEnv(baseEnv),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    };

    const spawnPty = opts.ptySpawn ?? loadPtySpawn();
    let proc: PtyProcess;
    try {
      proc = spawnPty(file, args, {
        name: "xterm-256color",
        cols,
        rows,
        env,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handlers.onError?.(error);
      throw error;
    }

    this.proc = proc;

    proc.onData((data) => {
      if (!this.disposed) this.handlers.onData(data);
    });
    proc.onExit(({ exitCode, signal }) => {
      this.proc = null;
      if (!this.disposed) {
        this.handlers.onExit(
          typeof exitCode === "number" ? exitCode : null,
          // node-pty reports signal 0 for "no signal" — a clean detach (another client attached
          // with `-d`) arrives as {exitCode: 0, signal: 0}. Passing that 0 through made the pane
          // say "attach ended (signal 0)", which reads as a kill. 0 is the absence of a signal.
          typeof signal === "number" && signal > 0 ? signal : null,
        );
      }
    });
  }

  write(data: string): void {
    if (!this.proc || this.disposed) return;
    try {
      this.proc.write(data);
    } catch {
      /* PTY may already be dead */
    }
  }

  /** Resize the PTY client (and thus the tmux window when this client is the active size leader). */
  resize(cols: number, rows: number): void {
    if (!this.proc || this.disposed) return;
    const c = Math.max(2, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    try {
      this.proc.resize(c, r);
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.disposed = true;
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
}
