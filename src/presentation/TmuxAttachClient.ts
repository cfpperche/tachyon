/**
 * Layer-2 agent pane transport: attach to an existing Tachyon tmux session through a
 * userspace PTY helper (`script -qfc …`) so we avoid a native `node-pty` dependency
 * (spec 186 rejected node-pty for the default path; layer 2 is additive and optional).
 *
 * Output/input ride the attach client stream. Resize is applied out-of-band via
 * `tmux resize-window` (script does not reliably forward SIGWINCH).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { attachSocketPath } from "./Terminals.js";
import { utf8LocaleEnv } from "../tmux/TmuxService.js";

export interface TmuxAttachClientHandlers {
  onData: (chunk: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
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
  /** Injectable spawn for tests. */
  spawnImpl?: typeof spawn;
  /** Injectable env. */
  env?: NodeJS.ProcessEnv;
}

/** Build the shell command run under `script -qfc`. Exported for unit tests. */
export function buildAttachShellCommand(opts: {
  socket: string;
  session: string;
  exclusive: boolean;
}): string {
  const socket = shellSingleQuote(opts.socket);
  const session = shellSingleQuote(`=${opts.session}`);
  const detach = opts.exclusive ? " -d" : "";
  return `tmux -u -S ${socket} attach-session${detach} -t ${session}`;
}

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Live attach client for one session. One process; dispose kills it (detaches; does not kill the session).
 */
export class TmuxAttachClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private disposed = false;

  constructor(private readonly handlers: TmuxAttachClientHandlers) {}

  get alive(): boolean {
    return this.child !== null && !this.disposed;
  }

  start(opts: TmuxAttachClientOptions): void {
    if (this.disposed) throw new Error("TmuxAttachClient is disposed");
    if (this.child) throw new Error("TmuxAttachClient already started");

    const socket = opts.socket ?? attachSocketPath(opts.env);
    const exclusive = opts.exclusive !== false;
    const cmd = buildAttachShellCommand({ socket, session: opts.session, exclusive });
    const spawnImpl = opts.spawnImpl ?? spawn;
    const env = {
      ...opts.env,
      ...utf8LocaleEnv(opts.env),
      COLUMNS: String(Math.max(2, opts.cols)),
      LINES: String(Math.max(1, opts.rows)),
    };

    const child = spawnImpl("script", ["-qfc", cmd, "/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    }) as ChildProcessWithoutNullStreams;

    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!this.disposed) this.handlers.onData(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      // script occasionally writes diagnostics to stderr; surface as data so xterm can show them
      if (!this.disposed && chunk.trim()) this.handlers.onData(chunk);
    });
    child.on("error", (err) => {
      this.handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
    child.on("exit", (code, signal) => {
      this.child = null;
      if (!this.disposed) this.handlers.onExit(code, signal);
    });
  }

  write(data: string): void {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(data);
  }

  dispose(): void {
    this.disposed = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}
