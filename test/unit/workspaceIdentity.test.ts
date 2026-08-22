import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeIdentityLoss,
  ensureWorkspaceIdentity,
  readIdentityState,
  workspaceIdentityPath,
  WORKSPACE_IDENTITY_FILE,
} from "@tachyon/engine/workspace/workspaceIdentity.js";

/**
 * t-af0d29 — the incident of 2026-08-21, as a test.
 *
 * `rm -rf` on a live workspace aborted with "Directory not empty" because the engine kept
 * recreating `.tachyon/` underneath it, and a re-clone at the same path then inherited that
 * engine's machine-local state. Both follow from one fact: engine identity was a digest of the
 * PATH, so destruction plus recreation was indistinguishable from continuity.
 */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-identity-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("workspace identity", () => {
  it("mints once and is stable across engines", () => {
    const first = ensureWorkspaceIdentity(root);
    expect(first?.id).toBeTruthy();
    expect(fs.existsSync(workspaceIdentityPath(root))).toBe(true);
    // a second engine on the same workspace reads the same identity, it does not mint a new one
    expect(ensureWorkspaceIdentity(root)?.id).toBe(first?.id);
    expect(readIdentityState(root, first!.id)).toEqual({ kind: "intact" });
  });

  it("refuses to mint an identity for a path that does not exist", () => {
    expect(ensureWorkspaceIdentity(path.join(root, "nope"))).toBeUndefined();
  });

  it("the workspace deleted under a running engine reads as root-missing", () => {
    const id = ensureWorkspaceIdentity(root)!.id;
    fs.rmSync(root, { recursive: true, force: true });
    const state = readIdentityState(root, id);
    expect(state).toEqual({ kind: "root-missing" });
    expect(describeIdentityLoss(state, root)).toContain("no longer exists");
  });

  it("a wiped .tachyon reads as marker-missing — what the aborted rm actually left behind", () => {
    const id = ensureWorkspaceIdentity(root)!.id;
    fs.rmSync(path.join(root, ".tachyon"), { recursive: true, force: true });
    const state = readIdentityState(root, id);
    expect(state).toEqual({ kind: "marker-missing" });
    expect(describeIdentityLoss(state, root)).toContain(WORKSPACE_IDENTITY_FILE);
  });

  it("a re-clone at the same path is a DIFFERENT workspace, not a continuation", () => {
    // This is the whole defect: same path, and the product could not tell.
    const before = ensureWorkspaceIdentity(root)!.id;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const after = ensureWorkspaceIdentity(root)!.id;

    expect(after).not.toBe(before);
    const state = readIdentityState(root, before);
    expect(state.kind).toBe("replaced");
    expect(state.kind === "replaced" && state.foundId).toBe(after);
    expect(describeIdentityLoss(state, root)).toContain("different Tachyon workspace");
  });

  it("an unreadable marker is indeterminate — never a reason to act", () => {
    const id = ensureWorkspaceIdentity(root)!.id;
    fs.writeFileSync(workspaceIdentityPath(root), "{ not json", "utf8");
    const state = readIdentityState(root, id);
    expect(state).toEqual({ kind: "indeterminate" });
    expect(describeIdentityLoss(state, root)).toBeUndefined();
  });

  it("a marker from a future schema is indeterminate, not a replacement", () => {
    const id = ensureWorkspaceIdentity(root)!.id;
    fs.writeFileSync(workspaceIdentityPath(root), JSON.stringify({ schemaVersion: 2, id: "x" }), "utf8");
    expect(readIdentityState(root, id)).toEqual({ kind: "indeterminate" });
  });
});
