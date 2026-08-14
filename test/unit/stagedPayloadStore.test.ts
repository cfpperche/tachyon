import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_STAGED_PAYLOAD_BYTES,
  StagedPayloadError,
  StagedPayloadStore,
} from "@tachyon/engine/engine-service/stagedPayloadStore.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("StagedPayloadStore", () => {
  it("stages one private immutable reference, verifies it through an fd and consumes it once", () => {
    const store = createStore();
    const data = Buffer.from(JSON.stringify({ task: "t-abc123", body: "hello" }));
    const ref = store.stage(data);
    const file = path.join(store.directory, ref.token);

    expect(ref).toMatchObject({ schemaVersion: 1, byteSize: data.byteLength });
    expect(ref.token).toMatch(/^[a-f0-9]{48}$/);
    expect(ref.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.lstatSync(file).mode & 0o777).toBe(0o600);
    expect(store.consume(ref)).toEqual(data);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => store.consume(ref)).toThrowError(StagedPayloadError);
  });

  it("fails closed and removes a regular payload whose bytes, size, mode or link count drift", () => {
    const store = createStore();

    const changed = store.stage(Buffer.from("original"));
    const changedPath = path.join(store.directory, changed.token);
    fs.writeFileSync(changedPath, "tampered");
    expect(() => store.consume(changed)).toThrow(/digest does not match/);
    expect(fs.existsSync(changedPath)).toBe(false);

    const resized = store.stage(Buffer.from("original"));
    const resizedPath = path.join(store.directory, resized.token);
    fs.appendFileSync(resizedPath, "!");
    expect(() => store.consume(resized)).toThrow(/size does not match/);
    expect(fs.existsSync(resizedPath)).toBe(false);

    const exposed = store.stage(Buffer.from("private"));
    const exposedPath = path.join(store.directory, exposed.token);
    fs.chmodSync(exposedPath, 0o640);
    expect(() => store.consume(exposed)).toThrow(/group\/other-accessible/);
    expect(fs.existsSync(exposedPath)).toBe(false);

    const linked = store.stage(Buffer.from("single-link"));
    const linkedPath = path.join(store.directory, linked.token);
    const extraLink = path.join(path.dirname(store.directory), "extra-link");
    fs.linkSync(linkedPath, extraLink);
    expect(() => store.consume(linked)).toThrow(/exactly one link/);
    expect(fs.existsSync(linkedPath)).toBe(false);
    fs.rmSync(extraLink, { force: true });
  });

  it("never follows a staged-token symlink and never unlinks its target", () => {
    const store = createStore();
    const outside = path.join(path.dirname(store.directory), "outside");
    fs.writeFileSync(outside, "outside", { mode: 0o600 });
    const ref = {
      schemaVersion: 1 as const,
      token: "a".repeat(48),
      sha256: "b".repeat(64),
      byteSize: 7,
    };
    fs.symlinkSync(outside, path.join(store.directory, ref.token));

    expect(() => store.consume(ref)).toThrow(/unavailable/);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
  });

  it("enforces global and per-operation byte limits before reading", () => {
    const store = createStore();
    expect(() => store.stage(Buffer.alloc(0))).toThrow(/must contain/);
    expect(() => store.stage(Buffer.alloc(MAX_STAGED_PAYLOAD_BYTES + 1))).toThrow(/must contain/);

    const ref = store.stage(Buffer.from("123456"));
    expect(() => store.consume(ref, 5)).toThrow(/operation limit/);
    expect(fs.existsSync(path.join(store.directory, ref.token))).toBe(true);
    store.discard(ref);
  });

  it("sweeps only stale token-shaped regular files and preserves fresh or unrelated entries", () => {
    const store = createStore();
    const stale = store.stage(Buffer.from("stale"));
    const fresh = store.stage(Buffer.from("fresh"));
    const stalePath = path.join(store.directory, stale.token);
    const freshPath = path.join(store.directory, fresh.token);
    const unrelated = path.join(store.directory, "README");
    fs.writeFileSync(unrelated, "keep");
    const now = Date.now();
    fs.utimesSync(stalePath, new Date(now - 10_000), new Date(now - 10_000));

    expect(store.cleanupStale(now, 5_000)).toBe(1);
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(freshPath)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});

function createStore(): StagedPayloadStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-staged-payload-"));
  roots.push(root);
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(runtime, { mode: 0o700 });
  return new StagedPayloadStore(runtime);
}
