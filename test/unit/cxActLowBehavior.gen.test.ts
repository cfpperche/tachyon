import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLog } from "@tachyon/engine/activity/logStore.js";
import { ActivityLogWriter } from "@tachyon/engine/activity/logWriter.js";
import { resolveOpencodeStorageSession } from "@tachyon/engine/workspace/opencodeStorage.js";

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

  it("revisiting a previously-tracked opencode session does not re-emit its already-logged content", () => {
    const root = freshRoot();
    const cwd = path.join(root, "agent-cwd");
    const dataHome = path.join(root, "data");
    const storage = path.join(dataHome, "opencode", "storage");
    fs.mkdirSync(cwd, { recursive: true });
    writeOpencodeProject(storage, "proj_agent", cwd);
    writeOpencodeSession(storage, "proj_agent", "ses_a", cwd, [{ id: "msg_a", role: "assistant", text: "part one", created: 1 }]);
    writeOpencodeSession(storage, "proj_agent", "ses_b", cwd, [{ id: "msg_b", role: "assistant", text: "turn B", created: 2 }]);

    const adir = path.join(root, ".tachyon", "activity");
    const writer = new ActivityLogWriter(adir, "opencode-agent-revisit", () => "2026-07-08T12:00:00.000Z");
    // ses_a's message gains a second part BETWEEN two polls of the same session — a streamed reply ingested
    // across more than one poll, the ordinary case that exposes a per-session cursor reset.
    expect(writer.poll({ path: storage, sessionId: "ses_a", runtime: "opencode" })).toBe(1);
    addOpencodePart(storage, "ses_a", "msg_a", "prt_a2", "part one plus two", 2);
    expect(writer.poll({ path: storage, sessionId: "ses_a", runtime: "opencode" })).toBe(1);

    // Rotate away, then revisit ses_a with no new content — should be a boundary only, zero new content events.
    expect(writer.poll({ path: storage, sessionId: "ses_b", runtime: "opencode" })).toBe(2);
    expect(writer.poll({ path: storage, sessionId: "ses_a", runtime: "opencode" })).toBe(1);

    const events = new ActivityLog(adir, "opencode-agent-revisit").readTail(10);
    expect(events.map((e) => [e.type, (e.payload as { text?: string }).text])).toEqual([
      ["assistant.message.completed", "part one"],
      ["assistant.message.completed", "part one plus two"],
      ["session.boundary", undefined],
      ["assistant.message.completed", "turn B"],
      ["session.boundary", undefined],
    ]);
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

function addOpencodePart(
  storage: string,
  sessionId: string,
  messageId: string,
  partId: string,
  text: string,
  created: number,
): void {
  fs.mkdirSync(path.join(storage, "part", messageId), { recursive: true });
  fs.writeFileSync(path.join(storage, "part", messageId, `${partId}.json`), JSON.stringify({
    id: partId,
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
    time: { created },
  }));
}
