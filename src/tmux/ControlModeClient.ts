import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  SOCKET_NAME,
  defaultExecutor,
  isolatedArgs,
  utf8LocaleEnv,
  TmuxError,
  type ExecResult,
  type TmuxExecOptions,
  type TmuxExecutor,
} from "./TmuxService.js";

/**
 * The F20 engine: ONE persistent `tmux -C` client replaces the
 * spawn-a-subprocess-per-question conversation with tmux.
 *
 * Two roles:
 *  - command channel: tmux invocations ride the client's stdin/stdout as lines,
 *    replies framed by `%begin`/`%end`/`%error` tags (strictly FIFO per client —
 *    verified on a real socket). Zero subprocess churn in steady state.
 *  - event source: `%sessions-changed` (kill/spawn) plus `refresh-client -B`
 *    subscriptions whose format loops (#{S:…}) encode SERVER-WIDE maps —
 *    dead-pane liveness (`tachyon-dead`) and last-activity timestamps
 *    (`tachyon-activity`). `%subscription-changed` fires when a format value
 *    changes (~0.5s after pane death / output). (No native pane-death or
 *    pane-output notifications; this is the documented mechanism. Spiked
 *    2026-06-10 on tmux 3.6.)
 *
 * A control client must be attached to a session, so the engine keeps an anchor
 * (`tachyon-ctl-<hash>`, running `tail -f /dev/null`) — its name sits outside
 * every Tachyon namespace, invisible to the sidebar/manager/runners.
 *
 * Degraded mode is structural: the executor produced by makeExecutor() falls
 * back to per-call subprocesses whenever the client is down (or an argument
 * can't ride the line protocol), and a reconnect loop with capped backoff runs
 * behind it. The engine failing NEVER fails a tmux call. AttentionMonitor
 * similarly falls back to full capture-pane polling when the activity
 * subscription is unavailable.
 */

export const DEADMAP_SUBSCRIPTION = "tachyon-dead";
/** sessions -> windows -> panes; A=alive, D<code>=dead. Spiked: fires in ~0.5s with the code. */
const DEADMAP_FORMAT = "#{S:#{session_name}=#{W:#{P:#{?pane_dead,D#{pane_dead_status},A}}}|}";

/** t-4ecf9a — per-session last-output timestamps (tmux #{window_activity}). */
export const ACTIVITY_SUBSCRIPTION = "tachyon-activity";
const ACTIVITY_FORMAT = "#{S:#{session_name}=#{window_activity}|}";

export interface DeadMapEntry {
  dead: boolean;
  exitCode?: number;
}

/** name=AAD7A| segments -> per-session liveness (any dead pane marks the session dead). */
export function parseDeadMap(value: string): Map<string, DeadMapEntry> {
  const map = new Map<string, DeadMapEntry>();
  for (const segment of value.split("|")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const name = segment.slice(0, eq);
    const status = segment.slice(eq + 1);
    const dead = status.includes("D");
    const code = dead ? /D(\d+)/.exec(status)?.[1] : undefined;
    map.set(name, { dead, exitCode: code !== undefined ? Number(code) : undefined });
  }
  return map;
}

/** name=<unix-seconds>| segments -> per-session #{window_activity} timestamps. */
export function parseActivityMap(value: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const segment of value.split("|")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const name = segment.slice(0, eq);
    const ts = Number(segment.slice(eq + 1));
    if (Number.isFinite(ts)) map.set(name, ts);
  }
  return map;
}

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,.\/-]+$/;

/** tmux line-protocol quoting: single-quote wrapping, '\'' for embedded quotes. */
export function tmuxQuote(arg: string): string {
  if (arg === "") return "''";
  if (arg === ";") return ";"; // bare separator — quoting it would make it a literal
  if (SAFE_ARG.test(arg)) return arg;
  return "'" + arg.replaceAll("'", "'\\''") + "'";
}

/** Newlines cannot ride a line protocol — such calls take the subprocess path. */
export function lineSafe(args: string[]): boolean {
  return args.every((a) => !/[\n\r]/.test(a));
}

interface Pending {
  resolve: (r: ExecResult) => void;
  reject: (e: Error) => void;
  args: string[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface ControlModeOptions {
  wsHash: string;
  socket?: string;
  /** fired (debounce upstream) when the dead-map subscription reports a change */
  onDeadMapChanged?: (map: Map<string, DeadMapEntry>) => void;
  /** t-4ecf9a — fired when any session's #{window_activity} changes (push idle/active signal) */
  onActivityMapChanged?: (map: Map<string, number>) => void;
  /** fired when sessions appear/vanish on the server */
  onSessionsChanged?: () => void;
  /** up=false fires once per outage (single non-spammy warning upstream) */
  onStateChange?: (up: boolean) => void;
  /** test seams */
  spawnClient?: (socket: string, anchor: string) => ChildProcessWithoutNullStreams;
  fallbackExec?: TmuxExecutor;
  backoffMs?: number[];
}

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000];

export class ControlModeClient {
  /** Serializes anchor creation/removal across replacement instances in this process. */
  private static readonly anchorTails = new Map<string, Promise<void>>();
  private proc: ChildProcessWithoutNullStreams | undefined;
  private up = false;
  private disposed = false;
  private wasUp = false;
  private awaitingGuard = true;
  private buffer = "";
  private frameTag: string | null = null;
  private frameBody: string[] = [];
  private pending: Pending[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly socket: string;
  private readonly fallback: TmuxExecutor;

  constructor(private readonly opts: ControlModeOptions) {
    this.socket = opts.socket ?? SOCKET_NAME;
    this.fallback = opts.fallbackExec ?? defaultExecutor;
  }

  get anchorSession(): string {
    return `tachyon-ctl-${this.opts.wsHash}`;
  }

  get isUp(): boolean {
    return this.up;
  }

  /** Boots the engine: anchor session, control client, dead-map + activity subscriptions. */
  async start(): Promise<void> {
    if (this.disposed) return;
    await this.withAnchorLock(async () => {
      if (this.disposed) return;
      // Anchor (and the server) must exist before a client can attach. Idempotent:
      // "duplicate session" just means a previous window left it for us.
      try {
        await this.fallback([
          "-L", this.socket,
          "new-session", "-d", "-s", this.anchorSession, "tail -f /dev/null",
        ]);
      } catch (err) {
        if (!(err instanceof Error && /duplicate session/.test(err.message))) throw err;
      }
      if (this.disposed) {
        await this.cleanupAnchor();
        return;
      }

      const spawnClient =
        this.opts.spawnClient ??
        ((socket: string, anchor: string) =>
          spawn("tmux", isolatedArgs(["-L", socket, "-C", "attach-session", "-t", `=${anchor}`]), {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, ...utf8LocaleEnv() },
          }));
      const proc = spawnClient(this.socket, this.anchorSession);
      this.proc = proc;
      if (this.disposed) {
        this.proc = undefined;
        proc.kill();
        await this.cleanupAnchor();
        return;
      }
      this.awaitingGuard = true;
      this.buffer = "";
      this.frameTag = null;

      proc.stdout.on("data", (chunk: Buffer | string) => this.feed(proc, chunk.toString()));
      proc.on("exit", () => this.onClientDown(proc));
      proc.on("error", () => this.onClientDown(proc));
    });
  }

  /**
   * The TmuxService executor: control-mode first, subprocess fallback. Semantic
   * tmux errors (%error — e.g. "can't find session") reject like the subprocess
   * path would; only transport problems fall back.
   */
  makeExecutor(): TmuxExecutor {
    return (args: string[], options: TmuxExecOptions = {}) => {
      const [flag, socket, ...cmd] = args;
      if (!this.up || flag !== "-L" || socket !== this.socket || !lineSafe(cmd) || cmd.length === 0) {
        return this.fallback(args, options);
      }
      return this.exec(cmd, options).catch((err: unknown) => {
        if (err instanceof TransportError) return this.fallback(args, options);
        throw err;
      });
    };
  }

  /** Sends one command line over the client; resolves with its framed reply. */
  private exec(cmd: string[], options: TmuxExecOptions = {}): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const proc = this.proc;
      if (!proc || !this.up) {
        reject(new TransportError("control client down"));
        return;
      }
      const pending: Pending = { resolve, reject, args: cmd, timer: undefined };
      if (options.timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          if (proc !== this.proc || !this.pending.includes(pending)) return;
          const error = new TransportError(
            `tmux ${options.op ?? "control operation"} timed out after ${options.timeoutMs}ms; reconnecting control client`,
          );
          // Replies are FIFO and carry no command identity. Once one frame is
          // missing, removing only that entry would let its late reply complete
          // the next command. Retire the whole client generation instead.
          this.onClientDown(proc, error);
          proc.kill();
        }, options.timeoutMs);
      }
      this.pending.push(pending);
      proc.stdin.write(cmd.map(tmuxQuote).join(" ") + "\n");
    });
  }

  private feed(proc: ChildProcessWithoutNullStreams, text: string): void {
    // A retired generation may still flush stdout after a timeout/kill. Its
    // frames must never enter the parser for the replacement generation.
    if (proc !== this.proc) return;
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    // Inside a reply frame, EVERYTHING that isn't the matching %end/%error is body —
    // pane content may legitimately start with "%".
    if (this.frameTag !== null) {
      if (line === `%end ${this.frameTag}` || line === `%error ${this.frameTag}`) {
        const isError = line.startsWith("%error");
        const body = this.frameBody.join("\n");
        this.frameTag = null;
        this.frameBody = [];
        this.settleFrame(isError, body);
      } else {
        this.frameBody.push(line);
      }
      return;
    }

    if (line.startsWith("%begin ")) {
      this.frameTag = line.slice("%begin ".length);
      this.frameBody = [];
      return;
    }

    if (line.startsWith(`%subscription-changed ${DEADMAP_SUBSCRIPTION} `)) {
      const sep = line.indexOf(" : ");
      if (sep >= 0) this.opts.onDeadMapChanged?.(parseDeadMap(line.slice(sep + 3)));
      return;
    }
    if (line.startsWith(`%subscription-changed ${ACTIVITY_SUBSCRIPTION} `)) {
      const sep = line.indexOf(" : ");
      if (sep >= 0) this.opts.onActivityMapChanged?.(parseActivityMap(line.slice(sep + 3)));
      return;
    }
    if (line.startsWith("%sessions-changed")) {
      this.opts.onSessionsChanged?.();
      return;
    }
    // %exit announces the server is letting go — the process exit handler reconnects.
  }

  private settleFrame(isError: boolean, body: string): void {
    if (this.awaitingGuard) {
      // The implicit attach reply — marks the channel ready.
      this.awaitingGuard = false;
      this.up = true;
      this.wasUp = true;
      this.reconnectAttempt = 0;
      this.opts.onStateChange?.(true);
      // Subscribe AFTER the guard so the reply queue stays aligned.
      void this.exec(["refresh-client", "-B", `${DEADMAP_SUBSCRIPTION}::${DEADMAP_FORMAT}`]).catch(() => {
        /* old tmux without -B: command channel still works, events degrade to the heartbeat */
      });
      void this.exec(["refresh-client", "-B", `${ACTIVITY_SUBSCRIPTION}::${ACTIVITY_FORMAT}`]).catch(() => {
        /* old tmux without -B / window_activity: AttentionMonitor falls back to full capture polling */
      });
      return;
    }
    const pending = this.pending.shift();
    if (!pending) return; // unsolicited frame (e.g. session switches) — ignore
    if (pending.timer) clearTimeout(pending.timer);
    if (isError) {
      pending.reject(new TmuxError(body.trim() || "tmux command failed", pending.args));
    } else {
      pending.resolve({ stdout: body.length > 0 ? body + "\n" : "", stderr: "" });
    }
  }

  private onClientDown(proc: ChildProcessWithoutNullStreams, error = new TransportError("control client died")): void {
    if (proc !== this.proc) return; // an old client's late event
    const hadBeenUp = this.up;
    this.up = false;
    this.proc = undefined;
    this.buffer = "";
    this.frameTag = null;
    this.frameBody = [];
    for (const p of this.pending.splice(0)) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(error);
    }
    if (this.disposed) return;
    if (hadBeenUp || this.wasUp) this.opts.onStateChange?.(false);
    this.scheduleReconnect();
  }

  /** Bootstrap can fail before a new process generation exists; retry it independently. */
  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(this.reconnectAttempt, backoff.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start().catch(() => this.scheduleReconnect());
    }, delay);
  }

  /** Stops the engine and removes the anchor (best effort — infra, not user state). */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const proc = this.proc;
    this.proc = undefined;
    this.up = false;
    this.buffer = "";
    this.frameTag = null;
    this.frameBody = [];
    const error = new ControlModeDisposedError("control client disposed");
    for (const pending of this.pending.splice(0)) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    proc?.kill();
    // A bootstrap holding the anchor lock may still be pending. Clean up the
    // current anchor immediately; that bootstrap will perform a second cleanup
    // before releasing the lock to any successor.
    await this.cleanupAnchor();
  }

  /** Serializes shared anchor transitions without blocking dispose on bootstrap. */
  private async withAnchorLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = `${this.socket}\0${this.anchorSession}`;
    const previous = ControlModeClient.anchorTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    ControlModeClient.anchorTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (ControlModeClient.anchorTails.get(key) === tail) ControlModeClient.anchorTails.delete(key);
    }
  }

  /** Removes an anchor that may have completed bootstrapping during teardown. */
  private async cleanupAnchor(): Promise<void> {
    try {
      await this.fallback(["-L", this.socket, "kill-session", "-t", `=${this.anchorSession}`]);
    } catch {
      /* already gone / server down */
    }
  }
}

/** Channel-level failure — the executor retries these on the subprocess path. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/** Terminal teardown failure: deliberately not a TransportError, so callers never fall back. */
export class ControlModeDisposedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlModeDisposedError";
  }
}
