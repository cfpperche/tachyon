/**
 * Design Mode chat (single active agent) — one append-only JSONL per workspace.
 * Virtualization loads tails / older windows on demand (no full-file hydrate into the page).
 *
 * t-9b2741 (C-07): append is serialized per workspace so concurrent multi-window writers cannot
 * assign the same lineNo. Size is capped; corrupt vs empty file states are distinguishable via
 * inspectDmChatFile. t-7843d0: that serialization is the shared `processLock` — orphan-recoverable,
 * and awaited rather than blocking the extension host.
 */

import fs from "node:fs";
import path from "node:path";
import { withProcessLock } from "../../locks/processLock.js";

export const DM_CHAT_DIR = "design-mode-chat";
export const DM_CHAT_FILE = "chat.jsonl";
export const DM_CHAT_LOCK_FILE = "chat.jsonl.lock";
/** Hard ceiling for the durable log — refuse append past this (bytes of file + payload). */
export const DM_CHAT_MAX_BYTES = 2 * 1024 * 1024;
/** How long a writer waits for the workspace lock before failing. */
export const DM_CHAT_LOCK_TIMEOUT_MS = 10_000;
/**
 * A holder older than this is orphaned even if its pid answers — the pid-reuse guard (t-7843d0).
 * The real critical section is one read + one append of a capped file, so this is far above any
 * legitimate hold and well under the timeout above: a wedged lock is recovered inside a single
 * append rather than after the caller has already failed.
 */
export const DM_CHAT_MAX_HOLD_MS = 5_000;
/** Markers must not appear on one prose line as "between START and END" — that extracted "and". */
export const DM_CHAT_REPLY_START = "<<<DM_CHAT_REPLY>>>";
export const DM_CHAT_REPLY_END = "<<<END_DM_CHAT_REPLY>>>";

export type DmChatRole = "user" | "agent" | "system";

export type DmChatEvent =
  | {
    v: 1;
    at: string;
    kind: "message";
    role: "user";
    text: string;
    activeAgent: string;
    lineNo: number;
  }
  | {
    v: 1;
    at: string;
    kind: "message";
    role: "agent";
    agent: string;
    text: string;
    activeAgent: string;
    source: "tool" | "markers" | "activity";
    lineNo: number;
  }
  | {
    v: 1;
    at: string;
    kind: "system";
    text: string;
    activeAgent?: string;
    lineNo: number;
  }
  | {
    v: 1;
    at: string;
    kind: "agent_switch";
    from: string;
    to: string;
    text: string;
    activeAgent: string;
    lineNo: number;
  };

export type DmChatChunk = {
  items: DmChatEvent[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  oldestLineNo: number | null;
  newestLineNo: number | null;
};

/** File presence / integrity — empty and corrupt must never look the same. */
export type DmChatFileStatus = "missing" | "empty" | "ok" | "corrupt";

export type DmChatFileInspection = {
  status: DmChatFileStatus;
  bytes: number;
  /** Non-empty physical lines (valid + corrupt). */
  physicalLines: number;
  /** Successfully parsed events. */
  eventCount: number;
  /** Non-empty lines that failed JSON/schema parse. */
  corruptLineCount: number;
};

export function designModeChatPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", DM_CHAT_DIR, DM_CHAT_FILE);
}

/** Exported so a test can hold the REAL lock from another process (and then be killed). */
export function designModeChatLockPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", DM_CHAT_DIR, DM_CHAT_LOCK_FILE);
}

function ensureDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

/**
 * Serialize writers for one workspace chat.jsonl (multi-window / multi-process).
 *
 * ASYNC on purpose (t-7843d0). Every caller of `appendDmChatEvent` runs on the extension host, via
 * `manager.ts`, and the previous shape waited with `Atomics.wait` — which blocks the host thread for
 * real, so the multi-window contention this lock exists to handle froze the VS Code UI for up to ten
 * seconds. The wait is now a `setTimeout` poll: the host keeps painting and answering messages while
 * another window finishes its append. All four call sites were already in `async` methods and already
 * awaited their neighbours, so this cost nothing at the doors.
 *
 * Orphan recovery is `processLock`'s: a holder that died leaves a lock with a dead pid, and the next
 * writer steals it instead of burning the timeout and then failing forever.
 */
export function withDmChatWriteLock<T>(workspaceRoot: string, fn: () => T | Promise<T>): Promise<T> {
  const file = designModeChatPath(workspaceRoot);
  ensureDir(file);
  return withProcessLock(designModeChatLockPath(workspaceRoot), fn, {
    label: `Design Mode chat write lock (${DM_CHAT_LOCK_FILE})`,
    timeoutMs: DM_CHAT_LOCK_TIMEOUT_MS,
    maxHoldMs: DM_CHAT_MAX_HOLD_MS,
  });
}

function parseLine(line: string, lineNo: number): DmChatEvent | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const raw = JSON.parse(t) as Record<string, unknown>;
    if (raw.v !== 1 || typeof raw.at !== "string" || typeof raw.kind !== "string") return null;
    // Ensure lineNo is set (older lines without it still get the file index).
    return { ...raw, lineNo } as DmChatEvent;
  } catch {
    return null;
  }
}

/**
 * Distinguish missing / empty / ok / corrupt without treating junk as "no history".
 * Readers that only need events still use readAllDmChatEvents (skips bad lines).
 */
export function inspectDmChatFile(workspaceRoot: string): DmChatFileInspection {
  const file = designModeChatPath(workspaceRoot);
  if (!fs.existsSync(file)) {
    return { status: "missing", bytes: 0, physicalLines: 0, eventCount: 0, corruptLineCount: 0 };
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { status: "missing", bytes: 0, physicalLines: 0, eventCount: 0, corruptLineCount: 0 };
  }
  const bytes = st.size;
  if (bytes === 0) {
    return { status: "empty", bytes: 0, physicalLines: 0, eventCount: 0, corruptLineCount: 0 };
  }
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) {
    return { status: "empty", bytes, physicalLines: 0, eventCount: 0, corruptLineCount: 0 };
  }
  let physicalLines = 0;
  let eventCount = 0;
  let corruptLineCount = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    physicalLines += 1;
    if (parseLine(line, physicalLines)) eventCount += 1;
    else corruptLineCount += 1;
  }
  if (physicalLines === 0) {
    return { status: "empty", bytes, physicalLines: 0, eventCount: 0, corruptLineCount: 0 };
  }
  if (corruptLineCount > 0) {
    return { status: "corrupt", bytes, physicalLines, eventCount, corruptLineCount };
  }
  return { status: "ok", bytes, physicalLines, eventCount, corruptLineCount: 0 };
}

/** Read all events with sequential lineNo (1-based among non-empty physical lines). */
export function readAllDmChatEvents(workspaceRoot: string): DmChatEvent[] {
  const file = designModeChatPath(workspaceRoot);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const out: DmChatEvent[] = [];
  let n = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    n += 1;
    const ev = parseLine(line, n);
    if (ev) out.push(ev);
  }
  return out;
}

/** Input for append — same shape as DmChatEvent without host-assigned fields. */
export type DmChatEventInput =
  | {
    kind: "message";
    role: "user";
    text: string;
    activeAgent: string;
    at?: string;
  }
  | {
    kind: "message";
    role: "agent";
    agent: string;
    text: string;
    activeAgent: string;
    source: "tool" | "markers" | "activity";
    at?: string;
  }
  | {
    kind: "system";
    text: string;
    activeAgent?: string;
    at?: string;
  }
  | {
    kind: "agent_switch";
    from: string;
    to: string;
    text: string;
    activeAgent: string;
    at?: string;
  };

/**
 * Next durable lineNo = count of non-empty physical lines already on disk + 1.
 * Uses physical lines (not only parseable events) so a corrupt line still occupies a slot
 * and the next append does not collide with a re-numbered gap.
 */
function nextLineNoFromText(text: string): number {
  if (!text) return 1;
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.trim()) n += 1;
  }
  return n + 1;
}

/** Append one event; assigns next lineNo under the workspace write lock. Returns the stored event. */
export function appendDmChatEvent(workspaceRoot: string, event: DmChatEventInput): Promise<DmChatEvent> {
  return withDmChatWriteLock(workspaceRoot, () => {
    const file = designModeChatPath(workspaceRoot);
    ensureDir(file);
    let existingText = "";
    let existingBytes = 0;
    if (fs.existsSync(file)) {
      existingText = fs.readFileSync(file, "utf8");
      existingBytes = Buffer.byteLength(existingText, "utf8");
    }
    const lineNo = nextLineNoFromText(existingText);
    const full = {
      v: 1 as const,
      at: event.at ?? new Date().toISOString(),
      ...event,
      lineNo,
    } as DmChatEvent;
    const payload = `${JSON.stringify(full)}\n`;
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (existingBytes + payloadBytes > DM_CHAT_MAX_BYTES) {
      throw new Error(
        `Design Mode chat log exceeds ${DM_CHAT_MAX_BYTES} bytes (have ${existingBytes}, need ${payloadBytes} more)`,
      );
    }
    fs.appendFileSync(file, payload, { encoding: "utf8", mode: 0o600 });
    return full;
  });
}

/**
 * Tail the last `limit` events (opening the chat).
 */
export function tailDmChat(workspaceRoot: string, limit = 60): DmChatChunk {
  const all = readAllDmChatEvents(workspaceRoot);
  if (all.length === 0) {
    return { items: [], hasMoreBefore: false, hasMoreAfter: false, oldestLineNo: null, newestLineNo: null };
  }
  const start = Math.max(0, all.length - limit);
  const items = all.slice(start);
  return {
    items,
    hasMoreBefore: start > 0,
    hasMoreAfter: false,
    oldestLineNo: items[0]?.lineNo ?? null,
    newestLineNo: items[items.length - 1]?.lineNo ?? null,
  };
}

/**
 * Load up to `limit` events strictly older than `beforeLineNo` (scroll up).
 */
export function loadDmChatBefore(
  workspaceRoot: string,
  beforeLineNo: number,
  limit = 40,
): DmChatChunk {
  const all = readAllDmChatEvents(workspaceRoot);
  const older = all.filter((e) => e.lineNo < beforeLineNo);
  if (older.length === 0) {
    return { items: [], hasMoreBefore: false, hasMoreAfter: true, oldestLineNo: null, newestLineNo: null };
  }
  const start = Math.max(0, older.length - limit);
  const items = older.slice(start);
  return {
    items,
    hasMoreBefore: start > 0,
    hasMoreAfter: true,
    oldestLineNo: items[0]?.lineNo ?? null,
    newestLineNo: items[items.length - 1]?.lineNo ?? null,
  };
}

/**
 * Extract plain reply from text using markers.
 * Rejects junk matches from the host instruction itself (historically: the word "and"
 * between START and END on the same line of the prompt).
 */
export function extractDmChatReplyMarkers(paneText: string): string | null {
  const start = paneText.lastIndexOf(DM_CHAT_REPLY_START);
  if (start < 0) return null;
  const after = start + DM_CHAT_REPLY_START.length;
  const end = paneText.indexOf(DM_CHAT_REPLY_END, after);
  if (end < 0) return null;
  const body = paneText.slice(after, end).trim();
  if (!body) return null;
  // Instruction residue: "between <<<START>>> and <<<END>>>"
  if (/^(and|or|…|\.\.\.)$/i.test(body)) return null;
  // Prefer real replies: more than a couple of filler words, or multi-line payload.
  if (body.length < 3 && !body.includes("\n")) return null;
  return body;
}

/**
 * Prompt for one Design Mode chat send — **the only agent-facing turn builder**.
 *
 * Does **not** paste the full JSONL history into the agent pane. Optional pick context
 * (element selection) is attached here so the Selection card never calls the agent itself.
 */
export function formatDmChatPrompt(input: {
  agent: string;
  text: string;
  /** Workspace root — used to resolve the single chat.jsonl path. */
  workspaceRoot?: string;
  /** Explicit path override (tests); defaults to designModeChatPath(workspaceRoot). */
  chatLogPath?: string;
  /** Ignored for the wire prompt (kept for API compat). */
  recent?: Array<{ role: string; agent?: string; text: string }>;
  pageUrl?: string;
  /**
   * Optional Design Mode pick block (already formatted markdown from pick.ts).
   * When present, this human turn is about that selection.
   */
  pickContext?: string;
}): string {
  void input.recent;
  const chatPath =
    input.chatLogPath
    ?? (input.workspaceRoot ? designModeChatPath(input.workspaceRoot) : null);

  const lines = [
    `[Design Mode · ${input.agent}]`,
    input.pageUrl ? `Open page: ${input.pageUrl}` : null,
    chatPath
      ? `Chat log (append-only JSONL, one event per line): ${chatPath}`
      : null,
    chatPath
      ? "If you need earlier turns, read/tail that file with tools — do not ask the human to paste history."
      : null,
    "",
    input.pickContext
      ? "A page element is attached to this chat turn (inspect + act via ide_browser_* as needed):"
      : null,
    input.pickContext || null,
    input.pickContext ? "" : null,
    `Human: ${input.text}`,
    "",
    // Happy path is tool-only. Pane markers are not advertised — they taught agents to skip MCP.
    "Required: answer ONLY via Bridge tool design_mode_chat_reply({ text: \"...\" }) with the plain answer.",
    "Do not write the answer only in the terminal pane — the Design Mode chat panel updates only when that tool is called.",
    "Do not wrap the answer in markers or dump tool JSON into the pane.",
  ];
  return lines.filter((l) => l !== null && l !== undefined).join("\n");
}
