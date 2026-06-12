import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

/** Dedicated tmux server socket — isolates Tachyon from the user's own tmux server and ~/.tmux.conf sessions. */
export const SOCKET_NAME = "tachyon";
export const SESSION_PREFIX = "tachyon";
/** new-session -e (per-session env) requires tmux >= 3.2. */
export const MIN_TMUX_VERSION = 3.2;

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Executes a tmux invocation with the given args (socket flag is prepended by the service). */
export type TmuxExecutor = (args: string[]) => Promise<ExecResult>;

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

export function defaultExecutor(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile("tmux", isolatedArgs(args), { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        reject(new TmuxError(stderr.trim() || err.message, args));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** Stable short hash of the workspace path — namespaces sessions per workspace. */
export function workspaceHash(workspacePath: string): string {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 8);
}

export function sessionName(wsHash: string, agent: string): string {
  return `${SESSION_PREFIX}-${wsHash}-${agent}`;
}

/** Inverse of sessionName for this workspace; null when the session belongs elsewhere. */
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

export class TmuxService {
  constructor(
    private exec: TmuxExecutor = defaultExecutor,
    private readonly socket: string = SOCKET_NAME,
  ) {}

  /**
   * Swaps the transport (the F20 control-mode engine plugs in here). The engine's
   * executor embeds its own fallback to the subprocess path, so callers never care.
   */
  useExecutor(exec: TmuxExecutor): void {
    this.exec = exec;
  }

  private run(args: string[]): Promise<ExecResult> {
    return this.exec(["-L", this.socket, ...args]);
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      // "=" prefix forces exact-name match instead of tmux's prefix matching.
      await this.run(["has-session", "-t", `=${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  async newSession(opts: NewSessionOptions): Promise<void> {
    // remain-on-exit (set globally on our dedicated server BEFORE the session is
    // created, in the same invocation — race-free even for instantly-dying
    // commands): a dying process leaves a dead pane carrying pane_dead_status
    // instead of vanishing. Intentional kills remove the whole session, so
    // "session gone" = killed, "dead pane" = process died on its own.
    const args = ["start-server", ";", "set-option", "-g", "remain-on-exit", "on", ";", "new-session", "-d", "-s", opts.name];
    if (opts.cwd) args.push("-c", opts.cwd);
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      args.push("-e", `${key}=${value}`);
    }
    args.push(opts.cmd);
    try {
      await this.run(args);
    } catch (err) {
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

  /**
   * Liveness per session on this socket: alive, or dead with the process exit code.
   * Sessions whose pane died (remain-on-exit) report `dead: true`.
   */
  async sessionStates(prefix: string): Promise<Map<string, { dead: boolean; exitCode?: number }>> {
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
    } catch {
      // no server running — zero sessions
    }
    return out;
  }

  async killSession(name: string): Promise<void> {
    await this.run(["kill-session", "-t", `=${name}`]);
  }

  /** Sessions on the Tachyon socket starting with `prefix`. Empty when the server isn't running. */
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
   */
  async capturePane(name: string, lines?: number): Promise<string> {
    // "=name:" — exact session match; trailing colon makes it a valid pane target.
    const args = ["capture-pane", "-p", "-t", `=${name}:`];
    if (lines !== undefined) args.push("-S", `-${lines}`);
    const { stdout } = await this.run(args);
    return stdout.replace(/\n+$/, "");
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

  /** PID of the session's active pane root process. */
  async panePid(name: string): Promise<number> {
    const { stdout } = await this.run(["display-message", "-p", "-t", `=${name}:`, "#{pane_pid}"]);
    const pid = Number.parseInt(stdout.trim(), 10);
    if (Number.isNaN(pid)) throw new TmuxError(`cannot resolve pane pid for ${name}`, []);
    return pid;
  }

  /** Sends literal text; `submit` appends Enter (C-m) as a separate key event. */
  async sendKeys(name: string, text: string, submit: boolean): Promise<void> {
    if (text.length > 0) {
      await this.run(["send-keys", "-t", `=${name}:`, "-l", "--", text]);
    }
    if (submit) {
      await this.run(["send-keys", "-t", `=${name}:`, "C-m"]);
    }
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
