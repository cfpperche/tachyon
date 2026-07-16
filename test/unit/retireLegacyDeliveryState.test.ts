import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryStore } from "../../src/delivery/store.js";
import { LegacyDeliveryRetirement } from "../../src/delivery/retireLegacyState.js";
import { deterministicGitDeliveryId, GitDeliveryStore } from "../../src/git-delivery/store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("legacy Delivery state retirement", () => {
  it("previews without mutation, archives only legacy metadata, and preserves canonical state and Git", async () => {
    const fixture = await createFixture();
    const metadataBefore = snapshotFiles(path.join(fixture.root, ".tachyon"));
    const gitBefore = gitSnapshot(fixture.root);
    const deliveriesBefore = readSqlRows(
      path.join(fixture.root, ".tachyon", "deliveries-v2.sqlite3"),
      "SELECT id, record_json FROM deliveries ORDER BY id",
    );
    const retirement = new LegacyDeliveryRetirement(fixture.root, { now: sequenceNow() });

    const preview = retirement.preview();

    expect(preview.recoveryPending).toBe(false);
    expect(preview.counts).toEqual({
      delegationEntries: 1,
      deliveryJsonEntries: 1,
      unlinkedGitDeliveryRows: 1,
      gitDeliveryMirrorEntries: 2,
      canonicalDeliveries: 1,
      linkedGitDeliveries: 1,
    });
    expect(preview.archiveId).toBe(`legacy-${preview.snapshotDigest}`);
    expect(snapshotFiles(path.join(fixture.root, ".tachyon"))).toEqual(metadataBefore);
    expect(gitSnapshot(fixture.root)).toEqual(gitBefore);

    const receipt = retirement.apply(preview);

    expect(fs.existsSync(path.join(receipt.archivePath, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.root, ".tachyon", "delegations"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, ".tachyon", "deliveries.migrated-v1"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, ".tachyon", "git-deliveries"))).toBe(false);
    expect(readSqlRows(
      path.join(fixture.root, ".tachyon", "git-deliveries-v2.sqlite3"),
      "SELECT id FROM git_deliveries ORDER BY id",
    )).toEqual([{ id: fixture.linkedId }]);
    expect(readSqlRows(
      path.join(fixture.root, ".tachyon", "deliveries-v2.sqlite3"),
      "SELECT id, record_json FROM deliveries ORDER BY id",
    )).toEqual(deliveriesBefore);
    expect(gitSnapshot(fixture.root)).toEqual(gitBefore);
    expect(() => retirement.assertRetired()).not.toThrow();
    expect(retirement.apply(preview)).toEqual(receipt);
  });

  it("refuses a stale or caller-modified preview before any deletion", () => {
    const root = legacyOnlyFixture();
    const retirement = new LegacyDeliveryRetirement(root, { now: sequenceNow() });
    const preview = retirement.preview();
    const source = path.join(root, ".tachyon", "delegations", "legacy.json");
    fs.appendFileSync(source, "changed\n");

    expect(() => retirement.apply(preview)).toThrowError(expect.objectContaining({
      code: "LEGACY_DELIVERY_RETIREMENT_CHANGED",
    }));
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(path.join(root, ".tachyon", "legacy-delivery-archives"))).toBe(false);

    const current = retirement.preview();
    const forged = structuredClone(current);
    forged.entries[0]!.source = ".tachyon/deliveries-v2.sqlite3";
    expect(() => retirement.apply(forged)).toThrowError(expect.objectContaining({
      code: "LEGACY_DELIVERY_RETIREMENT_CORRUPT",
    }));
  });

  it("resumes a durable partial retirement without double-deleting metadata", () => {
    const root = legacyOnlyFixture();
    let crashed = false;
    const first = new LegacyDeliveryRetirement(root, {
      now: sequenceNow(),
      afterPhase: (phase) => {
        if (phase === "files-removed" && !crashed) {
          crashed = true;
          throw new Error("simulated process loss");
        }
      },
    });
    const original = first.preview();
    expect(() => first.apply(original)).toThrow("simulated process loss");

    const resumed = new LegacyDeliveryRetirement(root, { now: sequenceNow() });
    const recovery = resumed.preview();
    expect(recovery.recoveryPending).toBe(true);
    expect(recovery.snapshotDigest).toBe(original.snapshotDigest);
    expect(resumed.apply(recovery).snapshotDigest).toBe(original.snapshotDigest);
    expect(() => resumed.assertRetired()).not.toThrow();
  });

  it("supports repeated retirement generations after rollback recreates identical legacy metadata", () => {
    const root = legacyOnlyFixture();
    const retirement = new LegacyDeliveryRetirement(root, { now: sequenceNow() });
    const firstPreview = retirement.preview();
    const first = retirement.apply(firstPreview);

    writeLegacyDelegation(root, "{\"agent\":\"old\"}\n");
    const secondPreview = retirement.preview();
    expect(secondPreview.snapshotDigest).toBe(firstPreview.snapshotDigest);
    expect(secondPreview.archiveId).toBe(`${firstPreview.archiveId}-2`);
    const second = retirement.apply(secondPreview);

    expect(second.archivePath).not.toBe(first.archivePath);
    expect(fs.existsSync(path.join(first.archivePath, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(second.archivePath, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(retirement.receiptHistoryRoot, `${first.archiveId}.json`))).toBe(true);
    expect(fs.existsSync(path.join(retirement.receiptHistoryRoot, `${second.archiveId}.json`))).toBe(true);
    expect(retirement.readReceipt()).toEqual(second);
    expect(() => retirement.assertRetired()).not.toThrow();
  });

  it("reclaims an old ownerless lock but refuses a fresh ownerless lock", () => {
    const staleRoot = legacyOnlyFixture();
    const stale = new LegacyDeliveryRetirement(staleRoot, { now: sequenceNow() });
    const stalePreview = stale.preview();
    fs.mkdirSync(stale.lockPath);
    const old = new Date(Date.now() - 31_000);
    fs.utimesSync(stale.lockPath, old, old);
    expect(stale.apply(stalePreview).snapshotDigest).toBe(stalePreview.snapshotDigest);

    const freshRoot = legacyOnlyFixture();
    const fresh = new LegacyDeliveryRetirement(freshRoot, { now: sequenceNow() });
    const freshPreview = fresh.preview();
    fs.mkdirSync(fresh.lockPath);
    expect(() => fresh.apply(freshPreview)).toThrowError(expect.objectContaining({
      code: "LEGACY_DELIVERY_RETIREMENT_BUSY",
    }));
    expect(fs.existsSync(path.join(freshRoot, ".tachyon", "delegations", "legacy.json"))).toBe(true);
  });

  it("fails closed on a symlink inside legacy metadata", () => {
    const root = freshRoot();
    fs.mkdirSync(path.join(root, ".tachyon", "delegations"), { recursive: true });
    fs.symlinkSync("/tmp", path.join(root, ".tachyon", "delegations", "escape"));
    expect(() => new LegacyDeliveryRetirement(root).preview()).toThrowError(expect.objectContaining({
      code: "LEGACY_DELIVERY_RETIREMENT_CORRUPT",
    }));
  });
});

async function createFixture(): Promise<{ root: string; linkedId: string }> {
  const root = freshRoot();
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Tachyon Test");
  fs.writeFileSync(path.join(root, ".gitignore"), ".tachyon/\n");
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
  git(root, "add", ".gitignore", "tracked.txt");
  git(root, "commit", "-m", "base");
  fs.writeFileSync(path.join(root, "dirty.txt"), "do not touch\n");
  const baseSha = git(root, "rev-parse", "HEAD");
  const canonicalWorktree = path.join(path.dirname(root), "canonical-worktree");
  const legacyWorktree = path.join(path.dirname(root), "legacy-worktree");
  git(root, "worktree", "add", "-q", "-b", "task", canonicalWorktree, "HEAD");
  git(root, "worktree", "add", "-q", "-b", "legacy", legacyWorktree, "HEAD");
  fs.appendFileSync(path.join(canonicalWorktree, "tracked.txt"), "canonical dirty state\n");

  const deliveries = new DeliveryStore(root, {
    id: () => "d-canonical",
    now: () => "2026-07-13T19:00:00.000Z",
    capabilityValidator: () => ({ supported: true, domain: "test" }),
  });
  const delivery = await deliveries.create({
    workspaceId: "ws-test",
    createdBy: { kind: "human", name: "maintainer" },
    contract: { baseSha, behaviorTest: "npm test", owns: ["src"], taskRef: "task" },
  });

  const gitDeliveries = new GitDeliveryStore(root, { now: () => "2026-07-13T19:00:00.000Z" });
  const linkedId = deterministicGitDeliveryId(delivery.id);
  await gitDeliveries.open({
    id: linkedId,
    deliveryId: delivery.id,
    workspaceId: "ws-test",
    createdBy: { kind: "human", name: "maintainer" },
    agent: "canonical-agent",
    branchRef: "task",
    worktreePath: canonicalWorktree,
    tachyonCreatedBranch: true,
    baseRef: "refs/heads/main",
    currentHeadSha: baseSha,
  });

  const unlinked = {
    schemaVersion: 1,
    id: "gd-unlinked",
    version: 1,
    workspaceId: "ws-test",
    createdBy: { kind: "legacy", name: "old-agent" },
    agent: "old-agent",
    branchRef: "legacy",
    worktreePath: legacyWorktree,
    tachyonCreatedBranch: true,
    baseRef: "refs/heads/main",
    currentHeadSha: baseSha,
    phase: "open",
    taskLinks: [],
    transitions: [],
    createdAt: "2026-07-13T19:00:00.000Z",
    updatedAt: "2026-07-13T19:00:00.000Z",
  };
  const databasePath = path.join(root, ".tachyon", "git-deliveries-v2.sqlite3");
  const db = new DatabaseSync(databasePath);
  db.prepare("INSERT INTO git_deliveries(id, branch_ref, worktree_path, active, record_json) VALUES (?, ?, ?, 1, ?)")
    .run(unlinked.id, unlinked.branchRef, path.resolve(unlinked.worktreePath), JSON.stringify(unlinked));
  db.close();

  const mirrors = path.join(root, ".tachyon", "git-deliveries");
  fs.mkdirSync(mirrors, { recursive: true });
  const linked = await gitDeliveries.get(linkedId);
  if (!linked) throw new Error("linked fixture projection missing");
  fs.writeFileSync(path.join(mirrors, `${linked.id}.json`), `${JSON.stringify(linked, null, 2)}\n`);
  fs.writeFileSync(path.join(mirrors, `${unlinked.id}.json`), `${JSON.stringify(unlinked, null, 2)}\n`);
  writeLegacyDelegation(root, "{\"agent\":\"old\"}\n");

  const migrated = path.join(root, ".tachyon", "deliveries.migrated-v1");
  fs.mkdirSync(migrated, { recursive: true });
  fs.writeFileSync(path.join(migrated, `${delivery.id}.json`), `${JSON.stringify(delivery, null, 2)}\n`);
  return { root, linkedId };
}

function legacyOnlyFixture(): string {
  const root = freshRoot();
  writeLegacyDelegation(root, "{\"agent\":\"old\"}\n");
  return root;
}

function writeLegacyDelegation(root: string, contents: string): void {
  const directory = path.join(root, ".tachyon", "delegations");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "legacy.json"), contents);
}

function freshRoot(): string {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-retire-legacy-"));
  const root = path.join(container, "workspace");
  fs.mkdirSync(root);
  roots.push(container);
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function gitSnapshot(root: string): {
  refs: string;
  status: string;
  head: string;
  worktreeList: string;
  worktrees: Array<{ path: string; head: string; status: string }>;
} {
  const worktreeList = git(root, "worktree", "list", "--porcelain");
  const paths = worktreeList.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  return {
    refs: git(root, "for-each-ref", "--format=%(refname) %(objectname)"),
    status: git(root, "status", "--porcelain=v2", "--untracked-files=all"),
    head: git(root, "rev-parse", "HEAD"),
    worktreeList,
    worktrees: paths.map((worktreePath) => ({
      path: worktreePath,
      head: git(worktreePath, "rev-parse", "HEAD"),
      status: git(worktreePath, "status", "--porcelain=v2", "--untracked-files=all"),
    })),
  };
}

function snapshotFiles(root: string): Array<{ path: string; bytes: number; sha256: string }> {
  if (!fs.existsSync(root)) return [];
  const result: Array<{ path: string; bytes: number; sha256: string }> = [];
  const walk = (current: string): void => {
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) walk(path.join(current, name));
      return;
    }
    const bytes = fs.readFileSync(current);
    result.push({
      path: path.relative(root, current),
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  };
  walk(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function readSqlRows(database: string, sql: string): Array<Record<string, unknown>> {
  const require = createRequire(path.join(process.cwd(), "tachyon-retirement-test-loader.cjs"));
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(database, { readOnly: true });
  try { return db.prepare(sql).all() as Array<Record<string, unknown>>; }
  finally { db.close(); }
}

function sequenceNow(): () => string {
  let tick = 0;
  return () => `2026-07-13T20:00:${String(tick++).padStart(2, "0")}.000Z`;
}
