import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonStateStore } from "../../src/engine-service/daemonStateStore.js";

const roots: string[] = [];
const root = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-daemon-state-"));
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("DaemonStateStore", () => {
  it("persists cloned state and private secrets outside ExtensionContext", async () => {
    const storage = path.join(root(), "engine");
    const first = new DaemonStateStore(storage);
    first.setState("example", { count: 1, nested: ["a"] });
    first.setSecret("hmac", "secret-value");
    const copy = first.getState<{ count: number; nested: string[] }>("example")!;
    copy.count = 9;
    copy.nested.push("mutated");

    const reopened = new DaemonStateStore(storage);
    expect(reopened.getState("example")).toEqual({ count: 1, nested: ["a"] });
    expect(reopened.getSecret("hmac")).toBe("secret-value");
    expect(fs.statSync(path.join(storage, "state.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(storage, "secrets.json")).mode & 0o777).toBe(0o600);

    reopened.setState("example", undefined);
    expect(new DaemonStateStore(storage).getState("example")).toBeUndefined();
  });

  it("fails closed on unsafe or malformed persisted data", () => {
    const storage = path.join(root(), "engine");
    const store = new DaemonStateStore(storage);
    store.setState("example", 1);
    const stateFile = path.join(storage, "state.json");
    fs.chmodSync(stateFile, 0o644);
    expect(() => new DaemonStateStore(storage)).toThrow(/unsafe ownership or permissions/);
    fs.chmodSync(stateFile, 0o600);
    fs.writeFileSync(stateFile, "not-json", { mode: 0o600 });
    expect(() => new DaemonStateStore(storage)).toThrow();
  });

  it("refuses state roots that are accessible by other users", () => {
    const storage = path.join(root(), "unsafe");
    fs.mkdirSync(storage, { mode: 0o755 });
    // mkdir mode is umask-masked; force group/world bits so the refusal is hermetic under umask 077
    // (verify_task isolated clones often run with a restrictive umask — t-b3ca7e).
    fs.chmodSync(storage, 0o755);
    expect(() => new DaemonStateStore(storage)).toThrow(/unsafe/);
  });
});
