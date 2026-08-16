/**
 * t-73885b — gather Claude transcript bytes for `judgeClaudeInternalChecklistTurn`.
 * Does not decide the verdict. A missing or unreadable transcript is
 * absence of evidence, not `absent`.
 *
 * t-9f21ac — BOUNDED. This runs once per turn-end row, and a live transcript is not a small
 * file: 335 MB / 85k records was measured in this repo. Reading and parsing all of it, per row,
 * pinned the engine's event loop for minutes, so the control socket stopped answering health and
 * the extension refused to start ("found an engine control endpoint but could not verify it").
 *
 * The judge resets its state at every turn-start, so only the LAST turn window can change its
 * answer. We read that window backward from EOF under two ceilings, plus the head for `init.tools`
 * (the init record is the first line, and the window rarely reaches it).
 *
 * A window that hits a ceiling WITHOUT reaching a turn-start is not evidence: the plan event may be
 * one line outside it, and a false `absent` accuses an agent that did plan. Same answer as an
 * unreadable file — undefined, which the caller reads as pending.
 */
import fs from "node:fs";
import { readTailWindow } from "../activity/tailReader.js";
import { isClaudeTurnStartEvent } from "./claudeInternalChecklistTurn.js";

const WINDOW_MAX_LINES = 4096;
const WINDOW_MAX_BYTES = 2 * 1024 * 1024;
const HEAD_MAX_BYTES = 64 * 1024;
const MEMO_MAX_ENTRIES = 8;

export interface ClaudeTurnEvidence {
  initTools: string[];
  events: unknown[];
}

/** Size+mtime memo: the same transcript is asked about by more than one caller per tick, and
 *  between two appends the answer cannot change. Bounded, and keyed so an append always misses. */
const memo = new Map<string, { size: number; mtimeMs: number; evidence: ClaudeTurnEvidence | undefined }>();

export function readClaudeTurnEvidence(transcriptPath: string): ClaudeTurnEvidence | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size === 0) return undefined;

  const hit = memo.get(transcriptPath);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.evidence;

  const evidence = readTurnWindowEvidence(transcriptPath);
  memo.delete(transcriptPath);
  if (memo.size >= MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(transcriptPath, { size: stat.size, mtimeMs: stat.mtimeMs, evidence });
  return evidence;
}

function readTurnWindowEvidence(transcriptPath: string): ClaudeTurnEvidence | undefined {
  let window;
  try {
    window = readTailWindow(transcriptPath, WINDOW_MAX_LINES, { maxBytes: WINDOW_MAX_BYTES });
  } catch {
    return undefined;
  }

  const scanned: unknown[] = [];
  let initTools: string[] = [];
  let lastTurnStart = -1;
  for (const line of window.lines) {
    const parsed = parseRecord(line);
    if (parsed === undefined) continue;
    if (isClaudeTurnStartEvent(parsed)) lastTurnStart = scanned.length;
    scanned.push(parsed);
    const tools = initToolsOf(parsed);
    if (tools) initTools = tools;
  }

  const readWholeFile = window.startOffset === 0;
  if (lastTurnStart < 0 && !readWholeFile) return undefined;
  // Hand the judge the turn, not the window: it resets on the turn-start anyway, and everything
  // before that one is dead weight it would walk record by record.
  const events = lastTurnStart >= 0 ? scanned.slice(lastTurnStart) : scanned;
  if (events.length === 0) return undefined;
  if (!readWholeFile && initTools.length === 0) initTools = readHeadInitTools(transcriptPath);
  return { initTools, events };
}

/** The init record is the first line of a stream transcript; the tail window starts long after it. */
function readHeadInitTools(transcriptPath: string): string[] {
  let head: string;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const buf = Buffer.alloc(HEAD_MAX_BYTES);
      const read = fs.readSync(fd, buf, 0, HEAD_MAX_BYTES, 0);
      head = buf.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const lines = head.split("\n");
  lines.pop(); // cut by the ceiling, not by a newline — never a complete record
  let initTools: string[] = [];
  for (const line of lines) {
    const parsed = parseRecord(line);
    if (parsed === undefined) continue;
    const tools = initToolsOf(parsed);
    if (tools) initTools = tools;
  }
  return initTools;
}

function parseRecord(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined; /* skip a non-JSON / partial line */
  }
}

function initToolsOf(raw: unknown): string[] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const tools = record.tools ?? record.init_tools;
  if (Array.isArray(tools) && tools.every((item) => typeof item === "string")) {
    return tools;
  }
  const message = record.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const inner = (message as Record<string, unknown>).tools;
    if (Array.isArray(inner) && inner.every((item) => typeof item === "string")) {
      return inner;
    }
  }
  return undefined;
}
