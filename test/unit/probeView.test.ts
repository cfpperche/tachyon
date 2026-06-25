import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildProbeView, relativeAge } from "../../src/probe/probeView.js";
import { ProbeStore, mintRunId } from "../../src/probe/ProbeStore.js";
import { envelopeFor, runningEnvelope } from "../../src/probe/taxonomy.js";
import type { ProbeRunRecord } from "../../src/probe/ProbeStore.js";

const NOW = Date.parse("2026-06-24T12:00:00Z");

describe("probeView — relativeAge", () => {
  it("formats seconds/minutes/hours/days and handles a bad timestamp", () => {
    expect(relativeAge("2026-06-24T11:59:30Z", NOW)).toBe("30s ago");
    expect(relativeAge("2026-06-24T11:30:00Z", NOW)).toBe("30m ago");
    expect(relativeAge("2026-06-24T09:00:00Z", NOW)).toBe("3h ago");
    expect(relativeAge("2026-06-22T12:00:00Z", NOW)).toBe("2d ago");
    expect(relativeAge("not-a-date", NOW)).toBe("—");
  });
});

describe("probeView — buildProbeView (pure render-model, D9)", () => {
  const rec = (over: Partial<ProbeRunRecord>): ProbeRunRecord => ({
    runId: "probe-abcdef12-0000",
    runtime: "claude",
    createdAt: "2026-06-24T11:59:00Z",
    status: "completed",
    ...over,
  });

  it("derives counts, short ids, and normalized excerpts", () => {
    const view = buildProbeView(
      [
        rec({ runId: "probe-aaaaaaaa-1", status: "completed", reason: "ok", archetype: "adversarial-review", excerpt: "the\n  answer" }),
        rec({ runId: "probe-bbbbbbbb-2", status: "failed", reason: "budget" }),
        rec({ runId: "probe-cccccccc-3", status: "running" }),
      ],
      NOW,
    );
    expect(view.total).toBe(3);
    expect(view.completed).toBe(1);
    expect(view.failed).toBe(1);
    expect(view.running).toBe(1);
    expect(view.empty).toBe(false);
    expect(view.rows[0]!.shortId).toBe("aaaaaaaa");
    expect(view.rows[0]!.excerpt).toBe("the answer"); // whitespace collapsed
    expect(view.rows[0]!.archetype).toBe("adversarial-review");
    expect(view.rows[1]!.reason).toBe("budget");
    expect(view.rows[2]!.reason).toBe("—"); // running has no reason
  });

  it("is empty for no records", () => {
    expect(buildProbeView([], NOW).empty).toBe(true);
  });
});

describe("probeView — fed from a real ProbeStore.list()", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-view-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("list() summarizes completed + in-flight runs, newest first", async () => {
    const store = new ProbeStore(root);
    const done = mintRunId();
    await store.writeResult(envelopeFor(done, { reason: "ok", lastMessage: "done", exitCode: 0, timedOut: false, native: { runtime: "claude" } }), {
      runId: done,
      runtime: "claude",
      adapterVersion: "1",
      createdAt: "2026-06-24T10:00:00Z",
    });
    const running = mintRunId();
    await store.writeMeta({ runId: running, runtime: "codex", adapterVersion: "1", createdAt: "2026-06-24T11:00:00Z" });

    const records = await store.list();
    expect(records).toHaveLength(2);
    const view = buildProbeView(records, NOW);
    expect(view.rows[0]!.status).toBe("running"); // 11:00 newer than 10:00
    expect(view.rows[0]!.runtime).toBe("codex");
    expect(view.rows[1]!.status).toBe("completed");
    expect(view.completed).toBe(1);
    expect(view.running).toBe(1);
    // a no-op reference so the import is exercised even if unused above
    expect(runningEnvelope(running).status).toBe("running");
  });
});
