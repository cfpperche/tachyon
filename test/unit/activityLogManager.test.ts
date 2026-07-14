import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLogManager, sessionIdFromTranscriptPath } from "../../src/webview/ActivityLogManager.js";
import { agentLogId } from "../../src/activity/logStore.js";
import { readSessionOwners, sessionOwnersFile } from "../../src/activity/sessionOwners.js";

const dirs: string[] = [];
const freshDir = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "alm-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("ActivityLogManager — mid-tick dismiss race (pin p-4dadd3)", () => {
  it("skips poll for a row removed during the resolve await, so it never resurrects the just-deleted log", async () => {
    const ws = freshDir();
    const actDir = path.join(ws, ".tachyon", "activity");
    fs.mkdirSync(actDir, { recursive: true });
    const logFile = path.join(actDir, `${agentLogId("eph")}.jsonl`);
    fs.writeFileSync(logFile, '{"schemaVersion":1}\n', "utf8"); // a writer had been logging this ephemeral

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec = { resume: { runtime: "claude", sessionId: "s1" }, declared: false } as any;
    let present = true; // the ledger row exists until a dismiss lands mid-tick
    const wsStub = {
      workspaceRoot: ws,
      wsHash: "h",
      ledger: {
        all: () => [["eph", rec]] as Array<[string, unknown]>, // snapshot at top of tick still has the row
        get: (_n: string) => (present ? rec : undefined),
      },
      manager: {
        // the await that yields: a dismiss removes the row AND deletes the durable log right here
        transcriptPathOf: async () => {
          present = false;
          fs.rmSync(logFile, { force: true });
          return { path: path.join(ws, "transcript.jsonl"), runtime: "claude" };
        },
      },
    };

    // resolveEveryMs=0 forces the transcriptPathOf await every tick (reproduces the race window deterministically).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new ActivityLogManager(() => [wsStub as any], 9999, 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mgr as any).tick();

    const key = "h::eph";
    // The guard dropped the writer via its `continue` — NOT the end-of-tick reap, which can't fire here
    // (`live` was built from the snapshot, so it still contains the key).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mgr as any).writers.has(key)).toBe(false);
    expect(fs.existsSync(logFile)).toBe(false); // poll was skipped → orphan stays deleted, not resurrected
  });
});

describe("ActivityLogManager append notification (spec 367)", () => {
  it("emits one bounded callback only when poll persisted events", async () => {
    const rec = { resume: { runtime: "claude", sessionId: "s1" }, declared: true };
    const wsStub = {
      workspaceRoot: "/workspace",
      wsHash: "hash",
      ledger: { all: () => new Map([["agent", rec]]), get: () => rec },
      manager: { transcriptPathOf: async () => undefined },
    };
    const appended: Array<{ hash: string; agent: string; count: number }> = [];
    const manager = new ActivityLogManager(
      () => [wsStub as never],
      9999,
      9999,
      (hash, agent, count) => appended.push({ hash, agent, count }),
    );
    const writers = (manager as unknown as { writers: Map<string, unknown> }).writers;
    writers.set("hash::agent", { writer: { poll: () => 2 }, loc: undefined, resolvedAt: Date.now() });

    await (manager as unknown as { tick(): Promise<void> }).tick();
    expect(appended).toEqual([{ hash: "hash", agent: "agent", count: 2 }]);

    writers.set("hash::agent", { writer: { poll: () => 0 }, loc: undefined, resolvedAt: Date.now() });
    await (manager as unknown as { tick(): Promise<void> }).tick();
    expect(appended).toHaveLength(1);
  });
});

describe("ActivityLogManager — mid-run transcript rotation follow (t-9f2641)", () => {
  const AGENT = "claude-a";
  const CWD = "/repo";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function setup(): { ws: string; key: string; noteCalls: Array<[string, boolean]>; mgr: any; setNow: (n: number) => void } {
    const ws = freshDir();
    let now = 0;
    const wsStub = {
      workspaceRoot: ws,
      wsHash: "h",
      // transcriptPathOf CAN'T see the rotation (no ownership row was ever recorded for it) — it just keeps
      // re-handing back the same dead file, exactly like the live incident.
      ledger: { all: () => [[AGENT, { resume: { runtime: "claude", sessionId: "old" }, declared: true, cwd: CWD }]], get: () => ({ resume: { runtime: "claude", sessionId: "old" }, declared: true, cwd: CWD }) },
      manager: { transcriptPathOf: async () => ({ path: path.join(ws, "old.jsonl"), runtime: "claude" }) },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new ActivityLogManager(() => [wsStub as any], 9999, 0, undefined, () => now);
    const key = "h::claude-a";
    const noteCalls: Array<[string, boolean]> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any).writers.set(key, { writer: { poll: () => 0, noteLifecycle: (a: string, r?: boolean) => noteCalls.push([a, !!r]) }, resolvedAt: 0 });
    return { ws, key, noteCalls, mgr, setNow: (n: number) => { now = n; } };
  }

  it("follows an unambiguous newer sibling once the resolved transcript has stalled past the threshold", async () => {
    const { ws, key, noteCalls, mgr, setNow } = setup();
    const oldPath = path.join(ws, "old.jsonl");
    const newPath = path.join(ws, "new.jsonl");
    fs.writeFileSync(oldPath, "{}\n", "utf8");
    fs.utimesSync(oldPath, new Date(1000), new Date(1000));
    fs.writeFileSync(newPath, "{}\n", "utf8"); // strictly newer mtime than oldPath, minted by the rotation

    await mgr.tick(); // first resolve: establishes the dead-track baseline, no growth observed yet
    expect(mgr.writers.get(key).loc?.path).toBe(oldPath);
    expect(noteCalls).toEqual([]);

    setNow(61_000); // >= ROTATION_DEAD_THRESHOLD_MS with no growth on oldPath
    await mgr.tick();

    expect(mgr.writers.get(key).loc).toEqual({ path: newPath, sessionId: "new", runtime: "claude" });
    expect(noteCalls).toEqual([["rotation-follow", true]]);

    const rows = readSessionOwners(sessionOwnersFile(ws));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: AGENT, sessionId: "new", transcriptPath: newPath, cwd: CWD, source: "rotation-follow" });
  });

  it("never follows when another agent's current row shares the same transcript directory (never-guess stays pinned)", async () => {
    const { ws, key, noteCalls, mgr, setNow } = setup();
    const oldPath = path.join(ws, "old.jsonl");
    const newPath = path.join(ws, "new.jsonl");
    fs.writeFileSync(oldPath, "{}\n", "utf8");
    fs.utimesSync(oldPath, new Date(1000), new Date(1000));
    fs.writeFileSync(newPath, "{}\n", "utf8");

    const ownersFile = sessionOwnersFile(ws);
    fs.mkdirSync(path.dirname(ownersFile), { recursive: true });
    fs.writeFileSync(ownersFile, `${JSON.stringify({ agent: "sibling", sessionId: "sib", transcriptPath: oldPath, cwd: CWD, source: "startup", ts: "t" })}\n`, "utf8");

    await mgr.tick();
    setNow(61_000);
    await mgr.tick();

    // stayed pinned to the dead file — a same-cwd sibling's row makes the directory ambiguous, never stolen
    expect(mgr.writers.get(key).loc?.path).toBe(oldPath);
    expect(noteCalls).toEqual([]);
    expect(readSessionOwners(ownersFile)).toHaveLength(1); // no new row minted for AGENT
  });
});

describe("sessionIdFromTranscriptPath (t-9874be)", () => {
  it("uses parent dir for Grok chat_history.jsonl, basename for peers", () => {
    expect(sessionIdFromTranscriptPath(
      "/ws/.tachyon/bridge-mcp/a.grok/sessions/%2Fws/c1446c1e-57f6-4efa-95ca-7526a1880287/chat_history.jsonl",
      "grok",
    )).toBe("c1446c1e-57f6-4efa-95ca-7526a1880287");
    expect(sessionIdFromTranscriptPath("/home/me/.claude/projects/-ws/u1.jsonl", "claude")).toBe("u1");
    expect(sessionIdFromTranscriptPath("/tmp/rollout-codex.jsonl", "codex")).toBe("rollout-codex");
  });
});
