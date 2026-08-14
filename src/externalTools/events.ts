import fs from "node:fs";
import path from "node:path";
import type { ExternalToolInput } from "@tachyon/engine/externalTools/registry.js";
import { externalToolSessionId } from "@tachyon/engine/externalTools/registry.js";

export function appendExternalToolEvent(workspaceRoot: string, event: ExternalToolInput & { event: "launch" | "exit" }): string | undefined {
  const id = event.id ?? externalToolSessionId(event);
  const safe = {
    event: event.event,
    id,
    agent: event.agent,
    kind: event.kind,
    tool: event.tool,
    source: event.source,
    confidence: event.confidence,
    ...(event.startedAt ? { startedAt: event.startedAt } : {}),
    ...(event.lastSeenAt ? { lastSeenAt: event.lastSeenAt } : {}),
    ...(event.pid !== undefined ? { pid: event.pid } : {}),
    ...(event.windowId ? { windowId: event.windowId } : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.commandLabel ? { commandLabel: event.commandLabel.slice(0, 80) } : {}),
    ...(event.state ? { state: event.state } : {}),
  };
  const dir = path.join(workspaceRoot, ".tachyon", "external-tools");
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify(safe)}\n`, { encoding: "utf8" });
    return id;
  } catch {
    return undefined;
  }
}

