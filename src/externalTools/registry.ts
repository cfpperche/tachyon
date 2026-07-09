import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ExternalToolConfidence, ExternalToolItemVM, ExternalToolKind, ExternalToolSession, ExternalToolsSummaryVM } from "./types.js";

export const EXTERNAL_TOOL_STALE_MS = 45_000;
const CONFIDENCE_RANK: Record<ExternalToolConfidence, number> = { weak: 0, medium: 1, strong: 2 };

export type ExternalToolInput = Omit<Partial<ExternalToolSession>, "agent" | "kind" | "tool" | "source" | "confidence"> & Pick<ExternalToolSession, "agent" | "kind" | "tool" | "source" | "confidence">;

export function externalToolSessionId(input: Pick<ExternalToolInput, "agent" | "source" | "tool"> & { pid?: number; windowId?: string; sessionId?: string }): string {
  if (input.sessionId) return input.sessionId;
  const key = [input.agent, input.source, input.tool, input.pid ?? "", input.windowId ?? ""].join("\0");
  return `ets-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

function activeKind(kind: ExternalToolKind): kind is Exclude<ExternalToolKind, "unknown"> {
  return kind !== "unknown";
}

function toItem(s: ExternalToolSession): ExternalToolItemVM {
  return {
    id: s.id,
    kind: s.kind,
    tool: s.tool,
    ...(s.title ? { title: s.title } : {}),
    ...(s.pid !== undefined ? { pid: s.pid } : {}),
    ...(s.windowId ? { windowId: s.windowId } : {}),
    startedAt: s.startedAt,
    source: s.source,
    confidence: s.confidence,
  };
}

export interface RegistryReconcileInput {
  now?: number;
  isPidAlive?: (pid: number) => boolean;
}

export class ExternalToolRegistry {
  private readonly sessions = new Map<string, ExternalToolSession>();
  private eventOffset = 0;

  constructor(private readonly workspaceRoot?: string) {}

  upsert(input: ExternalToolInput, now = Date.now()): ExternalToolSession {
    const id = input.id ?? externalToolSessionId(input);
    const prev = this.sessions.get(id);
    const startedAt = input.startedAt ?? prev?.startedAt ?? iso(now);
    const lastSeenAt = input.lastSeenAt ?? iso(now);
    const next: ExternalToolSession = {
      id,
      agent: input.agent,
      kind: input.kind,
      tool: input.tool,
      source: input.source,
      confidence: input.confidence,
      startedAt,
      lastSeenAt,
      ...(input.pid !== undefined ? { pid: input.pid } : prev?.pid !== undefined ? { pid: prev.pid } : {}),
      ...(input.windowId ? { windowId: input.windowId } : prev?.windowId ? { windowId: prev.windowId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : prev?.sessionId ? { sessionId: prev.sessionId } : {}),
      ...(input.title ? { title: input.title.slice(0, 80) } : prev?.title ? { title: prev.title } : {}),
      ...(input.commandLabel ? { commandLabel: input.commandLabel.slice(0, 80) } : prev?.commandLabel ? { commandLabel: prev.commandLabel } : {}),
      state: input.state ?? "active",
    };
    this.sessions.set(id, next);
    return next;
  }

  clear(id: string, now = Date.now()): void {
    const prev = this.sessions.get(id);
    if (!prev) return;
    this.sessions.set(id, { ...prev, state: "exited", lastSeenAt: iso(now) });
  }

  reconcile(input: RegistryReconcileInput = {}): void {
    const now = input.now ?? Date.now();
    this.ingestEvents();
    for (const [id, s] of this.sessions) {
      if (s.state !== "active") continue;
      if (s.pid !== undefined && input.isPidAlive && !input.isPidAlive(s.pid)) {
        this.sessions.set(id, { ...s, state: "exited", lastSeenAt: iso(now) });
        continue;
      }
      const last = Date.parse(s.lastSeenAt);
      if (Number.isFinite(last) && now - last > EXTERNAL_TOOL_STALE_MS) {
        this.sessions.set(id, { ...s, state: "stale", lastSeenAt: iso(now) });
      }
    }
  }

  byAgent(agent: string): ExternalToolSession[] {
    return [...this.sessions.values()]
      .filter((s) => s.agent === agent && s.state === "active" && activeKind(s.kind))
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }

  summary(agent: string): ExternalToolsSummaryVM | undefined {
    const active = this.byAgent(agent);
    if (!active.length) return undefined;
    const kinds = [...new Set(active.map((s) => s.kind).filter(activeKind))];
    const strongestConfidence = active.reduce<ExternalToolConfidence>((best, s) => CONFIDENCE_RANK[s.confidence] > CONFIDENCE_RANK[best] ? s.confidence : best, "weak");
    return {
      active: active.length,
      kinds,
      strongestConfidence,
      items: active.map(toItem),
    };
  }

  all(): ExternalToolSession[] {
    return [...this.sessions.values()];
  }

  private eventPath(): string | undefined {
    return this.workspaceRoot ? path.join(this.workspaceRoot, ".tachyon", "external-tools", "events.jsonl") : undefined;
  }

  private ingestEvents(): void {
    const file = this.eventPath();
    if (!file) return;
    let data: string;
    try {
      data = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    const chunk = data.slice(this.eventOffset);
    this.eventOffset = data.length;
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as ExternalToolInput & { event?: string };
        if (event.event === "launch" && event.agent && event.tool && event.kind && event.source && event.confidence) this.upsert(event);
        if (event.event === "exit" && event.id) this.clear(event.id);
      } catch {
        // Diagnostics only; malformed event lines must not break the sidebar path.
      }
    }
  }
}
