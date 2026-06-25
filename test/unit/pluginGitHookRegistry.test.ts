import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitHookStore, GitHookStoreError, snapshotIntegrity, type EventEntry } from "../../src/plugins/gitHookRegistry.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function ws(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-ghreg-")); dirs.push(d); return d; }

describe("GitHookStore (spec 264)", () => {
  it("stores leaves by content address, idempotently and executably", () => {
    const s = new GitHookStore(ws());
    const h1 = s.putLeaf("#!/bin/sh\necho a\n");
    const h2 = s.putLeaf("#!/bin/sh\necho a\n"); // identical content → same hash, no error
    const h3 = s.putLeaf("#!/bin/sh\necho b\n");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(s.hasLeaf(h1)).toBe(true);
    expect(fs.statSync(s.leafFile(h1)).mode & 0o111).toBeTruthy(); // executable
  });

  it("publishes + reads back a snapshot, validating integrity", () => {
    const s = new GitHookStore(ws());
    const lh = s.putLeaf("#!/bin/sh\nexit 0\n");
    const events: Record<string, EventEntry> = { "pre-commit": { priorHook: null, leaves: [{ pluginId: "sdd", contentHash: lh }] } };
    s.writeSnapshot(1, events);
    const snap = s.readSnapshot();
    expect(snap?.generation).toBe(1);
    expect(snap?.events["pre-commit"].leaves[0].pluginId).toBe("sdd");
    expect(snap?.integrity).toBe(snapshotIntegrity(1, events));
  });

  it("fail-closes on a tampered snapshot (integrity mismatch)", () => {
    const s = new GitHookStore(ws());
    const lh = s.putLeaf("x");
    s.writeSnapshot(1, { "pre-commit": { priorHook: null, leaves: [{ pluginId: "sdd", contentHash: lh }] } });
    // tamper: flip a field without recomputing integrity
    const f = path.join(s.dir(), "registry.json");
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.events["pre-commit"].leaves[0].pluginId = "evil";
    fs.writeFileSync(f, JSON.stringify(j));
    expect(() => s.readSnapshot()).toThrow(GitHookStoreError);
  });

  it("fail-closes when a snapshot references a missing leaf", () => {
    const s = new GitHookStore(ws());
    const events: Record<string, EventEntry> = { "pre-commit": { priorHook: null, leaves: [{ pluginId: "sdd", contentHash: "deadbeef".repeat(8) }] } };
    s.writeSnapshot(1, events); // referenced leaf was never put
    expect(() => s.readSnapshot()).toThrow(/missing leaf/);
  });

  it("absent snapshot/ownership read as undefined; round-trips ownership", () => {
    const s = new GitHookStore(ws());
    expect(s.readSnapshot()).toBeUndefined();
    expect(s.readOwnership()).toBeUndefined();
    s.writeOwnership({ schema: 1, claimedFrom: ".husky", managedPath: ".tachyon/githooks", leafRefs: 2, generation: 3 });
    expect(s.readOwnership()).toEqual({ schema: 1, claimedFrom: ".husky", managedPath: ".tachyon/githooks", leafRefs: 2, generation: 3 });
  });

  it("fail-closes on a malformed ownership record", () => {
    const s = new GitHookStore(ws());
    fs.mkdirSync(s.dir(), { recursive: true });
    fs.writeFileSync(path.join(s.dir(), "ownership.json"), JSON.stringify({ schema: 2 }));
    expect(() => s.readOwnership()).toThrow(GitHookStoreError);
  });

  it("the repo lock is exclusive and releasable", async () => {
    const s = new GitHookStore(ws());
    const release = await s.acquireLock();
    await expect(s.acquireLock(150)).rejects.toThrow(/in progress|held/);
    release();
    const r2 = await s.acquireLock(150); // free again
    r2();
  });
});
