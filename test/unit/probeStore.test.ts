import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProbeStore, mintRunId, type ProbeRunMeta } from "../../src/probe/ProbeStore.js";
import { envelopeFor, type ProbeResult } from "../../src/probe/taxonomy.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-store-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function result(): ProbeResult {
  return { reason: "ok", lastMessage: "hi", exitCode: 0, timedOut: false, native: { runtime: "claude" } };
}
function meta(runId: string): ProbeRunMeta {
  return { runId, runtime: "claude", adapterVersion: "1", binaryVersion: "1.2.3", createdAt: new Date(0).toISOString() };
}

describe("ProbeStore — publish + read back", () => {
  it("round-trips the envelope + metadata atomically", async () => {
    const store = new ProbeStore(root);
    const runId = mintRunId();
    await store.writeResult(envelopeFor(runId, result()), meta(runId));
    const back = await store.readResult(runId);
    expect(back?.envelope.status).toBe("completed");
    expect(back?.envelope.result?.reason).toBe("ok");
    expect(back?.meta.binaryVersion).toBe("1.2.3");
  });

  it("round-trips requested and reported model provenance distinctly", async () => {
    const store = new ProbeStore(root);
    const runId = mintRunId();
    await store.writeResult(envelopeFor(runId, result()), {
      ...meta(runId), requestedModel: "claude-opus-5", reportedModels: ["claude-opus-5"],
    });
    expect((await store.readResult(runId))?.meta).toMatchObject({
      requestedModel: "claude-opus-5", reportedModels: ["claude-opus-5"],
    });
  });

  it("readResult returns null for an unknown run", async () => {
    expect(await new ProbeStore(root).readResult(mintRunId())).toBeNull();
  });
});

describe("ProbeStore — artifact size cap (D9)", () => {
  it("truncates an oversized artifact and flags it", async () => {
    const store = new ProbeStore(root, { maxArtifactBytes: 100 });
    const runId = mintRunId();
    const { truncated, path: p } = await store.writeArtifact(runId, "events.jsonl", "x".repeat(5000));
    expect(truncated).toBe(true);
    const written = await fs.readFile(p, "utf8");
    expect(written.length).toBeLessThan(5000);
    expect(written).toContain("[truncated]");
  });

  it("does not truncate a small artifact", async () => {
    const store = new ProbeStore(root, { maxArtifactBytes: 100 });
    const runId = mintRunId();
    const { truncated } = await store.writeArtifact(runId, "events.jsonl", "small");
    expect(truncated).toBe(false);
  });
});

describe("ProbeStore — bounded retention (OQ2)", () => {
  it("prunes runs beyond maxRuns, keeping the newest", async () => {
    const store = new ProbeStore(root, { maxRuns: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const runId = mintRunId();
      ids.push(runId);
      await store.writeResult(envelopeFor(runId, result()), meta(runId));
      // bump mtime ordering deterministically
      const t = (i + 1) * 1000;
      await fs.utimes(store.dirFor(runId), new Date(t), new Date(t));
    }
    const { removed } = await store.prune(10_000);
    expect(removed).toHaveLength(2);
    // the two newest (ids[2], ids[3]) survive
    expect(await store.readResult(ids[3]!)).not.toBeNull();
    expect(await store.readResult(ids[0]!)).toBeNull();
  });

  it("prunes runs older than maxAgeMs", async () => {
    const store = new ProbeStore(root, { maxRuns: 100, maxAgeMs: 5000 });
    const oldId = mintRunId();
    await store.writeResult(envelopeFor(oldId, result()), meta(oldId));
    await fs.utimes(store.dirFor(oldId), new Date(1000), new Date(1000));
    const { removed } = await store.prune(10_000); // now=10s, age 9s > 5s cap
    expect(removed).toContain(oldId);
  });
});

describe("ProbeStore — path containment", () => {
  it("rejects an unsafe runId (traversal / separators)", () => {
    const store = new ProbeStore(root);
    expect(() => store.dirFor("../escape")).toThrow(/unsafe/);
    expect(() => store.dirFor("a/b")).toThrow(/unsafe/);
  });
});
