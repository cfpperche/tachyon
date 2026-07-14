import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLogManager } from "../../src/webview/ActivityLogManager.js";
import { appendOwnerRow, latestOwnerFor, readSessionOwners, resolveRotationFollow, sessionOwnersFile } from "../../src/activity/sessionOwners.js";
import { RuntimeOpsSnapshotService } from "../../src/runtimeOps/snapshotService.js";
import type { LoggedEvent } from "../../src/activity/logStore.js";

/**
 * t-9f2641 — behavior gate: a harness-driven resume (or any rotation that keeps the process alive) mints a
 * new claude transcript with no ownership row naming it (the hook that would have recorded it never fired).
 * Without a fix, the activity resolver stays pinned to the now-dead transcript forever and the spec-378
 * observed-model label freezes with it. This suite proves, end to end:
 *  1. an unambiguous mid-run rotation is followed and recorded durably (source "rotation-follow"),
 *  2. two same-cwd claude agents can never steal each other's rotation (never-guess is sacred),
 *  3. a legitimately quiet (but not rotated) session is never mistaken for a dead one, and
 *  4. the boundary the follow emits is PROCESS-PRESERVING — the observed model survives it, flagged stale,
 *     not demoted the way a true process restart would demote it.
 */

const freshDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "ownrot4-behavior-"));

function transcriptDir(files: Record<string, number>): string {
  const dir = freshDir();
  for (const [name, mtimeMs] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, "{}\n", "utf8");
    const t = new Date(mtimeMs);
    fs.utimesSync(p, t, t);
  }
  return dir;
}

describe("container-generated delegation behavior", () => {
  it("ownrot5Behavior", () => {
    // Canonical gate for t-9f2641: an unambiguous mid-run rotation is found and durably recorded.
    const dir = transcriptDir({ "8f1c4ed7.jsonl": 5000 });
    const deadPath = path.join(dir, "58472e90.jsonl");
    fs.writeFileSync(deadPath, "{}\n", "utf8");
    fs.utimesSync(deadPath, new Date(1000), new Date(1000));

    const follow = resolveRotationFollow([], "coordinator", deadPath);
    expect(follow).toEqual({ transcriptPath: path.join(dir, "8f1c4ed7.jsonl"), sessionId: "8f1c4ed7" });

    const ownersFile = sessionOwnersFile(dir);
    appendOwnerRow(ownersFile, {
      agent: "coordinator", sessionId: follow!.sessionId, transcriptPath: follow!.transcriptPath,
      cwd: "/repo", source: "rotation-follow", ts: "2026-07-14T11:00:00.000Z",
    });
    const rows = readSessionOwners(ownersFile);
    expect(latestOwnerFor(rows, "coordinator", "/repo")).toMatchObject({ sessionId: "8f1c4ed7", source: "rotation-follow" });
  });
});

describe("ownrot5Behavior — mid-run transcript rotation follow (t-9f2641)", () => {
  it("never-guess: two agents sharing one (cwd, config home) directory can never steal each other's rotation", () => {
    const dir = transcriptDir({ "sib-old.jsonl": 1000, "sib-new.jsonl": 5000 });
    const rows = [{ agent: "sibling", sessionId: "sib-old", transcriptPath: path.join(dir, "sib-old.jsonl"), cwd: "/repo", source: "startup", ts: "t" }];
    // "me" resolved to a dead transcript in the SAME directory sibling owns — ambiguous, must stay pinned.
    expect(resolveRotationFollow(rows, "me", path.join(dir, "sib-old.jsonl"))).toBeUndefined();
    // sibling following its OWN rotation is fine — the ambiguity check only ever looks at OTHER agents' rows.
    expect(resolveRotationFollow(rows, "sibling", path.join(dir, "sib-old.jsonl"))?.sessionId).toBe("sib-new");
  });

  it("ActivityLogManager follows a stalled dead transcript within one re-resolve cycle once the threshold passes, and stays pinned when ambiguous", async () => {
    const ws = freshDir();
    let now = 0;
    const oldPath = path.join(ws, "old.jsonl");
    const newPath = path.join(ws, "new.jsonl");
    fs.writeFileSync(oldPath, "{}\n", "utf8");
    fs.utimesSync(oldPath, new Date(1000), new Date(1000));
    fs.writeFileSync(newPath, "{}\n", "utf8");

    const wsStub = {
      workspaceRoot: ws,
      wsHash: "h",
      ledger: {
        all: () => [["coordinator", { resume: { runtime: "claude", sessionId: "old" }, declared: true, cwd: "/repo" }]] as Array<[string, unknown]>,
        get: () => ({ resume: { runtime: "claude", sessionId: "old" }, declared: true, cwd: "/repo" }),
      },
      manager: { transcriptPathOf: async () => ({ path: oldPath, runtime: "claude" as const }) },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new ActivityLogManager(() => [wsStub as any], 9999, 0, undefined, () => now);
    const noteCalls: Array<[string, boolean]> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any).writers.set("h::coordinator", { writer: { poll: () => 0, noteLifecycle: (a: string, r?: boolean) => noteCalls.push([a, !!r]) }, resolvedAt: 0 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mgr as any).tick(); // establishes the stall baseline — no growth observed yet, must NOT follow early
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mgr as any).writers.get("h::coordinator").loc?.path).toBe(oldPath);

    now = 61_000; // past ROTATION_DEAD_THRESHOLD_MS with zero growth on oldPath
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mgr as any).tick();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mgr as any).writers.get("h::coordinator").loc).toEqual({ path: newPath, sessionId: "new", runtime: "claude" });
    expect(noteCalls).toEqual([["rotation-follow", true]]);
    expect(readSessionOwners(sessionOwnersFile(ws))[0]).toMatchObject({ agent: "coordinator", sessionId: "new", source: "rotation-follow" });
  });

  it("quiet-session: a resolved transcript with no newer sibling stays pinned even past the stall threshold (legitimately silent, not dead)", async () => {
    const ws = freshDir();
    let now = 0;
    const onlyPath = path.join(ws, "only.jsonl");
    fs.writeFileSync(onlyPath, "{}\n", "utf8");
    fs.utimesSync(onlyPath, new Date(1000), new Date(1000)); // no sibling ever appears — this agent just went quiet

    const wsStub = {
      workspaceRoot: ws,
      wsHash: "h",
      ledger: {
        all: () => [["coordinator", { resume: { runtime: "claude", sessionId: "only" }, declared: true, cwd: "/repo" }]] as Array<[string, unknown]>,
        get: () => ({ resume: { runtime: "claude", sessionId: "only" }, declared: true, cwd: "/repo" }),
      },
      manager: { transcriptPathOf: async () => ({ path: onlyPath, runtime: "claude" as const }) },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new ActivityLogManager(() => [wsStub as any], 9999, 0, undefined, () => now);
    const noteCalls: Array<[string, boolean]> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mgr as any).writers.set("h::coordinator", { writer: { poll: () => 0, noteLifecycle: (a: string, r?: boolean) => noteCalls.push([a, !!r]) }, resolvedAt: 0 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mgr as any).tick();
    now = 61_000; // past the stall threshold, but there is no newer sibling to follow
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mgr as any).tick();
    now = 600_000; // stays quiet indefinitely — still no rotation, must never be "followed" into nowhere
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mgr as any).tick();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mgr as any).writers.get("h::coordinator").loc?.path).toBe(onlyPath);
    expect(noteCalls).toEqual([]);
    expect(readSessionOwners(sessionOwnersFile(ws))).toEqual([]);
  });

  it("the rotation-follow boundary is PROCESS-PRESERVING: the observed model is kept and flagged stale, never demoted", async () => {
    const boundary = (reason: string): LoggedEvent => ({
      schemaVersion: 1, type: "session.boundary", timestamp: "2026-07-14T11:00:00.000Z",
      payload: { fromSession: "old", toSession: "new", reason },
      source: { runtime: "claude", sessionId: "new", sourcePath: "/private/new.jsonl" },
      loggedAt: "2026-07-14T11:00:00.000Z",
    });
    const modelEvent: LoggedEvent = {
      schemaVersion: 1, type: "assistant.message.completed", timestamp: "2026-07-14T10:00:00.000Z",
      payload: { text: "x" }, source: { runtime: "claude", sessionId: "old", sourcePath: "/private/old.jsonl" },
      loggedAt: "2026-07-14T10:00:00.000Z", model: "claude-sonnet-5",
    };
    const staticLog = (events: LoggedEvent[]) => ({
      tailFrom: () => ({ events, offset: events.length, partial: Buffer.alloc(0) }),
      forwardFrom: (offset: number, partial: Buffer) => ({ events: [], offset, partial }),
      size: () => events.length,
    });
    const record = { cwd: "/repo", declared: true, updatedAt: "2026-07-14T11:00:00.000Z", resume: { runtime: "claude" as const, sessionId: "new" } };
    const workspace = { workspaceRoot: "/repo", wsHash: "ws", folderName: "repo", ledger: { all: () => new Map([["coordinator", record]]) } };

    // A true process restart demotes the observation entirely — the contrast case.
    const restarted = new RuntimeOpsSnapshotService(() => [workspace], {
      detect: async () => [], activityLog: () => staticLog([modelEvent, boundary("restarted")]),
    });
    expect(restarted.observedModelFor("/repo", "ws", "coordinator")).toBeUndefined();

    // rotation-follow keeps the process alive — the observation must survive, flagged stale.
    const rotated = new RuntimeOpsSnapshotService(() => [workspace], {
      detect: async () => [], activityLog: () => staticLog([modelEvent, boundary("rotation-follow")]),
    });
    expect(rotated.observedModelFor("/repo", "ws", "coordinator")).toMatchObject({ id: "claude-sonnet-5", stale: true });
  });
});
