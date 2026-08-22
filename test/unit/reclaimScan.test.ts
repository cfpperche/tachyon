import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyReclaim, scanReclaim } from "@tachyon/engine/reclaim/reclaimScan.js";
import { reclaimOnStart, runReclaim } from "@tachyon/engine/reclaim/reclaimService.js";
import { buildWorkspaceProvenance, WORKSPACE_PROVENANCE_STATE_KEY } from "@tachyon/engine/reclaim/provenance.js";
import { ensureWorkspaceIdentity } from "@tachyon/engine/workspace/workspaceIdentity.js";

/** t-f5769a — the scanner against a real filesystem, including the git reads worktrees need. */

let home: string;
const write = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const bundle = (root: string, id: string, mtime: Date): void => {
  write(path.join(root, id, "engine-daemon.cjs"), "x".repeat(1000));
  fs.utimesSync(path.join(root, id), mtime, mtime);
};
const engineState = (root: string, hash: string, provenance?: object): void => {
  write(path.join(root, hash, "state", "state.json"), JSON.stringify(provenance ? { [WORKSPACE_PROVENANCE_STATE_KEY]: provenance } : {}));
};

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-reclaim-")); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function roots() {
  return {
    bundlesRoot: path.join(home, "bundles"),
    runtimesRoot: path.join(home, "runtimes"),
    enginesStateRoot: path.join(home, "engines"),
    worktreesRoot: path.join(home, "worktrees"),
    globalStorageRoot: path.join(home, "globalStorage"),
  };
}

describe("scanReclaim", () => {
  it("collects superseded bundles and keeps the newest N plus the running one", async () => {
    const r = roots();
    bundle(r.bundlesRoot, "oldest", new Date("2026-07-01"));
    bundle(r.bundlesRoot, "old", new Date("2026-07-15"));
    bundle(r.bundlesRoot, "recent", new Date("2026-08-01"));
    bundle(r.bundlesRoot, "newest", new Date("2026-08-20"));

    const plan = await scanReclaim({ ...r, keepBundles: 2, liveBundleIds: new Set(["oldest"]) });
    expect(plan.collect.map((c) => path.basename(c.path))).toEqual(["old"]);
    expect(plan.bytesCollectable).toBeGreaterThan(0);
  });

  it("reads provenance off disk and quarantines state of a workspace that is gone", async () => {
    const r = roots();
    const liveWs = path.join(home, "live-ws");
    fs.mkdirSync(liveWs, { recursive: true });
    const liveId = ensureWorkspaceIdentity(liveWs)!.id;

    engineState(r.enginesStateRoot, "live", buildWorkspaceProvenance(liveWs, liveId, new Date()));
    engineState(r.enginesStateRoot, "gone", buildWorkspaceProvenance(path.join(home, "deleted-ws"), "id-x", new Date()));
    engineState(r.enginesStateRoot, "legacy");

    const plan = await scanReclaim(r);
    expect(plan.quarantine.map((q) => path.basename(q.path))).toEqual(["gone"]);
    expect(plan.hold.find((h) => h.path.endsWith("/live"))?.reason).toContain("still there");
    expect(plan.hold.find((h) => h.path.endsWith("/legacy"))?.reason).toContain("no provenance");
  });

  it("detects a replaced incarnation at the same path", async () => {
    const r = roots();
    const ws = path.join(home, "reused");
    fs.mkdirSync(ws, { recursive: true });
    ensureWorkspaceIdentity(ws);
    engineState(r.enginesStateRoot, "old", buildWorkspaceProvenance(ws, "an-older-incarnation", new Date()));

    const plan = await scanReclaim(r);
    expect(plan.quarantine[0]?.reason).toContain("different workspace");
  });

  it("leaves a worktree with uncommitted work alone and collects a clean orphan", async () => {
    const r = roots();
    const makeWorktree = (name: string, dirty: boolean): void => {
      const dir = path.join(r.worktreesRoot, "deadhash", "change", name);
      fs.mkdirSync(dir, { recursive: true });
      const git = (...args: string[]): void => { execFileSync("git", args, { cwd: dir, stdio: "ignore" }); };
      git("init", "-q");
      git("config", "user.email", "t@t.dev");
      git("config", "user.name", "t");
      write(path.join(dir, "file.txt"), "base");
      git("add", ".");
      git("commit", "-qm", "base");
      if (dirty) write(path.join(dir, "file.txt"), "changed but never committed");
    };
    makeWorktree("dirty-one", true);
    makeWorktree("clean-one", false);

    const plan = await scanReclaim(r);
    const dirtyHold = plan.hold.find((h) => h.path.endsWith("dirty-one"));
    expect(dirtyHold?.reason).toContain("uncommitted changes");
    // the clean one has a single branch containing HEAD, so it reads as never-merged: held, not collected
    expect(plan.collect.some((c) => c.path.endsWith("dirty-one"))).toBe(false);
  });

  it("collects a bridge token only when a state proves its workspace is gone", async () => {
    const r = roots();
    const liveWs = path.join(home, "ws");
    fs.mkdirSync(liveWs, { recursive: true });
    engineState(r.enginesStateRoot, "aaaa", buildWorkspaceProvenance(liveWs, undefined, new Date()));
    // bbbb has a state whose workspace is gone → provably dead
    engineState(r.enginesStateRoot, "bbbb", buildWorkspaceProvenance(path.join(home, "deleted"), undefined, new Date()));
    write(path.join(r.globalStorageRoot, "bridge-token-aaaa"), "live");
    write(path.join(r.globalStorageRoot, "bridge-token-bbbb"), "dead");
    write(path.join(r.globalStorageRoot, "bridge-external-token-bbbb"), "dead");
    // cccc has no engine state at all — unknowable, so its token stays
    write(path.join(r.globalStorageRoot, "bridge-token-cccc"), "unknown");

    const plan = await scanReclaim(r);
    expect(plan.collect.filter((c) => c.kind === "bridge-token").map((c) => path.basename(c.path)).sort())
      .toEqual(["bridge-external-token-bbbb", "bridge-token-bbbb"]);
    expect(plan.hold.some((h) => h.path.endsWith("bridge-token-cccc"))).toBe(true);
  });
});

describe("applyReclaim", () => {
  it("removes what it collects and MOVES what it quarantines", async () => {
    const r = roots();
    bundle(r.bundlesRoot, "keep", new Date("2026-08-20"));
    bundle(r.bundlesRoot, "drop", new Date("2026-07-01"));
    engineState(r.enginesStateRoot, "gone", buildWorkspaceProvenance(path.join(home, "deleted"), "id", new Date()));

    const plan = await scanReclaim({ ...r, keepBundles: 1 });
    const quarantineRoot = path.join(home, "quarantine");
    const result = applyReclaim(plan, { quarantineRoot, now: new Date("2026-08-22T12:00:00Z") });

    expect(fs.existsSync(path.join(r.bundlesRoot, "drop"))).toBe(false);
    expect(fs.existsSync(path.join(r.bundlesRoot, "keep"))).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.bytesFreed).toBeGreaterThan(0);

    // the dead workspace's state still exists — moved, not destroyed. It holds provider API keys.
    expect(fs.existsSync(path.join(r.enginesStateRoot, "gone"))).toBe(false);
    expect(result.quarantined).toHaveLength(1);
    expect(fs.existsSync(result.quarantined[0]!.to)).toBe(true);
    expect(fs.existsSync(path.join(result.quarantined[0]!.to, "state", "state.json"))).toBe(true);
  });
});

describe("runReclaim — the two doors onto one plan", () => {
  it("planning never removes anything", async () => {
    const r = roots();
    bundle(r.bundlesRoot, "old", new Date("2026-07-01"));
    bundle(r.bundlesRoot, "new", new Date("2026-08-20"));
    const before = fs.readdirSync(r.bundlesRoot).sort();

    const report = await runReclaim({
      apply: false,
      roots: { bundlesRoot: r.bundlesRoot, runtimesRoot: r.runtimesRoot, enginesStateRoot: r.enginesStateRoot },
      workspaceSettings: { worktree: { base: r.worktreesRoot } },
      globalStorageRoot: r.globalStorageRoot,
      settings: { keepBundles: 1 },
    });

    expect(report.result).toBeUndefined();
    expect(report.lines.join(" ")).toContain("bundle");
    expect(fs.readdirSync(r.bundlesRoot).sort()).toEqual(before);
  });

  it("the start-up pass stays silent when there is nothing to reclaim", async () => {
    const r = roots();
    bundle(r.bundlesRoot, "only", new Date("2026-08-20"));
    expect(await reclaimOnStart({
      roots: { bundlesRoot: r.bundlesRoot, runtimesRoot: r.runtimesRoot, enginesStateRoot: r.enginesStateRoot },
      workspaceSettings: { worktree: { base: r.worktreesRoot } },
      globalStorageRoot: r.globalStorageRoot,
      quarantineRoot: path.join(home, "q"),
      settings: { keepBundles: 3 },
    })).toBeUndefined();
  });

  it("enabled:false turns the automatic pass off and touches nothing", async () => {
    const r = roots();
    bundle(r.bundlesRoot, "old", new Date("2026-07-01"));
    bundle(r.bundlesRoot, "new", new Date("2026-08-20"));
    expect(await reclaimOnStart({
      roots: { bundlesRoot: r.bundlesRoot, runtimesRoot: r.runtimesRoot, enginesStateRoot: r.enginesStateRoot },
      workspaceSettings: { worktree: { base: r.worktreesRoot } },
      globalStorageRoot: r.globalStorageRoot,
      quarantineRoot: path.join(home, "q"),
      settings: { enabled: false, keepBundles: 1 },
    })).toBeUndefined();
    expect(fs.existsSync(path.join(r.bundlesRoot, "old"))).toBe(true);
  });
});
