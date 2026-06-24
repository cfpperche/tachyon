import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
