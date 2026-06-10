import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { SOCKET_NAME, defaultExecutor, TmuxError, type ExecResult, type TmuxExecutor } from "./TmuxService.js";

/**
 * The F20 engine: ONE persistent `tmux -C` client replaces the
 * spawn-a-subprocess-per-question conversation with tmux.
 *
 * Two roles:
 *  - command channel: tmux invocations ride the client's stdin/stdout as lines,
 *    replies framed by `%begin`/`%end`/`%error` tags (strictly FIFO per client —
 *    verified on a real socket). Zero subprocess churn in steady state.
 *  - event source: `%sessions-changed` (kill/spawn) plus one `refresh-client -B`
 *    subscription whose format loops (#{S:…}) encode the SERVER-WIDE dead-pane
 *    map — `%subscription-changed` fires ~0.5s after any pane dies, carrying
 *    exit codes. (No pane-death notification exists in the protocol; this is
 *    the documented mechanism. Spiked 2026-06-10 on tmux 3.6.)
 *
 * A control client must be attached to a session, so the engine keeps an anchor
 * (`tachyon-ctl-<hash>`, running `tail -f /dev/null`) — its name sits outside
 * every Tachyon namespace, invisible to the sidebar/manager/runners.
 *
 * Degraded mode is structural: the executor produced by makeExecutor() falls
 * back to per-call subprocesses whenever the client is down (or an argument
 * can't ride the line protocol), and a reconnect loop with capped backoff runs
 * behind it. The engine failing NEVER fails a tmux call.
 */

export const DEADMAP_SUBSCRIPTION = "tachyon-dead";
/** sessions -> windows -> panes; A=alive, D<code>=dead. Spiked: fires in ~0.5s with the code. */
const DEADMAP_FORMAT = "#{S:#{session_name}=#{W:#{P:#{?pane_dead,D#{pane_dead_status},A}}}|}";

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
}

export interface ControlModeOptions {
  wsHash: string;
  socket?: string;
  /** fired (debounce upstream) when the dead-map subscription reports a change */
  onDeadMapChanged?: (map: Map<string, DeadMapEntry>) => void;
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

  /** Boots the engine: anchor session, control client, dead-map subscription. */
  async start(): Promise<void> {
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

    const spawnClient =
      this.opts.spawnClient ??
      ((socket: string, anchor: string) =>
        spawn("tmux", ["-L", socket, "-C", "attach-session", "-t", `=${anchor}`], {
          stdio: ["pipe", "pipe", "pipe"],
        }));
    const proc = spawnClient(this.socket, this.anchorSession);
    this.proc = proc;
    this.awaitingGuard = true;
    this.buffer = "";
    this.frameTag = null;

    proc.stdout.on("data", (chunk: Buffer | string) => this.feed(chunk.toString()));
    proc.on("exit", () => this.onClientDown(proc));
    proc.on("error", () => this.onClientDown(proc));
  }

  /**
   * The TmuxService executor: control-mode first, subprocess fallback. Semantic
   * tmux errors (%error — e.g. "can't find session") reject like the subprocess
   * path would; only transport problems fall back.
   */
  makeExecutor(): TmuxExecutor {
    return (args: string[]) => {
      const [flag, socket, ...cmd] = args;
      if (!this.up || flag !== "-L" || socket !== this.socket || !lineSafe(cmd) || cmd.length === 0) {
        return this.fallback(args);
      }
      return this.exec(cmd).catch((err: unknown) => {
        if (err instanceof TransportError) return this.fallback(args);
        throw err;
      });
    };
  }

  /** Sends one command line over the client; resolves with its framed reply. */
  private exec(cmd: string[]): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      if (!this.proc || !this.up) {
        reject(new TransportError("control client down"));
        return;
      }
      this.pending.push({ resolve, reject, args: cmd });
      this.proc.stdin.write(cmd.map(tmuxQuote).join(" ") + "\n");
    });
  }

  private feed(text: string): void {
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
      return;
    }
    const pending = this.pending.shift();
    if (!pending) return; // unsolicited frame (e.g. session switches) — ignore
    if (isError) {
      pending.reject(new TmuxError(body.trim() || "tmux command failed", pending.args));
    } else {
      pending.resolve({ stdout: body.length > 0 ? body + "\n" : "", stderr: "" });
    }
  }

  private onClientDown(proc: ChildProcessWithoutNullStreams): void {
    if (proc !== this.proc) return; // an old client's late event
    const hadBeenUp = this.up;
    this.up = false;
    this.proc = undefined;
    for (const p of this.pending.splice(0)) p.reject(new TransportError("control client died"));
    if (this.disposed) return;
    if (hadBeenUp || this.wasUp) this.opts.onStateChange?.(false);
    const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(this.reconnectAttempt, backoff.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      void this.start().catch(() => this.onClientDown(this.proc ?? proc));
    }, delay);
  }

  /** Stops the engine and removes the anchor (best effort — infra, not user state). */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.proc?.kill();
    this.proc = undefined;
    this.up = false;
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
