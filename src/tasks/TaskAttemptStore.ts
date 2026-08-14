import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TASK_ID_RE, type TaskAttemptEndType, type TaskAttemptEvent } from "@tachyon/shared/tasks/types.js";

interface AttemptInput {
  agent: string;
  evidence: string;
  now?: string;
  origin?: "observed" | "backfill";
  inferredFromUpdatedAt?: string;
}

interface AttemptEndInput extends AttemptInput {
  type: TaskAttemptEndType;
  attemptId: string;
}

export class TaskAttemptStore {
  constructor(private readonly workspaceRoot: string) {}

  get dir(): string {
    return path.join(this.workspaceRoot, ".tachyon", "tasks");
  }

  pathFor(taskId: string): string {
    assertTaskId(taskId);
    return path.join(this.dir, `${taskId}.attempts`);
  }

  read(taskId: string): TaskAttemptEvent[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.pathFor(taskId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const lines = raw.split("\n");
    const events: TaskAttemptEvent[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!.trim();
      if (!line) continue;
      try {
        const event = normalizeEvent(JSON.parse(line));
        if (event) events.push(event);
      } catch {
        // An interrupted append can leave only the final line torn. Earlier corruption is not hidden.
        if (index !== lines.length - 1) throw new Error(`invalid attempt event in '${this.pathFor(taskId)}' at line ${index + 1}`);
      }
    }
    return events;
  }

  open(taskId: string): Extract<TaskAttemptEvent, { type: "claimed" }> | undefined {
    const events = this.read(taskId);
    const ended = new Set(events.filter((event) => event.type !== "claimed").map((event) => event.attemptId));
    return [...events].reverse().find((event): event is Extract<TaskAttemptEvent, { type: "claimed" }> => event.type === "claimed" && !ended.has(event.attemptId));
  }

  claim(taskId: string, input: AttemptInput): Extract<TaskAttemptEvent, { type: "claimed" }> {
    const existing = this.open(taskId);
    if (existing) throw new Error(`task '${taskId}' already has open attempt '${existing.attemptId}' for agent '${existing.agent}'`);
    const event: Extract<TaskAttemptEvent, { type: "claimed" }> = {
      type: "claimed",
      attemptId: `a-${crypto.randomBytes(6).toString("hex")}`,
      agent: required(input.agent, "agent"),
      ts: input.now ?? new Date().toISOString(),
      evidence: required(input.evidence, "evidence"),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.inferredFromUpdatedAt ? { inferredFromUpdatedAt: input.inferredFromUpdatedAt } : {}),
    };
    this.append(taskId, event);
    return event;
  }

  end(taskId: string, input: AttemptEndInput): Exclude<TaskAttemptEvent, { type: "claimed" }> {
    const open = this.open(taskId);
    if (!open || open.attemptId !== input.attemptId) throw new Error(`task '${taskId}' has no open attempt '${input.attemptId}'`);
    if (open.agent !== input.agent) throw new Error(`attempt '${input.attemptId}' belongs to '${open.agent}', not '${input.agent}'`);
    const event: Exclude<TaskAttemptEvent, { type: "claimed" }> = {
      type: input.type,
      attemptId: input.attemptId,
      agent: required(input.agent, "agent"),
      ts: input.now ?? new Date().toISOString(),
      evidence: required(input.evidence, "evidence"),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.inferredFromUpdatedAt ? { inferredFromUpdatedAt: input.inferredFromUpdatedAt } : {}),
    };
    this.append(taskId, event);
    return event;
  }

  /** Backfill may need one terminal event because the historical claim timestamp is unknowable. */
  appendBackfill(taskId: string, event: TaskAttemptEvent): void {
    if (this.read(taskId).length > 0 || fs.existsSync(this.pathFor(taskId))) return;
    this.append(taskId, event);
  }

  private append(taskId: string, event: TaskAttemptEvent): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.pathFor(taskId), `${JSON.stringify(event)}\n`, "utf8");
  }
}

function normalizeEvent(value: unknown): TaskAttemptEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<TaskAttemptEvent>;
  if (!(["claimed", "released", "delivered", "dropped"] as const).includes(row.type as TaskAttemptEvent["type"])) return undefined;
  if ([row.attemptId, row.agent, row.ts, row.evidence].some((field) => typeof field !== "string" || !field.trim())) return undefined;
  return row as TaskAttemptEvent;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function assertTaskId(id: string): void {
  if (!TASK_ID_RE.test(id)) throw new Error(`invalid task id '${id}'`);
}
