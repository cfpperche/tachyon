import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContinuityStore } from "@tachyon/engine/continuity/ContinuityStore.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-continuity-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("ContinuityStore", () => {
  let store: ContinuityStore;
  beforeEach(() => {
    fs.rmSync(path.join(root, ".tachyon"), { recursive: true, force: true });
    store = new ContinuityStore(root);
  });

  it("reads a missing agent file as null without creating directories", () => {
    expect(store.read("claude")).toBeNull();
    expect(store.exists("claude")).toBe(false);
    expect(fs.existsSync(store.dir)).toBe(false);
  });

  it("writes and reads the exact Markdown content", () => {
    const markdown = "# Goal\n\nShip the smallest continuity file.\n";
    const result = store.write("claude", markdown);
    expect(result.path).toBe(path.join(root, ".tachyon", "continuity", "claude.md"));
    expect(result.bytes).toBe(Buffer.byteLength(markdown));
    expect(store.read("claude")).toBe(markdown);
    expect(fs.readFileSync(result.path, "utf8")).toBe(markdown);
  });

  it("atomically replaces content without temporary residue", () => {
    store.write("claude", "first");
    store.write("claude", "second");
    expect(store.read("claude")).toBe("second");
    expect(fs.readdirSync(store.dir).filter((file) => file.includes(".tmp-"))).toEqual([]);
  });

  it("removes only the named agent file", () => {
    store.write("claude", "one");
    store.write("codex", "two");
    store.remove("claude");
    expect(store.read("claude")).toBeNull();
    expect(store.read("codex")).toBe("two");
  });
});
