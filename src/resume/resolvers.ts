import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeClaudeCwd, type ResumeRuntime } from "./adapters.js";

/**
 * Capture-runtime session-id resolvers (spec 209 / F29 task 6): for runtimes that
 * mint their own id, find the newest on-disk session whose recorded working
 * directory matches a Tachyon agent's cwd. Pure-ish: home dir is injectable so the
 * disk layout can be exercised against a fixture tree in tests.
 *
 * Mint runtimes (claude/gemini) never reach here — their id is known at spawn.
 */

export interface ResolverEnv {
  home: string;
}

const defaultEnv = (): ResolverEnv => ({ home: os.homedir() });

/** Newest-first list of files under `dir` (recursively) whose name matches `re`. */
function findFiles(dir: string, re: RegExp): string[] {
  const out: { p: string; mtime: number }[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (re.test(e.name)) {
        try {
          out.push({ p, mtime: fs.statSync(p).mtimeMs });
        } catch {
          /* vanished */
        }
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => b.mtime - a.mtime).map((f) => f.p);
}

/** Codex: `~/.codex/sessions/**​/rollout-<ts>-<uuid>.jsonl`; first line is session_meta with `cwd`. */
export function resolveCodexId(cwd: string, env = defaultEnv()): string | null {
  const root = path.join(env.home, ".codex", "sessions");
  for (const file of findFiles(root, /^rollout-.*\.jsonl$/)) {
    try {
      const firstLine = fs.readFileSync(file, "utf8").split("\n", 1)[0];
      const meta = JSON.parse(firstLine) as { type?: string; payload?: { id?: string; cwd?: string } };
      if (meta.type === "session_meta" && meta.payload?.cwd === cwd && meta.payload.id) {
        return meta.payload.id;
      }
    } catch {
      /* skip unreadable/partial rollout */
    }
  }
  return null;
}

/** OpenCode: project store maps worktree→hash; session ids are `ses_*` under that hash. */
export function resolveOpencodeId(cwd: string, env = defaultEnv()): string | null {
  const base = path.join(env.home, ".local", "share", "opencode", "storage");
  const projectDir = path.join(base, "project");
  let hash: string | null = null;
  try {
    for (const f of fs.readdirSync(projectDir)) {
      if (!f.endsWith(".json")) continue;
      const proj = JSON.parse(fs.readFileSync(path.join(projectDir, f), "utf8")) as { id?: string; worktree?: string };
      if (proj.worktree === cwd && proj.id) {
        hash = proj.id;
        break;
      }
    }
  } catch {
    return null;
  }
  if (!hash) return null;
  const sessions = findFiles(path.join(base, "session", hash), /^ses_.*\.json$/);
  if (sessions.length === 0) return null;
  return path.basename(sessions[0], ".json"); // newest ses_* id
}

/**
 * claude (spec 212 / A3): the session the agent is CURRENTLY in for a cwd = the newest
 * `*.jsonl` by mtime under `~/.claude/projects/<encodeClaudeCwd(cwd)>/`. Used to refresh
 * ownership at stop so an in-TUI `/resume` is followed. (Mint runtimes pin their id at
 * spawn and otherwise never re-read disk — this is the ownership-refresh path.)
 */
export function resolveClaudeId(cwd: string, env = defaultEnv()): string | null {
  const dir = path.join(env.home, ".claude", "projects", encodeClaudeCwd(cwd));
  const files = findFiles(dir, /\.jsonl$/);
  return files.length > 0 ? path.basename(files[0], ".jsonl") : null;
}

/**
 * claude (spec 220): resolve the REAL session uuid for a Tachyon-named session, by matching the
 * jsonl header's `customTitle` against the name we spawned with (`-n <title>`). The jsonl is named
 * by claude's own uuid; its first line is `{customTitle, sessionId, type}`. Because each agent's
 * title is unique, this is unambiguous EVEN when many claude agents share one cwd — the exact case
 * that defeated the newest-by-cwd `resolveClaudeId` (its caller's ambiguity gate). Returns the
 * newest matching `sessionId` (uuid), or null if no transcript carries that title yet.
 */
export function resolveClaudeIdByTitle(cwd: string, title: string, env = defaultEnv()): string | null {
  const dir = path.join(env.home, ".claude", "projects", encodeClaudeCwd(cwd));
  for (const file of findFiles(dir, /\.jsonl$/)) {
    // findFiles is newest-first, so the first title match is the most recent session.
    try {
      const firstLine = fs.readFileSync(file, "utf8").split("\n", 1)[0];
      const head = JSON.parse(firstLine) as { customTitle?: string; sessionId?: string };
      if (head.customTitle === title && head.sessionId) return head.sessionId;
    } catch {
      /* skip unreadable/partial transcript */
    }
  }
  return null;
}

/**
 * spec 212 / A3 — the session a cwd is CURRENTLY owned by, where derivable from disk:
 * claude (newest transcript), codex/opencode (the capture resolvers, already newest-by-cwd).
 * gemini (project dir not derivable from cwd), qwen (`--continue`, no id) and continue (no
 * documented map) return null → those agents keep their stored id (no wrong guess).
 */
export async function resolveCurrentSession(
  runtime: ResumeRuntime,
  cwd: string,
  env = defaultEnv(),
  title?: string,
): Promise<string | null> {
  switch (runtime) {
    case "claude":
      // spec 220: with a Tachyon-minted title, resolve the exact uuid by customTitle (unambiguous
      // across a shared cwd). Without one (legacy/in-TUI /resume), fall back to newest-by-cwd.
      return title ? resolveClaudeIdByTitle(cwd, title, env) : resolveClaudeId(cwd, env);
    case "codex":
      return resolveCodexId(cwd, env);
    case "opencode":
      return resolveOpencodeId(cwd, env);
    default:
      return null; // gemini / qwen / continue — not derivable; keep the stored id
  }
}

/** Dispatch by runtime. Returns null for unsupported/unresolved (caller falls back). */
export async function resolveCaptureId(runtime: ResumeRuntime, cwd: string, env = defaultEnv()): Promise<string | null> {
  switch (runtime) {
    case "codex":
      return resolveCodexId(cwd, env);
    case "opencode":
      return resolveOpencodeId(cwd, env);
    // qwen (sessions in the working dir) and continue (no documented on-disk map)
    // are not yet resolved from disk — they resume only when an id was captured at
    // runtime. Tracked for a later pass.
    default:
      return null;
  }
}
