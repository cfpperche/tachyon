import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PinStore } from "../../src/pins/PinStore.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pins-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("PinStore", () => {
  let store: PinStore;

  beforeEach(() => {
    fs.rmSync(path.join(root, ".tachyon"), { recursive: true, force: true });
    store = new PinStore(root);
  });

  it("starts empty (no files yet) and creates .tachyon/ lazily", () => {
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(store.dir)).toBe(false);

    const pin = store.create("first finding", "claude");
    expect(pin.id).toMatch(/^p-[0-9a-f]{6}$/);
    expect(fs.existsSync(store.pinsPath)).toBe(true);
  });

  it("create/list/setDone/remove round-trip persists to disk", () => {
    const a = store.create("finding A", "claude");
    const b = store.create("finding B", "human");
    expect(a.id).not.toBe(b.id);

    // a fresh store instance reads the same state (the file is the truth)
    const reread = new PinStore(root);
    expect(reread.list().map((p) => p.text)).toEqual(["finding A", "finding B"]);

    reread.setDone(a.id, true);
    expect(store.list().find((p) => p.id === a.id)?.done).toBe(true);

    reread.remove(b.id);
    expect(store.list().map((p) => p.id)).toEqual([a.id]);
  });

  it("retries an internally generated id collision inside create", () => {
    const generatedIds = ["p-111111", "p-111111", "p-222222"];
    const deterministicStore = new PinStore(root, () => generatedIds.shift()!);

    const first = deterministicStore.create("first", "human");
    const second = deterministicStore.create("second", "human");

    expect(first.id).toBe("p-111111");
    expect(second.id).toBe("p-222222");
    expect(deterministicStore.list().map((pin) => pin.id)).toEqual(["p-111111", "p-222222"]);
  });

  it("stops retrying internally generated id collisions after a bounded number of attempts", () => {
    let attempts = 0;
    const deterministicStore = new PinStore(root, () => {
      attempts += 1;
      return "p-111111";
    });
    deterministicStore.create("first", "human");

    expect(() => deterministicStore.create("never created", "human")).toThrow("after 8 attempts");
    expect(attempts).toBe(9); // one successful create, then eight bounded retries
    expect(deterministicStore.list().map((pin) => pin.text)).toEqual(["first"]);
  });

  it("rejects a caller-supplied id that already exists", () => {
    store.create("first", "human", { id: "p-111111" });

    expect(() => store.create("duplicate", "human", { id: "p-111111" })).toThrow("pin 'p-111111' already exists");
    expect(store.list().map((pin) => pin.text)).toEqual(["first"]);
  });

  it("preserves concurrent read-modify-write creates from separate processes", async () => {
    const repoRoot = process.cwd();
    const workerPath = path.join(root, "pin-writer.ts");
    const pinStoreUrl = pathToFileURL(path.join(repoRoot, "src/pins/PinStore.ts")).href;
    fs.writeFileSync(workerPath, `
      import { PinStore } from ${JSON.stringify(pinStoreUrl)};
      const workspaceRoot = process.argv[2]!;
      const writer = process.argv[3]!;
      const count = Number(process.argv[4]!);
      const store = new PinStore(workspaceRoot);
      for (let i = 0; i < count; i++) store.create(\`\${writer}-\${i}\`, writer);
    `, "utf8");

    const workerCount = 4;
    const pinsPerWorker = 25;
    await Promise.all(Array.from({ length: workerCount }, (_, i) => runPinWriter(repoRoot, workerPath, root, `writer-${i}`, pinsPerWorker)));

    const pins = store.list();
    expect(pins).toHaveLength(workerCount * pinsPerWorker);
    expect(new Set(pins.map((p) => p.text)).size).toBe(workerCount * pinsPerWorker);
  });

  it("update edits text in place, preserving id/by/createdAt/done (F4)", () => {
    const p = store.create("typ0", "human");
    store.setDone(p.id, true);
    const before = store.list().find((x) => x.id === p.id)!;
    store.update(p.id, "  fixed text  ");
    const after = store.list().find((x) => x.id === p.id)!;
    expect(after.text).toBe("fixed text"); // trimmed
    expect(after).toMatchObject({ id: before.id, by: before.by, createdAt: before.createdAt, done: true });
    expect(after.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(() => store.update(p.id, "   ")).toThrow("non-empty");
    expect(() => store.update("p-000000", "x")).toThrow("unknown pin");
  });

  it("normalizes, persists, retags, and clears pin tags", () => {
    const pin = store.create("tagged", "human", { tags: [" #Bug ", "Needs Review", "bug", "", "x".repeat(33)] });
    expect(pin.tags).toEqual(["bug", "needs-review"]);

    const reread = new PinStore(root);
    expect(reread.list()[0].tags).toEqual(["bug", "needs-review"]);

    const updated = reread.update(pin.id, { tags: ["Docs", "#api"] });
    expect(updated.tags).toEqual(["docs", "api"]);
    expect(reread.update(pin.id, { tags: [] }).tags).toBeUndefined();
    expect(() => reread.update(pin.id, {})).toThrow("text or tags");
  });

  it("tolerates legacy and malformed tag fields as untagged pins", () => {
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(store.pinsPath, JSON.stringify({
      pins: [
        { id: "p-111111", text: "legacy", by: "human", createdAt: "2026-06-24T00:00:00.000Z", done: false },
        { id: "p-222222", text: "bad tags", by: "human", createdAt: "2026-06-24T00:00:00.000Z", done: false, tags: "not-array" },
      ],
    }), "utf8");
    expect(store.list().map((p) => p.tags)).toEqual([undefined, undefined]);
  });

  it("errors are precise: unknown ids, corrupt json", () => {
    expect(() => store.setDone("p-000000", true)).toThrow("unknown pin");
    expect(() => store.remove("p-000000")).toThrow("unknown pin");

    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(store.pinsPath, "{broken", "utf8");
    expect(() => store.list()).toThrow("not valid JSON");
    fs.writeFileSync(store.pinsPath, '{"nope": 1}', "utf8");
    expect(() => store.list()).toThrow('{"pins": [...]}');
  });
});

function runPinWriter(repoRoot: string, workerPath: string, workspaceRoot: string, writer: string, count: number): Promise<void> {
  const viteNode = path.join(repoRoot, "node_modules", ".bin", "vite-node");
  return new Promise((resolve, reject) => {
    const child = spawn(viteNode, ["--root", repoRoot, workerPath, workspaceRoot, writer, String(count)], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pin writer ${writer} exited ${code}: ${stderr}`));
    });
  });
}
