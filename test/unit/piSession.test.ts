import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializePiAgentHome, materializePiSessionDir, piAgentHome, piSessionDir, removePiSessionDir } from "../../src/agents/piSession.js";
import { resolvePiSession } from "../../src/resume/resolvers.js";

const roots: string[] = [];
const temp = (prefix: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeSession(dir: string, name: string, id: string, cwd: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd })}\n`);
  return file;
}

describe("managed Pi session namespace", () => {
  it("materializes a private real directory inside the workspace", () => {
    const workspace = temp("tachyon-pi-session-");
    const dir = materializePiSessionDir(workspace, "pi_worker");
    expect(dir).toBe(piSessionDir(workspace, "pi_worker"));
    expect(fs.lstatSync(dir).isDirectory()).toBe(true);
    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(dir)).mode & 0o777).toBe(0o700);
    expect(path.dirname(dir)).toBe(piAgentHome(workspace, "pi_worker"));
    expect(materializePiAgentHome(workspace, "pi_worker")).toBe(path.dirname(dir));
  });

  it("removes only the named private session namespace at ephemeral end-of-life", () => {
    const workspace = temp("tachyon-pi-session-remove-");
    const target = materializePiSessionDir(workspace, "pi");
    const sibling = materializePiSessionDir(workspace, "reviewer");
    fs.writeFileSync(path.join(target, "session.jsonl"), "state");
    removePiSessionDir(workspace, "pi");
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
    expect(() => removePiSessionDir(workspace, "pi")).not.toThrow();
  });

  it("refuses a symlinked Tachyon state component instead of escaping the workspace", () => {
    const workspace = temp("tachyon-pi-session-ws-");
    const outside = temp("tachyon-pi-session-outside-");
    fs.mkdirSync(path.join(workspace, ".tachyon"));
    fs.symlinkSync(outside, path.join(workspace, ".tachyon", "harness"));
    expect(() => materializePiSessionDir(workspace, "pi")).toThrow("not a real directory");
  });

  it("resolves exactly one regular JSONL whose header id and cwd match", () => {
    const workspace = temp("tachyon-pi-resolve-");
    const dir = materializePiSessionDir(workspace, "pi");
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const file = writeSession(dir, `2026-07-18T00-00-00-000Z_${id}.jsonl`, id, workspace);
    writeSession(dir, "other.jsonl", "other-id", workspace);
    expect(resolvePiSession(workspace, { home: os.homedir(), piSessionDir: dir }, id)).toEqual({ id, path: file });
  });

  it("fails closed for missing id, cwd mismatch, malformed headers, duplicates and symlinks", () => {
    const workspace = temp("tachyon-pi-resolve-bad-");
    const dir = materializePiSessionDir(workspace, "pi");
    const id = "session-1";
    expect(resolvePiSession(workspace, { home: os.homedir(), piSessionDir: dir }, id)).toBeNull();

    writeSession(dir, "wrong-cwd.jsonl", id, `${workspace}-other`);
    fs.writeFileSync(path.join(dir, "malformed.jsonl"), "not-json\n");
    const outside = writeSession(temp("tachyon-pi-link-target-"), "session.jsonl", id, workspace);
    fs.symlinkSync(outside, path.join(dir, "linked.jsonl"));
    expect(resolvePiSession(workspace, { home: os.homedir(), piSessionDir: dir }, id)).toBeNull();

    fs.rmSync(path.join(dir, "wrong-cwd.jsonl"));
    writeSession(dir, "one.jsonl", id, workspace);
    writeSession(dir, "two.jsonl", id, workspace);
    expect(resolvePiSession(workspace, { home: os.homedir(), piSessionDir: dir }, id)).toBeNull();
  });
});
