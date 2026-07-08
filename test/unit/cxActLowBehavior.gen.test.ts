import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLog } from "../../src/activity/logStore.js";
import { ActivityLogWriter } from "../../src/activity/logWriter.js";
import { resolveOpencodeStorageSession } from "../../src/workspace/opencodeStorage.js";

const roots: string[] = [];
function freshRoot(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), "cx-act-low-")); roots.push(d); return d; }
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("container-generated delegation behavior", () => {
  it("opencode session rotation emits a boundary event and session resolution scans only the project partition", () => {
    const root = freshRoot();
    const cwd = path.join(root, "agent-cwd");
    const dataHome = path.join(root, "data");
    const storage = path.join(dataHome, "opencode", "storage");
    fs.mkdirSync(cwd, { recursive: true });
    writeOpencodeProject(storage, "proj_agent", cwd);
    writeOpencodeProject(storage, "proj_foreign", path.join(root, "foreign-cwd"));
    writeOpencodeSession(storage, "proj_agent", "ses_a", cwd, [{ id: "msg_a", role: "assistant", text: "turn A", created: 1 }]);
    writeOpencodeSession(storage, "proj_agent", "ses_b", cwd, [{ id: "msg_b", role: "assistant", text: "turn B", created: 2 }]);
    writeOpencodeSession(storage, "proj_foreign", "ses_decoy", cwd, [{ id: "msg_decoy", role: "assistant", text: "decoy", created: 3 }]);
    fs.utimesSync(path.join(storage, "session", "proj_agent", "ses_a.json"), new Date(1_000), new Date(1_000));
    fs.utimesSync(path.join(storage, "session", "proj_agent", "ses_b.json"), new Date(2_000), new Date(2_000));
    fs.utimesSync(path.join(storage, "session", "proj_foreign", "ses_decoy.json"), new Date(3_000), new Date(3_000));

    const adir = path.join(root, ".tachyon", "activity");
    const writer = new ActivityLogWriter(adir, "opencode-agent", () => "2026-07-08T12:00:00.000Z");
    expect(writer.poll({ path: storage, sessionId: "ses_a", runtime: "opencode" })).toBe(1);
    expect(writer.poll({ path: storage, sessionId: "ses_b", runtime: "opencode" })).toBe(2);
    const events = new ActivityLog(adir, "opencode-agent").readTail(10);
    expect(events.map((e) => [e.type, (e.payload as { text?: string }).text])).toEqual([
      ["assistant.message.completed", "turn A"],
      ["session.boundary", undefined],
      ["assistant.message.completed", "turn B"],
    ]);
    expect(events.find((e) => e.type === "session.boundary")?.payload).toEqual({
      fromSession: "ses_a",
      toSession: "ses_b",
      reason: "new",
    });

    // The foreign decoy has the same directory and a newer mtime, so it would win if resolution still scanned
    // the whole session tree after resolving projectId.
    expect(resolveOpencodeStorageSession(cwd, dataHome)).toEqual({ id: "ses_b", path: storage });
  });
});

function writeOpencodeProject(storage: string, projectId: string, worktree: string): void {
  fs.mkdirSync(path.join(storage, "project"), { recursive: true });
  fs.writeFileSync(path.join(storage, "project", `${projectId}.json`), JSON.stringify({ id: projectId, worktree }));
}

function writeOpencodeSession(
  storage: string,
  projectId: string,
  sessionId: string,
  directory: string,
  messages: Array<{ id: string; role: "user" | "assistant"; text: string; created: number }>,
): void {
  fs.mkdirSync(path.join(storage, "session", projectId), { recursive: true });
  fs.writeFileSync(path.join(storage, "session", projectId, `${sessionId}.json`), JSON.stringify({
    id: sessionId,
    projectID: projectId,
    directory,
    time: { created: messages[0]?.created ?? 0, updated: messages.at(-1)?.created ?? 0 },
  }));
  fs.mkdirSync(path.join(storage, "message", sessionId), { recursive: true });
  for (const message of messages) {
    fs.writeFileSync(path.join(storage, "message", sessionId, `${message.id}.json`), JSON.stringify({
      id: message.id,
      sessionID: sessionId,
      role: message.role,
      time: { created: message.created },
    }));
    fs.mkdirSync(path.join(storage, "part", message.id), { recursive: true });
    fs.writeFileSync(path.join(storage, "part", message.id, `prt_${message.id}.json`), JSON.stringify({
      id: `prt_${message.id}`,
      sessionID: sessionId,
      messageID: message.id,
      type: "text",
      text: message.text,
      time: { created: message.created },
    }));
  }
}
