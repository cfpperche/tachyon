import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLogManager } from "../../src/webview/ActivityLogManager.js";
import { agentLogId } from "../../src/activity/logStore.js";

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
