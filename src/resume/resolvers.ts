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
  /**
   * spec 226 (H2) — the claude config home (the dir DIRECTLY containing `projects/`). Defaults to
   * `<home>/.claude`; an isolated-harness agent passes its redirected `CLAUDE_CONFIG_DIR` so the
   * by-title/by-cwd resolvers scan that home's transcripts instead of `~/.claude`.
   */
  claudeHome?: string;
  /** spec 298 — redirected Codex home (the dir directly containing `sessions/`). Defaults to `<home>/.codex`. */
  codexHome?: string;
  /** spec 327 — redirected Antigravity app home. Defaults to `<home>/.gemini/antigravity-cli`. */
  antigravityHome?: string;
  /** Hermes private/real home (dir that contains `state.db`). Defaults to `<home>/.hermes`. */
  hermesHome?: string;
}

const defaultEnv = (): ResolverEnv => ({ home: os.homedir() });

/** The dir that contains claude's `projects/` tree — the harness override, else `<home>/.claude`. */
function claudeProjectsHome(env: ResolverEnv): string {
  return env.claudeHome ?? path.join(env.home, ".claude");
}

/** The dir that contains Codex's `sessions/` tree — the harness override, else `<home>/.codex`. */
function codexSessionsHome(env: ResolverEnv): string {
  return env.codexHome ?? path.join(env.home, ".codex");
}

/** Antigravity's CLI app state dir — the home that contains `cache/last_conversations.json`. */
function antigravityCliHome(env: ResolverEnv): string {
  return env.antigravityHome ?? path.join(env.home, ".gemini", "antigravity-cli");
}

/** Hermes home containing `state.db` — harness/bridge override, else `<home>/.hermes`. */
function hermesStateHome(env: ResolverEnv): string {
  return env.hermesHome ?? path.join(env.home, ".hermes");
}

/**
 * Hermes: sessions live in `$HERMES_HOME/state.db` (SQLite). Pick the newest row whose `cwd`
 * matches (or empty id filter). Uses node:sqlite when available; returns null on any failure.
 */
export function resolveHermesId(cwd: string, env: ResolverEnv = defaultEnv(), id?: string): string | null {
  const dbPath = path.join(hermesStateHome(env), "state.db");
  if (!fs.existsSync(dbPath)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      if (id) {
        const row = db.prepare("SELECT id FROM sessions WHERE id = ? LIMIT 1").get(id) as { id?: string } | undefined;
        return typeof row?.id === "string" && row.id ? row.id : null;
      }
      const row = db
        .prepare(
          "SELECT id FROM sessions WHERE cwd = ? ORDER BY COALESCE(ended_at, started_at) DESC, started_at DESC LIMIT 1",
        )
        .get(cwd) as { id?: string } | undefined;
      if (typeof row?.id === "string" && row.id) return row.id;
      // Older rows may have NULL cwd — only then fall back to the newest overall session.
      const nullCwd = db
        .prepare(
          "SELECT id FROM sessions WHERE cwd IS NULL OR cwd = '' ORDER BY COALESCE(ended_at, started_at) DESC, started_at DESC LIMIT 1",
        )
        .get() as { id?: string } | undefined;
      return typeof nullCwd?.id === "string" && nullCwd.id ? nullCwd.id : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

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

/**
 * Read ONLY the first line of a (possibly huge) file — the session header is line 1, but a transcript
 * can be hundreds of MB. `fs.readFileSync(file)` to grab one line loaded the WHOLE file into memory on
 * every scan; with a 565 MB project dir scanned per resumable agent per tree refresh that exploded RAM
 * + pegged CPU (spec-221 regression). This reads at most `maxBytes` via one bounded read. Returns "" on
 * any error; a header longer than maxBytes returns a truncated chunk (JSON.parse then fails → skipped).
 */
function readFirstLine(file: string, maxBytes = 1 << 18 /* 256 KiB */): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    const s = buf.toString("utf8", 0, n);
    const nl = s.indexOf("\n");
    return nl === -1 ? s : s.slice(0, nl);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Read the first `maxLines` COMPLETE lines of a (possibly huge) transcript via one bounded `maxBytes`
 * read — still no whole-file load (the spec-221 leak fix), but a SCAN of the header preamble rather
 * than line 0 only. claude 2.1.178 writes its session metadata as several records at the top
 * (`last-prompt`, `custom-title`, `agent-name`, …) in no fixed order, so the `customTitle` record is
 * often NOT line 0 — reading only the first line missed it and broke resume-by-title + fork (dogfood
 * 2026-06-16). Drops a trailing partial line when the buffer fills; caps line count to bound parse cost.
 */
function readHeadLines(file: string, maxBytes = 1 << 18 /* 256 KiB */, maxLines = 16): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    const lines = buf.toString("utf8", 0, n).split("\n");
    if (n === maxBytes && lines.length > 1) lines.pop(); // buffer full → last line may be truncated
    return lines.filter((l) => l.length > 0).slice(0, maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Codex: `~/.codex/sessions/**​/rollout-<ts>-<uuid>.jsonl`; first line is session_meta with `cwd`. */
export interface ResolvedCaptureSession {
  id: string;
  path: string;
}

/** Codex: `~/.codex/sessions/**​/rollout-<ts>-<uuid>.jsonl`; first line is session_meta with `cwd`.
 *  When `id` is supplied, require that exact session id; otherwise return the newest matching cwd. */
export function resolveCodexSession(cwd: string, env = defaultEnv(), id?: string): ResolvedCaptureSession | null {
  const root = path.join(codexSessionsHome(env), "sessions");
  for (const file of findFiles(root, /^rollout-.*\.jsonl$/)) {
    try {
      const firstLine = readFirstLine(file);
      const meta = JSON.parse(firstLine) as { type?: string; payload?: { id?: string; cwd?: string } };
      if (meta.type === "session_meta" && meta.payload?.cwd === cwd && meta.payload.id && (!id || meta.payload.id === id)) {
        return { id: meta.payload.id, path: file };
      }
    } catch {
      /* skip unreadable/partial rollout */
    }
  }
  return null;
}

export function resolveCodexId(cwd: string, env = defaultEnv()): string | null {
  return resolveCodexSession(cwd, env)?.id ?? null;
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

/** Antigravity: `~/.gemini/antigravity-cli/cache/last_conversations.json` maps cwd -> last conversation id. */
export function resolveAntigravityId(cwd: string, env = defaultEnv()): string | null {
  const file = path.join(antigravityCliHome(env), "cache", "last_conversations.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)[cwd];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * claude (spec 212 / A3): the session the agent is CURRENTLY in for a cwd = the newest
 * `*.jsonl` by mtime under `~/.claude/projects/<encodeClaudeCwd(cwd)>/`. Used to refresh
 * ownership at stop so an in-TUI `/resume` is followed. (Mint runtimes pin their id at
 * spawn and otherwise never re-read disk — this is the ownership-refresh path.)
 */
export function resolveClaudeId(cwd: string, env = defaultEnv()): string | null {
  const dir = path.join(claudeProjectsHome(env), "projects", encodeClaudeCwd(cwd));
  const files = findFiles(dir, /\.jsonl$/);
  return files.length > 0 ? path.basename(files[0], ".jsonl") : null;
}

/**
 * claude (spec 220): resolve the REAL session uuid for a Tachyon-named session, by matching the
 * jsonl header's `customTitle` against the name we spawned with (`-n <title>`). The jsonl is named
 * by claude's own uuid; a `{type:"custom-title", customTitle, sessionId}` record sits in the header
 * preamble (NOT necessarily line 0 — claude 2.1.178 also writes `last-prompt`/`agent-name` there). We
 * scan the first few header lines for it. Because each agent's title is unique, this is unambiguous
 * EVEN when many claude agents share one cwd — the exact case that defeated the newest-by-cwd
 * `resolveClaudeId` (its caller's ambiguity gate). Returns the newest matching `sessionId` (uuid), or
 * null if no transcript carries that title yet.
 */
export function resolveClaudeIdByTitle(cwd: string, title: string, env = defaultEnv()): string | null {
  const dir = path.join(claudeProjectsHome(env), "projects", encodeClaudeCwd(cwd));
  for (const file of findFiles(dir, /\.jsonl$/)) {
    // findFiles is newest-first, so the first title match is the most recent session.
    for (const line of readHeadLines(file)) {
      try {
        const rec = JSON.parse(line) as { customTitle?: string; sessionId?: string };
        if (rec.customTitle === title && rec.sessionId) return rec.sessionId;
      } catch {
        /* skip a non-JSON / partial header line */
      }
    }
  }
  return null;
}

/**
 * spec 212 / A3 — the session a cwd is CURRENTLY owned by, where derivable from disk:
 * claude (newest transcript), codex/antigravity/opencode (the capture resolvers, already newest-by-cwd).
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
    case "antigravity":
      return resolveAntigravityId(cwd, env);
    case "opencode":
      return resolveOpencodeId(cwd, env);
    case "hermes":
      return resolveHermesId(cwd, env);
    default:
      return null; // gemini / qwen / continue — not derivable; keep the stored id
  }
}

/** Dispatch by runtime. Returns null for unsupported/unresolved (caller falls back). */
export async function resolveCaptureId(runtime: ResumeRuntime, cwd: string, env = defaultEnv()): Promise<string | null> {
  switch (runtime) {
    case "codex":
      return resolveCodexId(cwd, env);
    case "antigravity":
      return resolveAntigravityId(cwd, env);
    case "opencode":
      return resolveOpencodeId(cwd, env);
    case "hermes":
      return resolveHermesId(cwd, env);
    // qwen (sessions in the working dir) and continue (no documented on-disk map)
    // are not yet resolved from disk — they resume only when an id was captured at
    // runtime. Tracked for a later pass.
    default:
      return null;
  }
}

/** Dispatch by runtime when callers need both the capture id and the canonical on-disk transcript path. */
export async function resolveCaptureSession(
  runtime: ResumeRuntime,
  cwd: string,
  env = defaultEnv(),
  id?: string,
): Promise<ResolvedCaptureSession | null> {
  switch (runtime) {
    case "codex":
      return resolveCodexSession(cwd, env, id);
    default:
      return null;
  }
}
