import type { ActivityNormalizer } from "./codexNormalizer.js";
import { isUserInterrupt } from "./interrupt.js";
import type { ActivityEventType, ActivityPayloads, NormalizedEvent } from "./types.js";

interface PiContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface PiMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
  provider?: string;
  model?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  customType?: string;
  display?: boolean;
  summary?: string;
  tokensBefore?: number;
}

interface PiEntry {
  type?: string;
  version?: number;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  message?: PiMessage;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  summary?: string;
  tokensBefore?: number;
  customType?: string;
  content?: unknown;
  display?: boolean;
  name?: string;
}

interface PendingTool { name: string; writePath?: string }

const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "patch", "multiedit", "notebookedit"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "glob", "notebookread"]);
const CONTEXT_CAP = 4000;

export function createPiNormalizer(sourcePath?: string): ActivityNormalizer {
  const pending = new Map<string, PendingTool>();
  let seq = 0;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;

  const emit = <T extends ActivityEventType>(
    out: NormalizedEvent[], type: T, entry: PiEntry, payload: ActivityPayloads[T], raw: unknown, recordId = entry.id,
  ): void => {
    out.push({
      type,
      runtime: "pi",
      sequence: seq++,
      ...(sessionId ? { sessionId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(recordId ? { recordId } : {}),
      sourcePath,
      payload,
      raw,
    });
  };

  return {
    push(lines: string[]): NormalizedEvent[] {
      const out: NormalizedEvent[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: PiEntry;
        try { entry = JSON.parse(trimmed) as PiEntry; } catch { continue; }
        if (!entry || typeof entry !== "object") continue;

        switch (entry.type) {
          case "session":
            if (typeof entry.id !== "string" || typeof entry.cwd !== "string") break;
            sessionId = entry.id;
            cwd = entry.cwd;
            emit(out, "session.started", entry, {}, entry, `session:${entry.id}`);
            break;
          case "model_change":
            if (typeof entry.modelId === "string" && entry.modelId) model = entry.modelId;
            break;
          case "thinking_level_change":
            if (typeof entry.thinkingLevel === "string" && entry.thinkingLevel) effort = entry.thinkingLevel;
            break;
          case "message":
            handleMessage(out, entry, entry.message);
            break;
          case "custom_message":
            emitContext(out, entry, entry.content, entry.customType, entry.display);
            break;
          case "compaction": {
            const tokens = number(entry.tokensBefore);
            emit(out, "compaction.boundary", entry, { ...(tokens !== undefined ? { preTokens: tokens } : {}) }, entry);
            if (typeof entry.summary === "string" && entry.summary.trim()) {
              emit(out, "compaction.summary", entry, { text: entry.summary }, entry);
            }
            break;
          }
          case "branch_summary":
            if (typeof entry.summary === "string" && entry.summary.trim()) {
              emit(out, "compaction.summary", entry, { text: entry.summary }, entry);
            }
            break;
          default:
            break;
        }
      }
      return out;
    },
  };

  function handleMessage(out: NormalizedEvent[], entry: PiEntry, message: PiMessage | undefined): void {
    if (!message || typeof message !== "object") return;
    if (typeof message.model === "string" && message.model) model = message.model;
    switch (message.role) {
      case "user":
        emitUser(out, entry, message.content);
        break;
      case "assistant":
        emitAssistant(out, entry, message);
        break;
      case "toolResult":
        emitToolResult(out, entry, message);
        break;
      case "bashExecution":
        emitBash(out, entry, message);
        break;
      case "custom":
        emitContext(out, entry, message.content, message.customType, message.display);
        break;
      case "branchSummary":
      case "compactionSummary":
        if (typeof message.summary === "string" && message.summary.trim()) {
          emit(out, "compaction.summary", entry, { text: message.summary }, message);
        }
        break;
      default:
        break;
    }
  }

  function emitUser(out: NormalizedEvent[], entry: PiEntry, content: unknown): void {
    emitImages(out, entry, content, "user");
    const text = textOf(content).trim();
    if (!text) return;
    if (isPrimer(text)) {
      emit(out, "context.injected", entry, contextPayload(text, "environment"), entry);
    } else if (isUserInterrupt(text)) {
      emit(out, "user.interrupted", entry, { text }, entry);
    } else if (/^\s*\[tachyon\]/i.test(text)) {
      emit(out, "system.nudge", entry, { text }, entry);
    } else {
      emit(out, "user.message.completed", entry, { text }, entry);
    }
  }

  function emitAssistant(out: NormalizedEvent[], entry: PiEntry, message: PiMessage): void {
    const blocks = blocksOf(message.content);
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        emit(out, "assistant.thinking", entry, { text: block.thinking }, block);
      } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        emit(out, "assistant.message.completed", entry, { text: block.text }, block);
      } else if (block.type === "toolCall") {
        const id = typeof block.id === "string" && block.id ? block.id : undefined;
        const name = typeof block.name === "string" && block.name ? block.name : "tool";
        emit(out, "tool.started", entry, { toolUseId: id, name, input: block.arguments }, block);
        const filePath = pathFromInput(block.arguments);
        const lower = name.toLowerCase();
        if (id) pending.set(id, { name, writePath: filePath && WRITE_TOOLS.has(lower) ? filePath : undefined });
        if (filePath && READ_TOOLS.has(lower)) emit(out, "file.referenced", entry, { path: filePath, tool: name }, block);
      }
      if (block.type === "image") emitImage(out, entry, block, "agent", i);
    }
    emitUsage(out, entry, message);
    if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.trim()) {
      emit(out, "error", entry, { message: message.errorMessage, category: "provider" }, message);
    } else if (message.stopReason === "aborted") {
      emit(out, "user.interrupted", entry, { text: message.errorMessage?.trim() || "Turn aborted" }, message);
    }
  }

  function emitToolResult(out: NormalizedEvent[], entry: PiEntry, message: PiMessage): void {
    const id = typeof message.toolCallId === "string" && message.toolCallId ? message.toolCallId : undefined;
    const prior = id ? pending.get(id) : undefined;
    if (id) pending.delete(id);
    const name = typeof message.toolName === "string" && message.toolName ? message.toolName : prior?.name;
    const full = textOf(message.content) || stringify(message.details);
    emit(out, message.isError ? "tool.failed" : "tool.completed", entry, {
      toolUseId: id, name, summary: summarize(full), full: full || undefined,
    }, message);
    emitImages(out, entry, message.content, "agent");
    if (!message.isError && prior?.writePath) emit(out, "file.changed", entry, { path: prior.writePath, tool: name }, message);
  }

  function emitBash(out: NormalizedEvent[], entry: PiEntry, message: PiMessage): void {
    if (typeof message.command !== "string" || !message.command.trim()) return;
    emit(out, "user.command", entry, { command: message.command }, message);
    const full = typeof message.output === "string" ? message.output : "";
    const failed = message.cancelled === true || (typeof message.exitCode === "number" && message.exitCode !== 0);
    emit(out, failed ? "tool.failed" : "tool.completed", entry, {
      name: "bash", summary: summarize(full), full: full || undefined,
    }, message);
  }

  function emitContext(out: NormalizedEvent[], entry: PiEntry, content: unknown, customType?: string, display?: boolean): void {
    const text = textOf(content).trim();
    if (!text) return;
    emitImages(out, entry, content, "agent");
    emit(out, "context.injected", entry, {
      ...contextPayload(text, "hook"),
      hookEvent: customType,
      tagged: display === false || text.trimStart().startsWith("<"),
    }, entry);
  }

  function emitUsage(out: NormalizedEvent[], entry: PiEntry, message: PiMessage): void {
    const usage = message.usage;
    if (!usage || typeof usage !== "object") return;
    const payload: ActivityPayloads["usage.updated"] = {};
    const input = number(usage.input); if (input !== undefined) payload.inputTokens = input;
    const output = number(usage.output); if (output !== undefined) payload.outputTokens = output;
    const cacheRead = number(usage.cacheRead); if (cacheRead !== undefined) payload.cacheReadTokens = cacheRead;
    const cacheWrite = number(usage.cacheWrite); if (cacheWrite !== undefined) payload.cacheCreationTokens = cacheWrite;
    if (Object.keys(payload).length) emit(out, "usage.updated", entry, payload, message);
  }

  function emitImages(out: NormalizedEvent[], entry: PiEntry, content: unknown, from: "user" | "agent"): void {
    for (const [i, block] of blocksOf(content).entries()) if (block.type === "image") emitImage(out, entry, block, from, i);
  }

  function emitImage(out: NormalizedEvent[], entry: PiEntry, block: PiContentBlock, from: "user" | "agent", index: number): void {
    if (typeof block.data !== "string" || typeof block.mimeType !== "string") return;
    emit(out, "image.attached", entry, { id: `${entry.id ?? "pi"}:image:${index}`, mediaType: block.mimeType, from }, block);
  }
}

export function normalizePi(lines: string[], sourcePath?: string): NormalizedEvent[] {
  return createPiNormalizer(sourcePath).push(lines);
}

function blocksOf(content: unknown): PiContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is PiContentBlock => !!block && typeof block === "object");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content).map((block) => typeof block.text === "string" ? block.text : "").filter(Boolean).join("\n");
}

function pathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const values = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "target_file", "notebook_path"]) {
    if (typeof values[key] === "string" && values[key]) return values[key] as string;
  }
  return undefined;
}

function contextPayload(text: string, source: "hook" | "environment"): ActivityPayloads["context.injected"] {
  return {
    text: text.length > CONTEXT_CAP ? `${text.slice(0, CONTEXT_CAP)}…` : text,
    source,
    ...(text.length > CONTEXT_CAP ? { truncated: true, originalLength: text.length } : {}),
  };
}

function isPrimer(text: string): boolean { return text.includes("── TACHYON PRIMER ──"); }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function stringify(value: unknown): string { try { return value == null ? "" : typeof value === "string" ? value : JSON.stringify(value); } catch { return String(value); } }
function summarize(value: string, max = 200): string | undefined {
  const one = value.replace(/\s+/g, " ").trim();
  return one ? one.length <= max ? one : `${one.slice(0, max)}…` : undefined;
}
