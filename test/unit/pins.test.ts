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
    expect(store.getNotes()).toBe("");
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

  it("errors are precise: unknown ids, corrupt json", () => {
    expect(() => store.setDone("p-000000", true)).toThrow("unknown pin");
    expect(() => store.remove("p-000000")).toThrow("unknown pin");

    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(store.pinsPath, "{broken", "utf8");
    expect(() => store.list()).toThrow("not valid JSON");
    fs.writeFileSync(store.pinsPath, '{"nope": 1}', "utf8");
    expect(() => store.list()).toThrow('{"pins": [...]}');
  });

  it("notes: set/get, trailing newline normalized, ensure creates the file", () => {
    store.setNotes("# Divisão\nclaude=auth, codex=testes");
    expect(store.getNotes()).toBe("# Divisão\nclaude=auth, codex=testes\n");
    expect(fs.readFileSync(store.notesPath, "utf8")).toContain("Divisão");

    fs.rmSync(store.notesPath);
    const created = store.ensureNotesFile();
    expect(fs.existsSync(created)).toBe(true);
    expect(store.getNotes()).toBe("");
  });
});
