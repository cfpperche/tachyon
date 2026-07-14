import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PollingFileWatcher } from "../../src/engine-service/pollingWatcher.js";

const roots: string[] = [];
const watchers: PollingFileWatcher[] = [];

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.dispose();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-poll-watch-"));
  roots.push(root);
  return root;
}

describe("PollingFileWatcher", () => {
  it("detects create, change and delete for Tachyon's brace config glob", async () => {
    const root = fixture();
    let changes = 0;
    const watcher = new PollingFileWatcher(root, "tachyon.{yml,yaml}", { create: true, change: true, delete: true }, () => { changes++; }, { intervalMs: 15 });
    watchers.push(watcher);
    const config = path.join(root, "tachyon.yml");
    fs.writeFileSync(config, "agents: {}\n");
    await waitFor(() => changes === 1);
    fs.writeFileSync(config, "agents:\n  one: { cmd: sh }\n");
    await waitFor(() => changes === 2);
    fs.unlinkSync(config);
    await waitFor(() => changes === 3);
  });

  it("matches nested globstars without following symlinked directories", async () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    const outside = fixture();
    fs.writeFileSync(path.join(outside, "escaped.ts"), "no\n");
    fs.symlinkSync(outside, path.join(root, "src", "linked"));
    let changes = 0;
    const watcher = new PollingFileWatcher(root, "src/**/*.ts", { create: true }, () => { changes++; }, { intervalMs: 15 });
    watchers.push(watcher);
    fs.writeFileSync(path.join(root, "src", "nested", "inside.ts"), "yes\n");
    await waitFor(() => changes === 1);
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(changes).toBe(1);
  });

  it("refuses traversal and bounds broad filesystem scans", () => {
    const root = fixture();
    expect(() => new PollingFileWatcher(root, "../outside", { create: true }, () => {})).toThrow(/escape/);
    expect(() => new PollingFileWatcher(root, "@(one|two).txt", { create: true }, () => {})).toThrow(/unsupported/);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "a");
    fs.writeFileSync(path.join(root, "src", "b.ts"), "b");
    expect(() => new PollingFileWatcher(root, "src/*.ts", { create: true }, () => {}, { maxEntries: 1 })).toThrow(/exceeded/);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("watch condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
