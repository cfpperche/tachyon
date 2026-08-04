/**
 * Design Mode chat (single active agent) — one append-only JSONL per workspace.
 * Virtualization loads tails / older windows on demand (no full-file hydrate into the page).
 */

import fs from "node:fs";
import path from "node:path";

export const DM_CHAT_DIR = "design-mode-chat";
export const DM_CHAT_FILE = "chat.jsonl";
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

export function designModeChatPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", DM_CHAT_DIR, DM_CHAT_FILE);
}

function ensureDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
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

/** Read all events with sequential lineNo (1-based file order). */
export function readAllDmChatEvents(workspaceRoot: string): DmChatEvent[] {
  const file = designModeChatPath(workspaceRoot);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
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

/** Append one event; assigns next lineNo. Returns the stored event. */
export function appendDmChatEvent(workspaceRoot: string, event: DmChatEventInput): DmChatEvent {
  const file = designModeChatPath(workspaceRoot);
  ensureDir(file);
  const existing = readAllDmChatEvents(workspaceRoot);
  const lineNo = (existing[existing.length - 1]?.lineNo ?? 0) + 1;
  const full = {
    v: 1 as const,
    at: event.at ?? new Date().toISOString(),
    ...event,
    lineNo,
  } as DmChatEvent;
  fs.appendFileSync(file, `${JSON.stringify(full)}\n`, { encoding: "utf8", mode: 0o600 });
  return full;
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
