import { execFile, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyComposerSubmission,
  stripAnsi,
  type ComposerSubmissionState,
} from "../runtime/composerRegion.js";
import type { ComposerRegionProfile } from "../runtime/runtimeProfile.js";
import { parseSessionClients, type SessionClientInfo } from "../presentation/foreignTmuxClient.js";

/**
 * Env seam for the dedicated tmux server socket name (`t-05097f`).
 *
 * The editor-host gate used to run against the SAME socket as the live fleet, because this name was
 * a hardcoded constant. Measured: its "Stop All" scenario listed `tachyon-b349073a-*` — real running
 * agents — and its own `tachyon-a2e81f24-*` sessions survived between runs, so the next run found an
 * entry already live, spawned nothing, and emitted no `new-session` while still reporting it started.
 * A per-run socket makes each gate execution its own tmux SERVER: it cannot list, stop or reuse a
 * session it did not create, and nothing leaks into the run after it.
 */
export const TMUX_SOCKET_ENV = "TACHYON_TMUX_SOCKET";

/** Default dedicated socket — isolates Tachyon from the user's own tmux server and ~/.tmux.conf sessions. */
export const DEFAULT_SOCKET_NAME = "tachyon";

/** The socket this process talks to: the env override when set, else the shared default. */
export function resolveSocketName(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[TMUX_SOCKET_ENV]?.trim();
  return override ? override : DEFAULT_SOCKET_NAME;
}

export const SOCKET_NAME = resolveSocketName();
export const SESSION_PREFIX = "tachyon";
/** new-session -e (per-session env) requires tmux >= 3.2. */
export const MIN_TMUX_VERSION = 3.2;

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface TmuxExecOptions {
  timeoutMs?: number;
  op?: string;
}

/** Executes a tmux invocation with the given args (socket flag is prepended by the service). */
export type TmuxExecutor = (args: string[], options?: TmuxExecOptions) => Promise<ExecResult>;

export const TMUX_CONTROL_TIMEOUT_MS = 2000;
export const TMUX_CAPTURE_TIMEOUT_MS = 5000;
export const TMUX_SESSION_CREATE_TIMEOUT_MS = 8000;
export const TMUX_CONTROL_CONCURRENCY = 4;
/** Maximum time an operation may wait for a concurrency slot before its executor starts. */
export const TMUX_QUEUE_WAIT_TIMEOUT_MS = 8000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One pane's live state on the socket — the row shape behind the server inspector. */
export interface PaneSnapshot {
  session: string;
  window: number;
  pane: number;
  pid: number;
  dead: boolean;
  exitCode?: number;
  /** What's running in the pane now (e.g. `node`, `bash`). */
  currentCommand: string;
  /** The command the pane was launched with. */
  startCommand: string;
  /** Session start time, epoch seconds (for uptime). */
  createdAt?: number;
}

export class TmuxError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
  ) {
    super(message);
    this.name = "TmuxError";
  }
}

export type TmuxQueueErrorCode = "TMUX_QUEUE_TIMEOUT" | "TMUX_SERVICE_DISPOSED";

/** Structured failure raised before an operation reaches the tmux executor. */
export class TmuxQueueError extends TmuxError {
  constructor(
    message: string,
    args: string[],
    public readonly code: TmuxQueueErrorCode,
    public readonly op: string,
    public readonly queueWaitTimeoutMs?: number,
  ) {
    super(message, args);
    this.name = "TmuxQueueError";
  }
}

function isTmuxTimeout(err: unknown): err is TmuxError {
  return err instanceof TmuxError && /timed out/i.test(err.message);
}

/**
 * Prepends `-f /dev/null` so a tmux subprocess never loads the user's
 * ~/.tmux.conf on Tachyon's dedicated socket. tmux reads config only at server
 * START, but every subprocess carries the flag so whichever call first starts
 * the server (the control-mode anchor, or a subprocess-path new-session) runs
 * config-less — keeping the user's plugins/hooks (e.g. resurrect/continuum,
 * which would otherwise auto-save and resurrect our sessions) off our socket.
 * Injected at the exec boundary, not in arg-building, so control-mode routing
 * and the arg-shape unit tests are unaffected.
 */
export function isolatedArgs(args: string[]): string[] {
  return ["-f", "/dev/null", ...args];
}

/**
 * tmux picks its UTF-8 mode from LC_ALL / LC_CTYPE / LANG. The VS Code extension
 * host can inherit an env with NO UTF-8 locale — notably when VS Code is launched
 * from Windows into WSL, the login shell's LANG never reaches the host — so tmux
 * runs 8-bit and mangles multibyte output (the mojibake you get copying from a
 * pane). This returns the locale vars to FORCE UTF-8, but ONLY when the inherited
 * env doesn't already declare one — we never override a UTF-8 locale the user has.
 * C.UTF-8 is the always-present UTF-8 locale on Linux/WSL; en_US.UTF-8 on macOS.
 * Returns {} (a no-op) for an already-UTF-8 env, so well-configured hosts are
 * untouched. Merge into the exec/spawn/terminal env at the boundary.
 */
export function utf8LocaleEnv(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const isUtf8 = (v?: string) => !!v && /utf-?8/i.test(v);
  if (isUtf8(base.LC_ALL) || isUtf8(base.LC_CTYPE) || isUtf8(base.LANG)) return {};
  const locale = platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  return { LANG: locale, LC_CTYPE: locale };
}

type ExecFileImpl = typeof execFile;

/**
 * t-3da510 — a command that may START the tmux server must not run in the caller's cgroup.
 * The engine daemon lives in a transient systemd unit with KillMode=control-group, and a
 * server forked there is a member of that cgroup for life: every bundle activation (Reload
 * with a version bump) stops the old unit, systemd kills the whole cgroup, the server dies,
 * and every agent pane gets SIGHUP — the "all agents stopped after Reload" failure. Wrapping
 * the server-creating client in its own `systemd-run --user --scope` puts the forked server
 * in a scope that outlives the engine unit; when the server already exists the client just
 * connects and the `--collect` scope evaporates with it. Only `new-session`/`start-server`
 * can create a server (probes like `list-sessions` error out without forking one).
 */
function mayStartServer(args: string[]): boolean {
  return args.includes("new-session") || args.includes("start-server");
}

export function serverScopeUnitName(nonceHex: string): string {
  const nonce = nonceHex.replace(/[^a-f0-9]/gi, "").slice(0, 12) || "x";
  return `tachyon-tmux-${nonce}.scope`;
}

export function serverScopeArgv(tmuxArgs: string[]): { file: string; argv: string[] } {
  const unit = serverScopeUnitName(crypto.randomBytes(6).toString("hex"));
  return {
    file: "systemd-run",
    argv: ["--user", "--scope", "--collect", "--quiet", `--unit=${unit}`, "--", "tmux", ...tmuxArgs],
  };
}

/** Fail-open: when user systemd is unusable (no bus, no binary) fall back to a plain exec. */
function isScopeLaunchFailure(err: Error & { code?: unknown }, stderr: string): boolean {
  // systemd-run's own failures ("Failed to connect to bus", "Failed to connect to user scope bus
  // via local transport", "Failed to start transient scope unit") — never tmux's, whose errors
  // name sessions/servers, not the bus. Phrasing varies across systemd versions, so match loosely.
  return err.code === "ENOENT" || /Failed to .*\b(?:bus|transient)\b/i.test(stderr || err.message);
}

/** Only missing binary is process-lifetime permanent. Bus/transient unit races must not poison
 *  the probe — under verify:full concurrent systemd-run load they flake (t-5f6355 / t-ed5c25).
 *  Persistent bus-down hosts use a cooldown circuit-breaker instead (t-7d0fd8). */
function isPermanentScopeUnavailable(err: Error & { code?: unknown }): boolean {
  return err.code === "ENOENT";
}

/** One immediate retry after a short backoff when the user bus flaps under load. */
export const SERVER_SCOPE_RETRY_BACKOFF_MS = 25;
/** After this many call-level transient failures, skip systemd-run for a cooldown window. */
export const SERVER_SCOPE_TRANSIENT_FAILS_BEFORE_COOLDOWN = 2;
/** Cooldown length before the next probe (ms). */
export const SERVER_SCOPE_COOLDOWN_MS = 2_000;

let serverScopeUsable: boolean | undefined;
/** Consecutive server-creating calls that exhausted scope and fell back due to transient errors. */
let scopeTransientFailStreak = 0;
/** Epoch ms until which we skip systemd-run probes (circuit open). */
let scopeCooldownUntilMs = 0;

export type TmuxExecutorHooks = {
  /** Test seam: inject clock (default Date.now). */
  now?: () => number;
  /** Test seam: inject backoff sleep (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
};

let scopeHooks: TmuxExecutorHooks = {};

function scopeNow(): number {
  return (scopeHooks.now ?? Date.now)();
}

function scopeSleep(ms: number): Promise<void> {
  const sleep = scopeHooks.sleep;
  if (sleep) return sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function noteScopeSuccess(): void {
  serverScopeUsable = true;
  scopeTransientFailStreak = 0;
  scopeCooldownUntilMs = 0;
}

function noteTransientScopeExhausted(): void {
  scopeTransientFailStreak += 1;
  if (scopeTransientFailStreak >= SERVER_SCOPE_TRANSIENT_FAILS_BEFORE_COOLDOWN) {
    scopeCooldownUntilMs = scopeNow() + SERVER_SCOPE_COOLDOWN_MS;
  }
}

function scopeProbeAllowed(): boolean {
  if (serverScopeUsable === false) return false;
  if (scopeNow() < scopeCooldownUntilMs) return false;
  return true;
}

/** Test seam: forget the cached systemd-run availability verdict + circuit state. */
export function resetServerScopeProbeForTests(hooks?: TmuxExecutorHooks): void {
  serverScopeUsable = undefined;
  scopeTransientFailStreak = 0;
  scopeCooldownUntilMs = 0;
  scopeHooks = hooks ?? {};
}

export function createTmuxExecutor(
  execFileImpl: ExecFileImpl = execFile,
  hooks?: TmuxExecutorHooks,
): TmuxExecutor {
  if (hooks) scopeHooks = { ...scopeHooks, ...hooks };
  return (args: string[], options: TmuxExecOptions = {}): Promise<ExecResult> =>
    new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs;
      const controller = timeoutMs !== undefined ? new AbortController() : undefined;
      let settled = false;
      let child: ChildProcess | undefined;
      let transientScopeAttempts = 0;
      const command = ["tmux", ...isolatedArgs(args)].join(" ");
      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              controller?.abort();
              child?.stdout?.resume();
              child?.stderr?.resume();
              child?.kill("SIGTERM");
              reject(new TmuxError(`tmux ${options.op ?? "operation"} timed out after ${timeoutMs}ms: ${command}`, args));
            }, timeoutMs)
          : undefined;

      const wantScope =
        process.platform === "linux" && scopeProbeAllowed() && mayStartServer(args);

      const finish = (err: Error | null, stdout: string, stderr: string): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) {
          reject(new TmuxError(stderr.trim() || err.message, args));
        } else {
          resolve({ stdout, stderr });
        }
      };

      const launch = (useScope: boolean): void => {
        const isolated = isolatedArgs(args);
        const target = useScope ? serverScopeArgv(isolated) : { file: "tmux", argv: isolated };
        child = execFileImpl(
          target.file,
          target.argv,
          { encoding: "utf8", env: { ...process.env, ...utf8LocaleEnv() }, signal: controller?.signal },
          (err, stdout, stderr) => {
            if (settled) return;
            if (err && useScope && isScopeLaunchFailure(err, stderr)) {
              if (isPermanentScopeUnavailable(err)) {
                serverScopeUsable = false;
                launch(false);
                return;
              }
              // Transient bus / unit race: one retry with backoff + fresh unit, then plain exec
              // for this call only. Repeated call-level failures open a short cooldown so a host
              // without a user bus does not pay 2× systemd-run on every new-session (t-7d0fd8).
              if (transientScopeAttempts < 1) {
                transientScopeAttempts += 1;
                void scopeSleep(SERVER_SCOPE_RETRY_BACKOFF_MS).then(() => {
                  if (settled) return;
                  launch(true);
                });
                return;
              }
              noteTransientScopeExhausted();
              launch(false);
              return;
            }
            // systemd-run itself succeeded (tmux may still error, e.g. duplicate session).
            if (useScope) noteScopeSuccess();
            finish(err, stdout, stderr);
          },
        );
      };
      launch(wantScope);
    });
}

export const defaultExecutor: TmuxExecutor = createTmuxExecutor();

/** Stable short hash of the workspace path — namespaces sessions per workspace. */
export function workspaceHash(workspacePath: string): string {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 8);
}

export function sessionName(wsHash: string, agent: string): string {
  return `${SESSION_PREFIX}-${wsHash}-${agent}`;
}

export function tmuxOpName(args: string[]): string {
  if (args.includes("new-session")) return "new-session";
  if (args.includes("respawn-pane")) return "respawn-pane";
  return args.find((arg) => arg !== ";") ?? "operation";
}

export function timeoutForTmuxArgs(args: string[]): number {
  // new-session and respawn-pane both start a pane process — use the longer budget.
  if (args.includes("new-session") || args.includes("respawn-pane")) return TMUX_SESSION_CREATE_TIMEOUT_MS;
  const op = tmuxOpName(args);
  if (op === "capture-pane" || op === "list-sessions" || op === "list-panes" || op === "list-clients") return TMUX_CAPTURE_TIMEOUT_MS;
  return TMUX_CONTROL_TIMEOUT_MS;
}

/** Inverse of sessionName for this workspace; returns the managed-entry name, or null when the session belongs elsewhere. */
export function agentFromSession(wsHash: string, session: string): string | null {
  const prefix = `${SESSION_PREFIX}-${wsHash}-`;
  return session.startsWith(prefix) ? session.slice(prefix.length) : null;
}

export type DoctorResult =
  | { ok: true; version: string }
  | { ok: false; reason: "native-windows" | "tmux-missing" | "tmux-too-old"; message: string };

export interface DoctorEnv {
  platform: NodeJS.Platform;
  isWsl: boolean;
  tmuxVersion: () => Promise<string | null>;
}

export function detectWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

export function parseTmuxVersion(versionOutput: string): number | null {
  // e.g. "tmux 3.6", "tmux 3.2a", "tmux next-3.4"
  const m = versionOutput.match(/(\d+\.\d+)/);
  return m ? Number.parseFloat(m[1]) : null;
}

const INSTALL_HINTS: Record<string, string> = {
  wsl: "Install it inside your WSL distro: sudo apt install tmux",
  linux: "Install it with your package manager, e.g.: sudo apt install tmux",
  darwin: "Install it with Homebrew: brew install tmux",
};

export async function doctor(env?: Partial<DoctorEnv>): Promise<DoctorResult> {
  const platform = env?.platform ?? process.platform;
  const isWsl = env?.isWsl ?? detectWsl();

  if (platform === "win32") {
    return {
      ok: false,
      reason: "native-windows",
      message:
        "Tachyon requires tmux and does not support native Windows. " +
        "Open this workspace through WSL (VSCode Remote - WSL) and install tmux there.",
    };
  }

  const getVersion =
    env?.tmuxVersion ??
    (async () => {
      try {
        const { stdout } = await defaultExecutor(["-V"]);
        return stdout.trim();
      } catch {
        return null;
      }
    });

  const versionOutput = await getVersion();
  if (versionOutput === null) {
    const hint = isWsl ? INSTALL_HINTS.wsl : platform === "darwin" ? INSTALL_HINTS.darwin : INSTALL_HINTS.linux;
    return {
      ok: false,
      reason: "tmux-missing",
      message: `Tachyon requires tmux, which was not found on PATH. ${hint}`,
    };
  }

  const version = parseTmuxVersion(versionOutput);
  if (version === null || version < MIN_TMUX_VERSION) {
    return {
      ok: false,
      reason: "tmux-too-old",
      message: `Tachyon requires tmux >= ${MIN_TMUX_VERSION} (found "${versionOutput}"). Please upgrade tmux.`,
    };
  }

  return { ok: true, version: versionOutput };
}

/**
 * Wedged-server detection (field incident, 2026-06-12): a tmux server can get
 * stuck in a busy loop — alive on the socket, accepting connections, failing
 * every command with "server exited unexpectedly". (Seen on tmux 3.6a/WSL2
 * after the editor window holding the control-mode client was closed abruptly;
 * upstream has a history of this class.) The normal dead-server fallback can't
 * heal it because the socket is still HELD — only killing the stuck process
 * and removing the socket lets the next call boot a fresh server.
 */
export type ServerProbe =
  | { state: "healthy" }
  | { state: "no-server" }
  | { state: "wedged"; pids: number[] };

/** Where tmux puts the socket for this name: $TMUX_TMPDIR (or /tmp) /tmux-<uid>/<name>. */
export function socketPath(
  socket: string = SOCKET_NAME,
  env: NodeJS.ProcessEnv = process.env,
  uid: number = process.getuid?.() ?? 0,
): string {
  const base = (env.TMUX_TMPDIR || "/tmp").replace(/\/+$/, "");
  return `${base}/tmux-${uid}/${socket}`;
}

const WEDGE_RE = /server exited|lost server/i;
const CLEAN_DOWN_RE = /no server running|error connecting|no such file/i;

export interface ProbeOptions {
  exec?: TmuxExecutor;
  socket?: string;
  /** consecutive failures required before declaring a wedge (default 3) */
  attempts?: number;
  delayMs?: number;
  /** test seams */
  socketExists?: () => boolean;
  findPids?: () => Promise<number[]>;
  sleep?: (ms: number) => Promise<void>;
}

/** Classifies the dedicated server socket: healthy, cleanly down, or wedged (zombie). */
export async function probeServer(opts: ProbeOptions = {}): Promise<ServerProbe> {
  const exec = opts.exec ?? defaultExecutor;
  const socket = opts.socket ?? SOCKET_NAME;
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const exists = opts.socketExists ?? (() => fs.existsSync(socketPath(socket)));

  let wedgeHits = 0;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(opts.delayMs ?? 250);
    try {
      await exec(["-L", socket, "list-sessions"]);
      return { state: "healthy" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (CLEAN_DOWN_RE.test(msg)) return { state: "no-server" }; // normal "not running"
      if (WEDGE_RE.test(msg)) {
        wedgeHits++;
        continue;
      }
      return { state: "healthy" }; // any other (semantic) reply means the server answered
    }
  }
  if (wedgeHits === attempts && exists()) {
    const pids = await (opts.findPids ?? (() => findServerPids(socket)))();
    return { state: "wedged", pids };
  }
  return { state: "no-server" }; // died for real between checks
}

/** PIDs of tmux processes bound to this socket (exact `-L <name>` argv match). */
export async function findServerPids(
  socket: string = SOCKET_NAME,
  runPs: () => Promise<string> = defaultPs,
): Promise<number[]> {
  const out = await runPs();
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const argv = m[2].trim().split(/\s+/);
    if (!/(^|\/)tmux/.test(argv[0] ?? "")) continue;
    const li = argv.indexOf("-L");
    if (li >= 0 && argv[li + 1] === socket) pids.push(Number(m[1]));
  }
  return pids;
}

function defaultPs(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-eo", "pid=,args="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

/**
 * spec 217 — best-effort `ps` snapshot of the wedged server's PIDs (CPU/RSS/elapsed/state),
 * logged before recovery so the upstream tmux wedge can eventually be root-caused. Never throws —
 * returns "" on any failure (diagnostics must not block recovery).
 */
export function snapshotServerPids(
  pids: number[],
  runPs: (pids: number[]) => Promise<string> = defaultPsForPids,
): Promise<string> {
  if (pids.length === 0) return Promise.resolve("");
  return runPs(pids).catch(() => "");
}

function defaultPsForPids(pids: number[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-o", "pid,%cpu,rss,etime,stat,cmd", "-p", pids.join(",")],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

export interface RecoverOptions {
  pids: number[];
  socket?: string;
  /** test seams */
  kill?: (pid: number) => void;
  removeSocket?: () => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Kills a wedged server's processes (SIGKILL — it stopped answering long ago)
 * and removes the stale socket so the next tmux call boots a fresh server.
 * Sessions on the wedged server were already unreachable; nothing live is lost.
 */
export async function recoverWedgedServer(opts: RecoverOptions): Promise<void> {
  const kill =
    opts.kill ??
    ((pid: number) => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    });
  const removeSocket =
    opts.removeSocket ??
    (() => {
      try {
        fs.rmSync(socketPath(opts.socket ?? SOCKET_NAME), { force: true });
      } catch {
        /* fine — tmux unlinks stale sockets itself when it can */
      }
    });
  for (const pid of opts.pids) kill(pid);
  await (opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(300);
  removeSocket();
}

export interface NewSessionOptions {
  name: string;
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Restart a command inside an existing pane (t-4d2630).
 * `target` is the session name; the pane is addressed as `=target:`.
 */
export interface RespawnPaneOptions {
  target: string;
  cmd: string;
  cwd?: string;
  /**
   * Desired launch env for the respawned process. When provided, the session
   * environment is synced to match: keys present on the session but absent here
   * are unset (`set-environment -u`) before the remaining keys are set. Omit to
   * leave session env untouched (bare `respawn-pane -k`).
   */
  env?: Record<string, string>;
}

/**
 * Parse `tmux show-environment` stdout into currently-set variable names.
 * Lines prefixed with `-` are removal markers (not live values) and are skipped.
 */
export function parseSessionEnvironmentKeys(stdout: string): string[] {
  const keys: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line || line.startsWith("-")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    keys.push(line.slice(0, eq));
  }
  return keys;
}

/**
 * Read ONE variable out of `tmux show-environment` stdout.
 *
 * Lines prefixed with `-` are removal markers, not values, and a variable marked removed must read as
 * ABSENT rather than as its stale value — otherwise an unset attestation would still look present.
 */
export function parseSessionEnvironmentValue(stdout: string, key: string): string | undefined {
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("-")) {
      if (line.slice(1) === key) return undefined;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    if (line.slice(0, eq) === key) return line.slice(eq + 1);
  }
  return undefined;
}

/** Options for capturePane (t-24e0f8). A bare number is still accepted as `lines`. */
export interface CapturePaneOptions {
  /** Reach this many lines back into scrollback (`-S -N`). */
  lines?: number;
  /**
   * Join soft-wrapped screen lines into logical lines (`capture-pane -J`).
   * Prefer for parsers (read_output, stranded-line, attention). Leave off when
   * visual layout matters (postmortem display, inspector).
   */
  joinWrapped?: boolean;
  /**
   * Preserve ANSI escapes / attributes (`capture-pane -e`). Opt-in for evidence
   * rendering or visual reproduction of TUI state.
   */
  preserveColors?: boolean;
}

/**
 * Tachyon's own sensible defaults for its dedicated server. Because we run
 * config-less (`-f /dev/null`, to keep the user's ~/.tmux.conf — and its
 * resurrect/continuum plugins — off our socket), we inherit raw tmux defaults
 * and must re-supply what an interactive user expects. The user overlays/extends
 * these via settings.tmux in tachyon.yml; `remain-on-exit` stays reserved below.
 */
export const TMUX_DEFAULTS: Record<string, string> = {
  mouse: "on", // wheel scrolls the pane (off => alt-screen apps see arrow keys)
  "focus-events": "on", // agent TUIs (e.g. Claude Code) ask for focus tracking
  "history-limit": "10000", // useful scrollback now that the wheel works
};

/**
 * Initial window size for detached new-session (no client attached yet).
 * Bare tmux defaults to 80×24 — cramped for agent TUIs, wraps long prompt lines
 * (breaks looksLikeStrandedSubmittedLine, which only checks the last line), and
 * degrades capture-pane / probe / read_output fidelity. When a real client
 * attaches, window-size follows the client as usual (tmux ≥ 3.2). t-ae452f.
 */
export const DETACHED_SESSION_WIDTH = 220;
export const DETACHED_SESSION_HEIGHT = 50;

/**
 * Short single-line payloads ride `send-keys -l`. Above this length (or any
 * embedded newline) we switch to bracketed paste so `\n` is not Enter and long
 * briefs are not typed keystroke-by-keystroke (t-17d7ea).
 */
export const SEND_KEYS_LITERAL_MAX_CHARS = 400;

/**
 * t-8d190f — what a submit attempt actually observed. `submitted` means the composer was seen to stop
 * holding the text; `submit-unconfirmed` means Tachyon typed and pressed Enter but never got that
 * evidence, which callers must surface rather than swallow.
 */
export interface SubmitReceipt {
  status: "submitted" | "submit-unconfirmed";
  reason:
    /** The composer no longer holds the text — delivery observed. */
    | "composer-cleared"
    /** No runtime composer profile: the legacy last-line check saw no stranded line. Weak evidence. */
    | "no-stranded-line"
    /** The text is still staged after every retry. This is the reported incident. */
    | "still-staged"
    /** Someone else's content joined ours in the editor; retrying would submit theirs. */
    | "composer-diverged"
    /** A profiled runtime whose composer region never appeared in any capture. */
    | "composer-unreadable"
    /** capture-pane failed, so nothing can be claimed. */
    | "capture-failed";
  /** How many Enter presses were sent (always ≥ 1; the text itself is typed only once). */
  attempts: number;
}

export interface TmuxServiceOptions {
  /** Bound for waiting behind active operations; injectable for deterministic tests. */
  queueWaitTimeoutMs?: number;
}

interface QueuedTmuxOp {
  args: string[];
  grant: () => void;
  op: string;
  reject: (error: TmuxQueueError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** True when text should use load-buffer + paste-buffer -p instead of send-keys -l. */
export function prefersBracketedPaste(text: string): boolean {
  return text.length > SEND_KEYS_LITERAL_MAX_CHARS || /[\n\r]/.test(text);
}

/** Load-bearing — pane_dead_status (crash/exit detection) depends on it; not user-overridable. */
/**
 * Server options Tachyon owns outright — a workspace cannot override these, because both encode a
 * promise the fleet depends on.
 *
 * `remain-on-exit: on` keeps a dead pane readable instead of collapsing the window, which is what
 * makes a crashed agent inspectable after the fact.
 *
 * `exit-empty: off` (t-9713ff) keeps THIS server alive with zero sessions. tmux defaults it to `on`,
 * and on 2026-08-06 the whole fleet plus the coordinator vanished between 13:19 and 13:26 — no OOM in
 * `dmesg`, no systemd scope event, no engine restart, and the socket simply gone and remade. Six
 * suspects were measured and none survived, so the CAUSE is still open (`t-9713ff`). This does not
 * claim to be that cause: with `remain-on-exit on` a dead pane keeps its session, so a server holding
 * sessions should never reach zero. It removes the class anyway. A single server hosting every agent
 * must not be able to end itself as a side effect of arithmetic nobody watches.
 */
const TMUX_RESERVED: Record<string, string> = { "remain-on-exit": "on", "exit-empty": "off" };

export class TmuxService {
  /** Effective server options ensured before every new-session (idempotent). */
  private serverOptions: Record<string, string> = { ...TMUX_DEFAULTS };
  /** spec 219 — absolute path to the UTF-8 clipboard helper; null = restore the OSC 52 default. */
  private clipboardHelper: string | null = null;
  private activeOps = 0;
  private readonly queuedOps: QueuedTmuxOp[] = [];
  private readonly queueWaitTimeoutMs: number;
  private disposed = false;

  constructor(
    private exec: TmuxExecutor = defaultExecutor,
    private readonly socket: string = SOCKET_NAME,
    options: TmuxServiceOptions = {},
  ) {
    this.queueWaitTimeoutMs = options.queueWaitTimeoutMs ?? TMUX_QUEUE_WAIT_TIMEOUT_MS;
  }

  /**
   * Swaps the transport (the F20 control-mode engine plugs in here). The engine's
   * executor embeds its own fallback to the subprocess path, so callers never care.
   */
  useExecutor(exec: TmuxExecutor): void {
    this.exec = exec;
  }

  /**
   * Sets the user's tmux overlay (from settings.tmux). Resolution order:
   * Tachyon defaults < user overlay < reserved. Re-asserted on every new-session,
   * so it survives a server restart (the wedge-recovery or last-session-exit race).
   */
  setServerOptions(userTmux: Record<string, string>): void {
    this.serverOptions = { ...TMUX_DEFAULTS, ...userTmux };
  }

  /**
   * spec 219 — wire (or unwire) clean clipboard copy. When a helper path is given, every
   * new-session boot disables OSC 52 (`set-clipboard off`) and binds copy-mode's mouse-drag-end
   * to pipe the selection through the helper → clean UTF-8 on the OS clipboard, no Shift, mouse
   * stays on (tmux copy-mode auto-scrolls the scrollback natively). null restores the OSC 52 default.
   */
  setClipboardHelper(helperPath: string | null): void {
    this.clipboardHelper = helperPath;
  }

  private async run(args: string[]): Promise<ExecResult> {
    await this.acquireOpSlot(args);
    try {
      return await this.exec(["-L", this.socket, ...args], { timeoutMs: timeoutForTmuxArgs(args), op: tmuxOpName(args) });
    } finally {
      this.releaseOpSlot();
    }
  }

  private acquireOpSlot(args: string[]): Promise<void> {
    const op = tmuxOpName(args);
    if (this.disposed) return Promise.reject(this.disposedError(args, op));
    if (this.activeOps < TMUX_CONTROL_CONCURRENCY) {
      this.activeOps++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: QueuedTmuxOp = {
        args,
        grant: () => {
          clearTimeout(waiter.timer);
          if (this.disposed) {
            reject(this.disposedError(args, op));
            return;
          }
          this.activeOps++;
          resolve();
        },
        op,
        reject,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      waiter.timer = setTimeout(() => {
        const index = this.queuedOps.indexOf(waiter);
        if (index < 0) return;
        this.queuedOps.splice(index, 1);
        reject(
          new TmuxQueueError(
            `tmux ${op} timed out after waiting ${this.queueWaitTimeoutMs}ms for an operation slot; ` +
              "the tmux control path may be stalled. Retry after active operations finish or reload Tachyon.",
            args,
            "TMUX_QUEUE_TIMEOUT",
            op,
            this.queueWaitTimeoutMs,
          ),
        );
      }, this.queueWaitTimeoutMs);
      this.queuedOps.push(waiter);
    });
  }

  private releaseOpSlot(): void {
    this.activeOps = Math.max(0, this.activeOps - 1);
    const next = this.queuedOps.shift();
    if (next) next.grant();
  }

  /** Rejects queued work during extension/workspace teardown; already-running calls release normally. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of this.queuedOps.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(this.disposedError(waiter.args, waiter.op));
    }
  }

  private disposedError(args: string[], op: string): TmuxQueueError {
    return new TmuxQueueError(
      `tmux ${op} was cancelled because TmuxService was disposed; retry after Tachyon finishes reloading.`,
      args,
      "TMUX_SERVICE_DISPOSED",
      op,
    );
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      // "=" prefix forces exact-name match instead of tmux's prefix matching.
      await this.run(["has-session", "-t", `=${name}`]);
      return true;
    } catch (err) {
      if (err instanceof TmuxError && /timed out/i.test(err.message)) throw err;
      return false;
    }
  }

  /**
   * The global server-option + clipboard chain (each entry prefixed with `;`) applied before a
   * new-session AND, idempotently, to a live server on config-apply (spec 220 219-followup). Kept in
   * one place so `newSession` and `applyLiveOptions` can never drift.
   * - remain-on-exit is load-bearing: a dying process leaves a dead pane carrying pane_dead_status
   *   instead of vanishing, so "session gone" = killed, "dead pane" = process died on its own.
   * - spec 219 clipboard: with a helper, disable OSC 52 (mangled on VS-Code-on-Windows) and route
   *   copy-mode's mouse-drag-end through our UTF-8 helper; without one, UNWIND to tmux defaults.
   */
  private serverOptionArgs(): string[] {
    const resolved = { ...this.serverOptions, ...TMUX_RESERVED };
    const args: string[] = [];
    for (const [key, value] of Object.entries(resolved)) {
      args.push(";", "set-option", "-g", key, value);
    }
    if (this.clipboardHelper) {
      // POSIX single-quote the path (spaces, and a literal ' → '\'' ) so the bound `sh '<path>'` is safe.
      const pipe = `sh '${this.clipboardHelper.replace(/'/g, "'\\''")}'`;
      args.push(";", "set-option", "-g", "set-clipboard", "off");
      for (const table of ["copy-mode", "copy-mode-vi"]) {
        args.push(";", "bind-key", "-T", table, "MouseDragEnd1Pane", "send-keys", "-X", "copy-pipe-and-cancel", pipe);
      }
    } else {
      // No helper (opted out / no tool detected): UNWIND unconditionally. set-clipboard and the
      // copy-mode bindings are server-GLOBAL and persist across new-sessions and even a VS Code reload
      // (the `-L tachyon` server outlives the extension host), so we can't rely on process-local memory
      // of whether we wired before (codex r3). Restoring is idempotent — on a never-wired server it just
      // re-asserts tmux defaults — so emit it whenever there's no helper: `set-clipboard` back to the
      // OSC 52 default (unless the user pinned it via settings.tmux) + tmux's TRUE default copy-mode
      // bind, which on tmux 3.6 is `copy-pipe-and-cancel` with NO command (verified via list-keys on a
      // fresh server — codex r4); `copy-selection-and-cancel` would be a different, wrong binding.
      if (!("set-clipboard" in this.serverOptions)) args.push(";", "set-option", "-gu", "set-clipboard");
      for (const table of ["copy-mode", "copy-mode-vi"]) {
        args.push(";", "bind-key", "-T", table, "MouseDragEnd1Pane", "send-keys", "-X", "copy-pipe-and-cancel");
      }
    }
    return args;
  }

  /** True when the dedicated server is already running (has ≥1 session). */
  async hasServer(): Promise<boolean> {
    try {
      await this.run(["list-sessions"]);
      return true;
    } catch {
      return false; // "no server running"
    }
  }

  /**
   * spec 220 (219-followup): re-assert the server options + clipboard wiring on a LIVE server,
   * without creating a session — so updating the extension / changing config + Reload applies the
   * clean-clipboard fix to already-attached agents WITHOUT needing to restart one. Idempotent; a
   * no-op when no server is running (never spins up a phantom empty server).
   */
  async applyLiveOptions(): Promise<void> {
    if (!(await this.hasServer())) return;
    await this.run(["start-server", ...this.serverOptionArgs()]);
  }

  async newSession(opts: NewSessionOptions): Promise<void> {
    // Ensure our server options globally BEFORE the session is created, in the same invocation —
    // race-free even for instantly-dying commands, and re-asserted in case the server restarted.
    const args = ["start-server", ...this.serverOptionArgs()];
    // -x/-y: explicit size while detached (see DETACHED_SESSION_* / t-ae452f).
    args.push(
      ";", "new-session", "-d", "-s", opts.name,
      "-x", String(DETACHED_SESSION_WIDTH),
      "-y", String(DETACHED_SESSION_HEIGHT),
    );
    if (opts.cwd) args.push("-c", opts.cwd);
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      args.push("-e", `${key}=${value}`);
    }
    args.push(opts.cmd);
    try {
      await this.run(args);
    } catch (err) {
      if (isTmuxTimeout(err)) {
        await this.reconcileNewSessionTimeout(opts.name, err);
      }
      // Shutdown race: the server exits when its last session dies; a spawn arriving
      // mid-teardown sees "server exited unexpectedly". One short retry covers it.
      if (err instanceof Error && /server exited|lost server/i.test(err.message)) {
        await new Promise((r) => setTimeout(r, 150));
        await this.run(args);
      } else {
        throw err;
      }
    }
  }

  private async reconcileNewSessionTimeout(name: string, cause: TmuxError): Promise<never> {
    let landed = false;
    try {
      landed = await this.hasSession(name);
    } catch (checkErr) {
      throw new TmuxError(
        `${cause.message}; timed out while creating session '${name}' and could not confirm whether the tmux server completed it. ` +
          `A session named '${name}' may be orphaned; retry only after checking or cleaning it up.`,
        cause.args,
      );
    }
    if (!landed) throw cause;

    try {
      await this.killSession(name);
    } catch (cleanupErr) {
      throw new TmuxError(
        `${cause.message}; session '${name}' was created by the tmux server after the client timed out, but Tachyon could not clean it up. ` +
          `A session named '${name}' may be orphaned; retry only after checking or cleaning it up.`,
        cause.args,
      );
    }
    throw new TmuxError(
      `${cause.message}; session '${name}' was created by the tmux server after the client timed out, so Tachyon cleaned it up before returning.`,
      cause.args,
    );
  }

  /**
   * Liveness per session on this socket: alive, or dead with the process exit code.
   * Sessions whose pane died (remain-on-exit) report `dead: true`.
   *
   * Returns `null` (instead of an empty map) when `list-panes` fails with anything OTHER
   * than a confirmed "no server" condition (same CLEAN_DOWN_RE as probeServer) — a transient
   * error (e.g. racing a concurrent kill/reconcile) is NOT proof that every session vanished,
   * and a caller that can't tell the difference must preserve its prior state rather than
   * treat null as "zero sessions".
   */
  async sessionStates(prefix: string): Promise<Map<string, { dead: boolean; exitCode?: number }> | null> {
    const out = new Map<string, { dead: boolean; exitCode?: number }>();
    try {
      const { stdout } = await this.run([
        "list-panes",
        "-a",
        "-F",
        "#{session_name}\t#{pane_dead}\t#{pane_dead_status}",
      ]);
      for (const line of stdout.split("\n")) {
        const [session, dead, status] = line.split("\t");
        if (!session || !session.startsWith(prefix)) continue;
        const isDead = dead === "1";
        const exitCode = isDead && status !== undefined && status !== "" ? Number.parseInt(status, 10) : undefined;
        out.set(session, { dead: isDead, exitCode: Number.isNaN(exitCode as number) ? undefined : exitCode });
      }
    } catch (err) {
      if (err instanceof Error && CLEAN_DOWN_RE.test(err.message)) return out; // confirmed no server — zero sessions
      return null; // ambiguous error — caller must not treat this as "everyone vanished"
    }
    return out;
  }

  async killSession(name: string): Promise<void> {
    await this.run(["kill-session", "-t", `=${name}`]);
  }

  /**
   * Restart `cmd` in an existing pane via `respawn-pane -k` (t-4d2630).
   *
   * Unlike kill-session + new-session, the session object is preserved: attached
   * clients (e.g. a VS Code terminal running `attach-session`) stay attached, and
   * pre-restart output remains in the pane scrollback. Works on live panes (`-k`
   * kills the current command) and remain-on-exit dead panes; `pane_dead` /
   * `pane_dead_status` semantics stay intact for the next process exit.
   *
   * Env: `new-session -e` only applies at session creation. Before respawn we
   * sync the session environment to the desired launch env so dropped keys cannot
   * leak across restart/resume (regression vs kill+new, which starts a fresh
   * session object). That means:
   * 1. `show-environment -t` → session keys currently set
   * 2. `set-environment -u -t` for each key absent from the desired env
   * 3. `set-environment -t KEY VALUE` for each desired key (name/value are
   *    separate argv tokens — not KEY=value)
   * 4. `respawn-pane -k`
   *
   * If `show-environment` fails we throw rather than set-only respawning: without
   * a reliable snapshot we cannot unset vanished keys, and callers
   * (`AgentManager.startSessionCommand`) already fall back to kill+new.
   *
   * Unsetting only touches the session environment; global/server vars (PATH,
   * HOME, …) still reach the new process. Omit `env` to leave session env alone.
   */
  async respawnPane(opts: RespawnPaneOptions): Promise<void> {
    const sessionTarget = `=${opts.target}`;
    const paneTarget = `${sessionTarget}:`;
    const args: string[] = [];
    if (opts.env !== undefined) {
      const desiredKeys = new Set(Object.keys(opts.env));
      // Fail closed: a missing env snapshot must not degrade to set-only respawn.
      const { stdout } = await this.run(["show-environment", "-t", sessionTarget]);
      for (const key of parseSessionEnvironmentKeys(stdout)) {
        if (desiredKeys.has(key)) continue;
        if (args.length > 0) args.push(";");
        args.push("set-environment", "-u", "-t", sessionTarget, key);
      }
      for (const [key, value] of Object.entries(opts.env)) {
        if (args.length > 0) args.push(";");
        args.push("set-environment", "-t", sessionTarget, key, value);
      }
    }
    if (args.length > 0) args.push(";");
    args.push("respawn-pane", "-k", "-t", paneTarget);
    if (opts.cwd) args.push("-c", opts.cwd);
    args.push(opts.cmd);
    await this.run(args);
  }

  /** Sends a tmux key token such as `C-d` or `C-c` to the session's active pane. */
  async sendKey(name: string, key: string): Promise<void> {
    await this.run(["send-keys", "-t", `=${name}:`, key]);
  }

  /** Sessions on the Tachyon socket starting with `prefix`. Empty when the server isn't running. */
  /**
   * t-fab832 — read one variable from a live session's environment.
   *
   * Returns undefined when the session is gone, the variable was never set, or tmux cannot be
   * reached. Every one of those is "no proof", and the activation gate treats them identically — an
   * unreadable session must not admit on the strength of the read having failed.
   */
  async sessionEnvValue(session: string, key: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.run(["show-environment", "-t", `=${session}`]);
      return parseSessionEnvironmentValue(stdout, key);
    } catch {
      return undefined;
    }
  }

  async listSessions(prefix: string): Promise<string[]> {
    try {
      const { stdout } = await this.run(["list-sessions", "-F", "#{session_name}"]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line.startsWith(prefix));
    } catch {
      // No server running on this socket yet — equivalent to zero sessions.
      return [];
    }
  }

  /**
   * Renames a session in place — works on live sessions AND dead panes
   * (remain-on-exit). Attached clients follow the session object, so an open
   * editor terminal keeps streaming across the rename.
   */
  async renameSession(oldName: string, newName: string): Promise<void> {
    await this.run(["rename-session", "-t", `=${oldName}`, newName]);
  }

  /**
   * Visible pane content by default (the right semantics for full-screen TUI agents);
   * `lines` reaches that many lines back into scrollback history.
   *
   * Options (t-24e0f8):
   * - `joinWrapped` → `-J` joins soft-wrapped screen lines into logical lines (parsers:
   *   read_output, stranded-line, attention, probe). Leave off for postmortem/inspector
   *   where visual layout matters.
   * - `preserveColors` → `-e` keeps ANSI escapes (opt-in evidence / visual fidelity).
   *
   * Second arg still accepts a bare number (legacy `lines`) for call-site compat.
   */
  async capturePane(name: string, linesOrOptions?: number | CapturePaneOptions): Promise<string> {
    const opts: CapturePaneOptions =
      typeof linesOrOptions === "number" ? { lines: linesOrOptions } : (linesOrOptions ?? {});
    // "=name:" — exact session match; trailing colon makes it a valid pane target.
    const args = ["capture-pane", "-p", "-t", `=${name}:`];
    if (opts.joinWrapped) args.push("-J");
    if (opts.preserveColors) args.push("-e");
    if (opts.lines !== undefined) args.push("-S", `-${opts.lines}`);
    const { stdout } = await this.run(args);
    return stdout.replace(/\n+$/, "");
  }

  /**
   * Streams the pane's raw output to `file` via `cat >> file`, run through the pane's own shell
   * (t-6a6a00 — durable per-agent transcripts, survives kill-session/reload; capture-pane does not).
   *
   * Deliberately WITHOUT `-o`: verified empirically against real tmux (3.6) that `-o` is a raw
   * key-binding TOGGLE — a second `-o` call turns an already-active pipe OFF regardless of whether
   * the command matches, which would silently kill the transcript on the very next spawn/restart/
   * resume/fork attach (the tmux(1) wording reads as "only start if not already piping", but that is
   * not what it does; do not "fix" this back to `-o` without re-verifying against a real server).
   * The BARE form (a command, no `-o`) is what's actually idempotent here: called on an already-piping
   * pane it closes the old pipe and reopens the new one with no gap and no data loss (append mode),
   * so calling this unconditionally after every spawn/restart/resume/fork is safe either way.
   */
  async pipePane(opts: { target: string; file: string }): Promise<void> {
    // Single-quote the path for the mini shell command tmux hands to `/bin/sh -c` (mirrors the
    // clipboard-helper quoting above); a literal ' is escaped as '\''.
    const quoted = `'${opts.file.replace(/'/g, "'\\''")}'`;
    await this.run(["pipe-pane", "-t", `=${opts.target}:`, `cat >> ${quoted}`]);
  }

  /** Closes any pipe-pane currently attached to the session. Safe/idempotent when none is attached. */
  async unpipePane(target: string): Promise<void> {
    await this.run(["pipe-pane", "-t", `=${target}:`]);
  }

  /**
   * Resize the session's window to cols×rows (layer-2 agent pane FitAddon).
   * Used when a first-party viewport owns geometry instead of a VS Code terminal client.
   */
  async resizeWindow(name: string, cols: number, rows: number): Promise<void> {
    const x = Math.max(2, Math.floor(cols));
    const y = Math.max(1, Math.floor(rows));
    await this.run(["resize-window", "-t", `=${name}:`, "-x", String(x), "-y", String(y)]);
  }

  /** Redraws every client attached to a session (fixes blank panes after hidden attaches). */
  async refreshClients(name: string): Promise<void> {
    try {
      const { stdout } = await this.run(["list-clients", "-t", `=${name}:`, "-F", "#{client_name}"]);
      for (const client of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
        await this.run(["refresh-client", "-t", client]);
      }
    } catch {
      // no clients attached — nothing to refresh
    }
  }

  /**
   * t-edbe36 — clients currently attached to a session (name + size).
   * Used by the Agent Pane to measure a foreign shell co-attach; never detach/kill them.
   */
  async listSessionClients(name: string): Promise<SessionClientInfo[]> {
    try {
      const { stdout } = await this.run([
        "list-clients",
        "-t",
        `=${name}:`,
        "-F",
        "#{client_name}\t#{client_width}\t#{client_height}",
      ]);
      return parseSessionClients(stdout);
    } catch {
      return [];
    }
  }

  /** PID of the session's active pane root process. */
  async panePid(name: string): Promise<number> {
    const { stdout } = await this.run(["display-message", "-p", "-t", `=${name}:`, "#{pane_pid}"]);
    const pid = Number.parseInt(stdout.trim(), 10);
    if (Number.isNaN(pid)) throw new TmuxError(`cannot resolve pane pid for ${name}`, []);
    return pid;
  }

  /**
   * Delivers literal text into a pane. Short single-line payloads ride
   * `send-keys -l` (keystroke stream). Multiline or long payloads use
   * `load-buffer` + `paste-buffer -p` (bracketed paste) so embedded newlines
   * do not act as Enter and large briefs are not typed char-by-char (t-17d7ea).
   * `submit` still appends Enter (C-m) as a separate key event.
   */
  async sendKeys(name: string, text: string, submit: boolean): Promise<void> {
    if (text.length > 0) {
      if (prefersBracketedPaste(text)) {
        await this.pasteLiteral(name, text);
      } else {
        await this.run(["send-keys", "-t", `=${name}:`, "-l", "--", text]);
      }
    }
    if (submit) {
      await this.run(["send-keys", "-t", `=${name}:`, "C-m"]);
    }
  }

  /**
   * Bracketed paste of arbitrary text via a private paste buffer (t-17d7ea).
   * Temp file + load-buffer avoids argv size / quoting limits and keeps control-mode
   * lineSafe (no embedded newlines in the tmux argv).
   */
  private async pasteLiteral(name: string, text: string): Promise<void> {
    const buf = `tachyon-paste-${crypto.randomBytes(8).toString("hex")}`;
    const tmp = path.join(os.tmpdir(), `${buf}.txt`);
    await fs.promises.writeFile(tmp, text, "utf8");
    try {
      await this.run(["load-buffer", "-b", buf, tmp]);
      // -p = bracketed paste; -d = delete buffer after paste
      await this.run(["paste-buffer", "-p", "-d", "-b", buf, "-t", `=${name}:`]);
    } catch (err) {
      try {
        await this.run(["delete-buffer", "-b", buf]);
      } catch {
        /* buffer may already be gone */
      }
      throw err;
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  }

  /**
   * Sends one semantic notice line and submits it. Unlike raw sendKeys(..., true), this
   * gives the recipient TUI a short beat before Enter and retries only when capture
   * suggests the line has not left the composer.
   *
   * t-8d190f — this used to return `void`, so every caller's "submitted" receipt asserted a delivery
   * nobody had observed. It now returns what it actually saw. The confirmation is that the composer
   * stopped holding the text; a runtime that never gives us that evidence yields `submit-unconfirmed`
   * rather than silence, because the incident this fixes was a line sitting staged in the composer
   * while notify_agent reported success.
   *
   * Pass `composer` (the runtime's measured profile) to get real confirmation. Without it the old
   * last-line heuristic still runs, but its verdict is reported honestly as unconfirmed instead of
   * being laundered into success — that heuristic cannot see a framed or furniture-trailed composer,
   * which is precisely how the bug escaped.
   */
  async sendSubmittedLine(
    name: string,
    text: string,
    options: { delayMs?: number; submitRetries?: number; composer?: ComposerRegionProfile } = {},
  ): Promise<SubmitReceipt> {
    const delayMs = options.delayMs ?? 180;
    const submitRetries = options.submitRetries ?? 3;
    const composer = options.composer;
    // Typed EXACTLY once, before the loop. Every retry below sends a bare Enter and never text, so a
    // retried submit cannot duplicate the line or concatenate itself onto whatever else is staged.
    await this.sendKeys(name, text, false);
    if (delayMs > 0) await sleep(delayMs);

    let lastState: ComposerSubmissionState | "no-profile" = composer ? "unreadable" : "no-profile";
    for (let attempt = 0; attempt <= submitRetries; attempt++) {
      await this.sendKey(name, "C-m");
      if (delayMs > 0) await sleep(delayMs);
      let pane = "";
      try {
        // -J: the composer check is logical-line based; soft wraps at pane width would
        // otherwise only inspect the last visual fragment (t-24e0f8 / t-ae452f).
        // Colours are preserved so the t-6ffa13 history-echo rule can tell the live editor from
        // the runtime's echo of the line we just submitted.
        pane = await this.capturePane(name, { joinWrapped: true, preserveColors: composer !== undefined });
      } catch {
        // An unobservable pane proves nothing. Saying so is the point of this task.
        return { status: "submit-unconfirmed", reason: "capture-failed", attempts: attempt + 1 };
      }

      if (composer) {
        lastState = classifyComposerSubmission(pane, composer, text);
        if (lastState === "cleared") return { status: "submitted", reason: "composer-cleared", attempts: attempt + 1 };
        // Someone typed while we were submitting. Another Enter would submit THEIR text, so stop here
        // and report it — protecting the other draft matters more than landing our line.
        if (lastState === "diverged") return { status: "submit-unconfirmed", reason: "composer-diverged", attempts: attempt + 1 };
        // "holds-text": our line, alone, still in the editor. A lost Enter — press it again.
        if (lastState === "holds-text") continue;
      }

      // Either the runtime declares no composer, or this capture shows no composer region at all (a
      // pane still booting, an editor not rendered yet). There is no composer evidence to read, so
      // defer to the older check instead of inventing a verdict: calling every such pane
      // "unconfirmed" would flip behaviour far outside the measured bug.
      if (!looksLikeStrandedSubmittedLine(stripAnsi(pane), text)) {
        return { status: "submitted", reason: "no-stranded-line", attempts: attempt + 1 };
      }
    }
    // Out of retries with the line never observed to leave. `composer-unreadable` distinguishes "the
    // profiled editor never appeared, and the legacy check kept calling the line stranded" from
    // "we watched our text sit in the editor the whole time".
    return {
      status: "submit-unconfirmed",
      reason: lastState === "unreadable" ? "composer-unreadable" : "still-staged",
      attempts: submitRetries + 1,
    };
  }

  /**
   * One-shot structured snapshot of every pane on this socket — the data layer
   * behind the server inspector. A single `list-panes -a` call (no per-session
   * round-trips); empty when the server isn't running. `prefix` filters to our
   * namespace (`tachyon-`); pass "" for the whole socket.
   */
  async serverSnapshot(prefix: string = SESSION_PREFIX): Promise<PaneSnapshot[]> {
    try {
      const fmt = [
        "#{session_name}",
        "#{window_index}",
        "#{pane_index}",
        "#{pane_pid}",
        "#{pane_dead}",
        "#{pane_dead_status}",
        "#{pane_current_command}",
        "#{pane_start_command}",
        "#{session_created}",
      ].join("\t");
      const { stdout } = await this.run(["list-panes", "-a", "-F", fmt]);
      const rows: PaneSnapshot[] = [];
      for (const line of stdout.split("\n")) {
        if (line.trim().length === 0) continue;
        const [session, win, pane, pid, dead, status, cur, start, created] = line.split("\t");
        if (!session || (prefix && !session.startsWith(prefix))) continue;
        const isDead = dead === "1";
        const exit = isDead && status !== undefined && status !== "" ? Number.parseInt(status, 10) : undefined;
        const createdAt = created !== undefined && created !== "" ? Number.parseInt(created, 10) : undefined;
        rows.push({
          session,
          window: Number.parseInt(win ?? "0", 10) || 0,
          pane: Number.parseInt(pane ?? "0", 10) || 0,
          pid: Number.parseInt(pid ?? "0", 10) || 0,
          dead: isDead,
          exitCode: Number.isNaN(exit as number) ? undefined : exit,
          currentCommand: cur ?? "",
          startCommand: start ?? "",
          createdAt: Number.isNaN(createdAt as number) ? undefined : createdAt,
        });
      }
      return rows;
    } catch {
      // no server running — empty snapshot
      return [];
    }
  }
}

export function looksLikeStrandedSubmittedLine(pane: string, text: string): boolean {
  const wanted = text.trim();
  if (!wanted) return false;
  const lines = pane.replace(/\s+$/u, "").split("\n").map((line) => line.trimEnd());
  const lastMeaningful = [...lines].reverse().find((line) => line.trim().length > 0);
  if (!lastMeaningful) return false;
  const trimmed = lastMeaningful.trim();
  if (!/^[>❯›]\s*/u.test(trimmed)) return false;
  const normalized = trimmed.replace(/^[>❯›]\s*/u, "");
  return normalized === wanted;
}
