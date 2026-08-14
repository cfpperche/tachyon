import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLog } from "@tachyon/engine/activity/logStore.js";
import { ActivityLogWriter } from "@tachyon/engine/activity/logWriter.js";
import { resolveOpencodeStorageSession } from "@tachyon/engine/workspace/opencodeStorage.js";

describe("container-generated delegation behavior", () => {
  it("an opencode agent's storage messages are normalized into Activity events attributed to that agent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-activity-"));
    try {
      const cwd = path.join(root, "agent-cwd");
      const otherCwd = path.join(root, "other-cwd");
      const dataHome = path.join(root, "data");
      const storage = path.join(dataHome, "opencode", "storage");
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(otherCwd, { recursive: true });
      writeOpencodeSession(storage, "proj_agent", "ses_agent", cwd, [
        { id: "msg_user", role: "user", created: Date.UTC(2026, 6, 8, 12, 0, 0), text: "please inspect this" },
        { id: "msg_assistant", role: "assistant", created: Date.UTC(2026, 6, 8, 12, 0, 1), text: "inspection complete" },
      ]);
      writeOpencodeSession(storage, "proj_other", "ses_other", otherCwd, [
        { id: "msg_foreign", role: "assistant", created: Date.UTC(2026, 6, 8, 12, 0, 2), text: "wrong cwd" },
      ]);

      const loc = resolveOpencodeStorageSession(cwd, dataHome);
      expect(loc).toEqual({ id: "ses_agent", path: storage });
      expect(resolveOpencodeStorageSession(cwd, dataHome, "ses_other")).toBeNull();

      const adir = path.join(root, ".tachyon", "activity");
      const writer = new ActivityLogWriter(adir, "opencode-agent", () => "2026-07-08T12:00:03.000Z");
      expect(writer.poll({ path: loc!.path, sessionId: loc!.id, runtime: "opencode" })).toBe(2);
      expect(writer.poll({ path: loc!.path, sessionId: loc!.id, runtime: "opencode" })).toBe(0);

      const events = new ActivityLog(adir, "opencode-agent").readTail(10);
      expect(events.map((e) => [e.type, (e.payload as { text?: string }).text, e.sessionId, e.source.runtime])).toEqual([
        ["user.message.completed", "please inspect this", "ses_agent", "opencode"],
        ["assistant.message.completed", "inspection complete", "ses_agent", "opencode"],
      ]);
      expect(events.map((e) => (e.payload as { text?: string }).text)).not.toContain("wrong cwd");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeOpencodeSession(
  storage: string,
  projectID: string,
  sessionID: string,
  directory: string,
  messages: Array<{ id: string; role: "user" | "assistant"; created: number; text: string }>,
): void {
  fs.mkdirSync(path.join(storage, "session", projectID), { recursive: true });
  fs.writeFileSync(path.join(storage, "session", projectID, `${sessionID}.json`), JSON.stringify({
    id: sessionID,
    projectID,
    directory,
    title: "fixture",
    time: { created: messages[0]?.created ?? 0, updated: messages.at(-1)?.created ?? 0 },
  }));
  fs.mkdirSync(path.join(storage, "message", sessionID), { recursive: true });
  for (const message of messages) {
    fs.writeFileSync(path.join(storage, "message", sessionID, `${message.id}.json`), JSON.stringify({
      id: message.id,
      sessionID,
      role: message.role,
      time: { created: message.created },
      agent: message.role === "assistant" ? "build" : undefined,
      model: message.role === "assistant" ? { providerID: "openai", modelID: "gpt-5" } : undefined,
    }));
    fs.mkdirSync(path.join(storage, "part", message.id), { recursive: true });
    fs.writeFileSync(path.join(storage, "part", message.id, `prt_${message.id}.json`), JSON.stringify({
      id: `prt_${message.id}`,
      sessionID,
      messageID: message.id,
      type: "text",
      text: message.text,
    }));
  }
}
