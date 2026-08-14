import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "../utils/redactSecrets.js";

/**
 * Durable per-agent pane transcript (t-6a6a00): `tmux pipe-pane` streams a pane's raw output
 * continuously to `.tachyon/pane-transcripts/<agent>.log`, so postmortem evidence survives
 * kill-session and extension reloads — unlike capture-pane (scrollback-bounded, dies with the
 * session) and the in-memory `postmortemOutput` cache (dies with the extension host).
 *
 * SECURITY: the on-disk file is raw (never redacted at write time) and protected only by 0700/0600
 * perms — defence in depth, not the control. `redactSecrets` + ANSI-stripping happen at READ time,
 * in `readPaneTranscript`, which is the ONLY sanctioned read path for this file.
 */

export const PANE_TRANSCRIPT_DIRNAME = "pane-transcripts";
export const PANE_TRANSCRIPT_MAX_BYTES = 1024 * 1024; // 1 MiB
export const PANE_TRANSCRIPT_RETAIN_BYTES = 256 * 1024; // 256 KiB

/** Default tail bound applied by readPaneTranscript when the caller doesn't supply its own
 *  (mirrors AgentManager.POSTMORTEM_MAX_LINES/MAX_BYTES; duplicated rather than imported to
 *  avoid a circular import — AgentManager imports this module, not the other way round). */
const DEFAULT_READ_MAX_LINES = 1000;
const DEFAULT_READ_MAX_BYTES = 64 * 1024;

// Mirrors AttentionMonitor's ANSI_RE (src/attention/AttentionMonitor.ts) — a CSI-sequence matcher.
// pipe-pane taps the pane's raw pty stream (unlike capture-pane -p, which is plain text by
// default), so anything written by a full-screen/color-using program carries escapes that must
// be stripped before the text is human/agent readable.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function paneTranscriptDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", PANE_TRANSCRIPT_DIRNAME);
}

export function paneTranscriptPath(workspaceRoot: string, agent: string): string {
  return path.join(paneTranscriptDir(workspaceRoot), `${agent}.log`);
}

/** True when a durable transcript file exists for `agent` (cheap existence probe — no content read/redaction). */
export function paneTranscriptExists(workspaceRoot: string, agent: string): boolean {
  return fs.existsSync(paneTranscriptPath(workspaceRoot, agent));
}

/**
 * Idempotently creates the durable transcript file (dir 0o700, file 0o600) and returns its path.
 * Never truncates existing content — a restart/resume keeps appending to the same durable log.
 */
export function ensurePaneTranscriptFile(workspaceRoot: string, agent: string): string {
  const dir = paneTranscriptDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700); // defeat umask on an already-existing dir
  const file = paneTranscriptPath(workspaceRoot, agent);
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
  fs.closeSync(fd);
  fs.chmodSync(file, 0o600); // defeat umask on an already-existing file
  return file;
}

/** Removes the durable transcript for an EPHEMERAL agent being permanently forgotten (see forgetAgent.ts). Idempotent. */
export function removePaneTranscript(workspaceRoot: string, agent: string): void {
  fs.rmSync(paneTranscriptPath(workspaceRoot, agent), { force: true });
}

/**
 * Truncate-with-marker rotation, applied IN PLACE on the same inode. tmux's `pipe-pane` holds the
 * file open (append mode) for the life of the session; renaming a replacement file over it would
 * orphan that writer on a deleted inode (its output would vanish into nothing readers can reach).
 * Truncating the live inode is safe: an O_APPEND writer reseeks to the current end-of-file on every
 * write, so the next pipe-pane write lands right after the retained tail we just wrote back.
 *
 * There is a narrow race: if pipe-pane writes between our ftruncate and our write-back, that write
 * lands at offset 0 and part of it may be clobbered by our own write-back. This only matters in the
 * brief window during a rotation event (only once per MAX_BYTES growth), and a transcript is
 * best-effort evidence, not a transactional log — an occasional dropped line during rotation is an
 * accepted trade-off.
 */
export function rotatePaneTranscriptIfNeeded(
  file: string,
  maxBytes: number = PANE_TRANSCRIPT_MAX_BYTES,
  retainBytes: number = PANE_TRANSCRIPT_RETAIN_BYTES,
): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // no file yet (or vanished) — nothing to rotate
  }
  if (size <= maxBytes) return;
  const fd = fs.openSync(file, "r+");
  try {
    const keep = Math.min(retainBytes, size);
    const tail = Buffer.alloc(keep);
    fs.readSync(fd, tail, 0, keep, size - keep);
    const marker = Buffer.from(`[tachyon] pane transcript rotated at ${size} bytes; earlier output discarded\n`, "utf8");
    const combined = Buffer.concat([marker, tail]);
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, combined, 0, combined.length, 0);
  } finally {
    fs.closeSync(fd);
  }
}

export interface PaneTranscriptTail {
  text: string;
  truncated: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface PaneTranscriptReadOptions {
  /** Plaintext secrets to exact-match-redact, in addition to the syntactic patterns redactSecrets always applies. */
  knownSecrets?: readonly string[];
  maxLines?: number;
  maxBytes?: number;
}

/**
 * Reads the durable transcript for `agent` (rotating it first so a giant file can't be read whole),
 * strips ANSI escapes, and redacts secrets — the ONLY sanctioned read path for this raw file.
 * Returns undefined when no transcript exists yet (or it's empty).
 */
export function readPaneTranscript(
  workspaceRoot: string,
  agent: string,
  opts: PaneTranscriptReadOptions = {},
): PaneTranscriptTail | undefined {
  const file = paneTranscriptPath(workspaceRoot, agent);
  rotatePaneTranscriptIfNeeded(file);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  if (raw.length === 0) return undefined;
  // Trailing newline(s) trimmed to match capturePane's convention (TmuxService.capturePane strips
  // `/\n+$/`) — pipe-pane's raw stream always ends mid-write-boundary with one, unlike a screen capture.
  const stripped = raw.replace(ANSI_RE, "").replace(/\n+$/, "");
  const redacted = redactSecrets(stripped, opts.knownSecrets ?? []);
  if (redacted.length === 0) return undefined;
  const maxLines = opts.maxLines ?? DEFAULT_READ_MAX_LINES;
  const maxBytes = opts.maxBytes ?? DEFAULT_READ_MAX_BYTES;
  const lines = redacted.split("\n");
  let text = lines.length > maxLines ? lines.slice(-maxLines).join("\n") : redacted;
  let truncated = text !== redacted;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    text = Buffer.from(text, "utf8").subarray(-maxBytes).toString("utf8");
    truncated = true;
  }
  return { text, truncated, maxLines, maxBytes };
}
