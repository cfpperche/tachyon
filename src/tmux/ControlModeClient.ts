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
import { sealExecutionEvent, type RawExecutionEvent, type SealedExecutionEvent } from "../executionGraph/eventSchema.js";
import { mintExecution } from "../executionGraph/executionIdentity.js";

/**
 * The F20 engine: ONE persistent `tmux -C` client replaces the
 * spawn-a-subprocess-per-question conversation with tmux.
 *
 * Two roles:
 *  - command channel: tmux invocations ride the client's stdin/stdout as lines,
 *    replies framed by `%begin`/`%end`/`%error` tags. The tag carries
 *    `<time> <command_number> <flags>` (tmux CONTROL MODE); the client matches
 *    completed frames to pending work by that server-assigned command number in
 *    order, not by bare FIFO position — so a gapped or reordered frame cannot
 *    silently complete the wrong command (t-9610e8). Zero subprocess churn in
 *    steady state.
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

/**
 * tmux CONTROL MODE: `%begin`/`%end`/`%error` share three arguments —
 * integer time (epoch seconds), command number, flags. The command number is
 * assigned by the server when it runs the line; the client learns it only when
 * the frame opens. Returns null if the tag is not parseable.
 */
export function parseControlModeCommandNumber(frameTag: string): number | null {
  const parts = frameTag.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const n = Number(parts[1]);
  return Number.isInteger(n) ? n : null;
}

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
  bootstrap: boolean;
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
  /**
   * SDD 480 Phase 2 — sink for execution-graph events. Optional: a client without it behaves exactly
   * as before, which is what keeps this wiring reversible seam by seam.
   */
  recordExecution?: (event: SealedExecutionEvent) => void;
  /** test seams */
  spawnClient?: (socket: string, anchor: string, env?: Record<string, string>) => ChildProcessWithoutNullStreams;
  fallbackExec?: TmuxExecutor;
  backoffMs?: number[];
}

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000];

export class ControlModeClient {
  /** Serializes anchor creation/removal across replacement instances in this process. */
  private static readonly anchorTails = new Map<string, Promise<void>>();
  private proc: ChildProcessWithoutNullStreams | undefined;
  /** The transport can enqueue its own bootstrap commands once connected. */
  private up = false;
  /** External commands only enter the FIFO after every bootstrap reply settles. */
  private ready = false;
  private bootstrapReplies = 0;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private awaitingGuard = true;
  private buffer = "";
  private frameTag: string | null = null;
  private frameBody: string[] = [];
  private pending: Pending[] = [];
  /**
   * Next server command number we will release to `pending[0]`. Null until the
   * first non-guard frame of this generation establishes the baseline (the
   * attach guard's number is not contiguous with later commands — measured on
   * tmux 3.6: guard 276 then first line-command 281).
   */
  private nextCommandNumber: number | null = null;
  /** Completed frames held until their command number is next to release. */
  private heldFrames = new Map<number, { isError: boolean; body: string }>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly socket: string;
  private readonly fallback: TmuxExecutor;

  constructor(private readonly opts: ControlModeOptions) {
    this.socket = opts.socket ?? SOCKET_NAME;
    this.fallback = opts.fallbackExec ?? defaultExecutor;
  }

  /**
   * SDD 480 Phase 2 — seal one execution event and hand it to the sink, never throwing.
   *
   * The transport must not fail to connect because the graph could not describe the connection.
   */
  private emitExecution(raw: RawExecutionEvent): void {
    if (!this.opts.recordExecution) return;
    try { this.opts.recordExecution(sealExecutionEvent(raw)); } catch { /* observation only */ }
  }

  get anchorSession(): string {
    return `tachyon-ctl-${this.opts.wsHash}`;
  }

  get isUp(): boolean {
    return this.ready;
  }

  /** Boots the engine: anchor session, control client, dead-map + activity subscriptions. */
  async start(): Promise<void> {
    if (this.disposed) return;
    await this.withAnchorLock(async () => {
      if (this.disposed) return;
      // Anchor (and the server) must exist before a client can attach. Idempotent:
      // "duplicate session" just means a previous window left it for us.
      // SDD 480 §4.2 — that idempotence is exactly the `shared` case: whether we CREATED the anchor or
      // merely found one someone else left is the difference between a resource we own and one we are
      // joining, and it is knowable here and nowhere later.
      let anchorPreexisted = false;
      try {
        await this.fallback([
          "-L", this.socket,
          "new-session", "-d", "-s", this.anchorSession, "tail -f /dev/null",
        ]);
      } catch (err) {
        if (!(err instanceof Error && /duplicate session/.test(err.message))) throw err;
        anchorPreexisted = true;
      }
      // The anchor gets its own identity because the client process ATTACHES to it: an edge needs two
      // ends. It is `absent`/`unproven` by construction — the anchor runs `tail -f /dev/null` started
      // through tmux with no environment of ours, so no later observation can prove it is this one.
      const anchor = mintExecution({ agentId: "host", carrier: "absent" });
      this.emitExecution({
        kind: anchorPreexisted ? "attach" : "spawn",
        node: "TmuxSession",
        // A pre-existing anchor is `shared`, not `running`: other windows may already be attached, and
        // recording it as ours would assert an ownership we cannot support.
        state: anchorPreexisted ? "shared" : "running",
        provenance: anchor.provenance,
        correlation: anchor.correlation,
        at: new Date().toISOString(),
        detail: { seam: "ControlModeClient.start", anchor: this.anchorSession, socket: this.socket },
      });
      if (this.disposed) {
        await this.cleanupAnchorUnlocked();
        return;
      }

      // The client PROCESS is ours — we spawn it and control its env — so unlike the anchor it really
      // can carry the id. An injected `spawnClient` is a test seam that builds its own child, so it is
      // declared `absent`: claiming `carried` for an env we did not set is the guess this spec forbids.
      const client = mintExecution({
        agentId: "host",
        carrier: this.opts.spawnClient ? "absent" : "carried",
      });
      const spawnClient =
        this.opts.spawnClient ??
        ((socket: string, anchor: string, env?: Record<string, string>) =>
          spawn("tmux", isolatedArgs(["-L", socket, "-C", "attach-session", "-t", `=${anchor}`]), {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, ...utf8LocaleEnv(), ...env },
          }));
      const proc = spawnClient(this.socket, this.anchorSession, client.env);
      this.emitExecution({
        kind: "attach", node: "Process", state: "running", provenance: client.provenance,
        correlation: client.correlation, at: new Date().toISOString(),
        // `attached`, not `spawned`: the process is new but the thing it joins is not, and the graph
        // has to say which of the two it is describing.
        edge: { kind: "attached", toExecutionId: anchor.executionId },
        detail: { seam: "ControlModeClient.start", anchor: this.anchorSession, socket: this.socket },
      });
      this.proc = proc;
      if (this.disposed) {
        this.proc = undefined;
        proc.kill();
        await this.cleanupAnchorUnlocked();
        return;
      }
      this.awaitingGuard = true;
      this.up = false;
      this.ready = false;
      this.bootstrapReplies = 0;
      this.buffer = "";
      this.frameTag = null;
      this.frameBody = [];
      this.nextCommandNumber = null;
      this.heldFrames.clear();

      proc.stdout.on("data", (chunk: Buffer | string) => this.feed(proc, chunk.toString()));
      proc.on("exit", () => this.onClientDown(proc));
      proc.on("error", () => this.onClientDown(proc));
    });
  }

  /**
   * The TmuxService executor: control-mode first, subprocess fallback. Semantic
   * tmux errors (%error — e.g. "can't find session") reject like the subprocess
   * path would; only transport problems fall back.
   *
   * t-9610e8 reconverges `has-session` onto the channel: frames settle by the
   * server command number in `%begin`/`%end`/`%error`, so a gapped success body
   * can no longer complete a different occupancy probe (the t-72d4d3 desync).
   */
  makeExecutor(): TmuxExecutor {
    return (args: string[], options: TmuxExecOptions = {}) => {
      const [flag, socket, ...cmd] = args;
      if (
        !this.ready
        || flag !== "-L"
        || socket !== this.socket
        || !lineSafe(cmd)
        || cmd.length === 0
      ) {
        return this.fallback(args, options);
      }
      return this.exec(cmd, options).catch((err: unknown) => {
        if (err instanceof TransportError) return this.fallback(args, options);
        throw err;
      });
    };
  }

  /** Sends one command line over the client; resolves with its framed reply. */
  private exec(cmd: string[], options: TmuxExecOptions = {}, bootstrap = false): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const proc = this.proc;
      if (!proc || !this.up) {
        reject(new TransportError("control client down"));
        return;
      }
      const pending: Pending = { resolve, reject, args: cmd, timer: undefined, bootstrap };
      if (options.timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          if (proc !== this.proc || !this.pending.includes(pending)) return;
          const error = new TransportError(
            `tmux ${options.op ?? "control operation"} timed out after ${options.timeoutMs}ms; reconnecting control client`,
          );
          // A missing frame leaves later numbers held, not assigned to the wrong
      // pending (t-9610e8). Retire the whole generation anyway: one gap means
      // the wire may still deliver the late body after we would have moved on,
      // and a single-entry drop would re-open silent mis-assignment.
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
        const frameTag = this.frameTag;
        this.frameTag = null;
        this.frameBody = [];
        const commandNumber = parseControlModeCommandNumber(frameTag);
        if (commandNumber === null) {
          const proc = this.proc;
          if (proc) {
            this.onClientDown(
              proc,
              new TransportError(`control-mode frame tag not parseable: ${frameTag}`),
            );
            proc.kill();
          }
          return;
        }
        this.settleFrame(isError, body, commandNumber);
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

  private settleFrame(isError: boolean, body: string, commandNumber: number): void {
    if (this.awaitingGuard) {
      // The implicit attach reply makes the internal channel usable. External
      // work remains on the subprocess fallback until both subscription
      // replies have left this generation's queue. Do NOT seed
      // nextCommandNumber from the guard: on real tmux 3.6 its number is not
      // contiguous with the first line-command that follows.
      this.awaitingGuard = false;
      this.up = true;
      this.ready = false;
      this.bootstrapReplies = 2;
      // Subscribe AFTER the guard so the reply queue stays aligned.
      void this.exec(["refresh-client", "-B", `${DEADMAP_SUBSCRIPTION}::${DEADMAP_FORMAT}`], {}, true).catch(() => {
        /* old tmux without -B: command channel still works, events degrade to the heartbeat */
      });
      void this.exec(["refresh-client", "-B", `${ACTIVITY_SUBSCRIPTION}::${ACTIVITY_FORMAT}`], {}, true).catch(() => {
        /* old tmux without -B / window_activity: AttentionMonitor falls back to full capture polling */
      });
      return;
    }

    if (this.nextCommandNumber !== null && commandNumber < this.nextCommandNumber) {
      // Duplicate or already-released number — the stream is not trustworthy.
      const proc = this.proc;
      if (proc) {
        this.onClientDown(
          proc,
          new TransportError(
            `control-mode command number ${commandNumber} already released (next ${this.nextCommandNumber})`,
          ),
        );
        proc.kill();
      }
      return;
    }

    this.heldFrames.set(commandNumber, { isError, body });
    if (this.nextCommandNumber === null) {
      this.nextCommandNumber = commandNumber;
    }

    while (this.pending.length > 0 && this.nextCommandNumber !== null && this.heldFrames.has(this.nextCommandNumber)) {
      const frame = this.heldFrames.get(this.nextCommandNumber)!;
      this.heldFrames.delete(this.nextCommandNumber);
      this.nextCommandNumber++;
      const pending = this.pending.shift()!;
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.bootstrap) this.settleBootstrapReply();
      if (frame.isError) {
        pending.reject(new TmuxError(frame.body.trim() || "tmux command failed", pending.args));
      } else {
        pending.resolve({ stdout: frame.body.length > 0 ? frame.body + "\n" : "", stderr: "" });
      }
    }
    // Gapped higher numbers stay in heldFrames until the missing number arrives
    // or a timeout retires the generation. Unsolicited frames with no pending
    // waiter are left held and cleared on client down — never shifted onto a
    // later command.
  }

  private settleBootstrapReply(): void {
    if (this.bootstrapReplies <= 0) return;
    this.bootstrapReplies--;
    if (this.bootstrapReplies !== 0 || !this.up || !this.proc || this.disposed) return;
    this.ready = true;
    this.reconnectAttempt = 0;
    this.opts.onStateChange?.(true);
  }

  private onClientDown(proc: ChildProcessWithoutNullStreams, error = new TransportError("control client died")): void {
    if (proc !== this.proc) return; // an old client's late event
    const hadBeenReady = this.ready;
    this.up = false;
    this.ready = false;
    this.bootstrapReplies = 0;
    this.proc = undefined;
    this.buffer = "";
    this.frameTag = null;
    this.frameBody = [];
    this.nextCommandNumber = null;
    this.heldFrames.clear();
    for (const p of this.pending.splice(0)) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(error);
    }
    if (this.disposed) return;
    if (hadBeenReady) this.opts.onStateChange?.(false);
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
  dispose(): Promise<void> {
    return this.disposePromise ??= this.disposeOnce();
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const proc = this.proc;
    this.proc = undefined;
    this.up = false;
    this.ready = false;
    this.bootstrapReplies = 0;
    this.buffer = "";
    this.frameTag = null;
    this.frameBody = [];
    this.nextCommandNumber = null;
    this.heldFrames.clear();
    const error = new ControlModeDisposedError("control client disposed");
    for (const pending of this.pending.splice(0)) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    proc?.kill();
    // Queue teardown behind any in-flight bootstrap and ahead of successors.
    // Bootstrap cleanup uses the unlocked variant because start() already owns
    // this same socket+anchor lock.
    await this.withAnchorLock(() => this.cleanupAnchorUnlocked());
  }

  /** Serializes shared anchor transitions by socket and anchor session. */
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
  private async cleanupAnchorUnlocked(): Promise<void> {
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
