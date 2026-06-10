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

export class TmuxError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
  ) {
    super(message);
    this.name = "TmuxError";
  }
}

export function defaultExecutor(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf8" }, (err, stdout, stderr) => {
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

export interface NewSessionOptions {
  name: string;
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
}

export class TmuxService {
  constructor(
    private readonly exec: TmuxExecutor = defaultExecutor,
    private readonly socket: string = SOCKET_NAME,
  ) {}

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
    const args = ["new-session", "-d", "-s", opts.name];
    if (opts.cwd) args.push("-c", opts.cwd);
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      args.push("-e", `${key}=${value}`);
    }
    args.push(opts.cmd);
    await this.run(args);
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
}
