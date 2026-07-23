import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectHandoffStore } from "../../src/handoff/ProjectHandoffStore.js";
import { ensureProjectHandoffFile } from "../../src/handoff/handoffFileService.js";
import { resolveHandoffFilePath } from "../../src/handoff/handoffPath.js";
import {
  parseHandoffViewV1,
  projectHandoffView,
} from "../../src/runtime-api/handoffProjection.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Project Handoff Runtime API projection", () => {
  it("projects the full canonical snapshot, bounded notes and authority-owned targets", async () => {
    const root = temp("handoff-projection-");
    let second = 0;
    const store = new ProjectHandoffStore(root, {
      now: () => new Date(`2026-07-14T12:00:0${second++}.000Z`),
    });
    store.setCanonical("## Current State\n\nReady.", undefined, "human");
    store.appendNote({ agent: "codex", kind: "decision", summary: "Keep the engine authoritative", evidence: ["commit:abc"] });

    const view = await projectHandoffView({
      workspaceRoot: root,
      store,
      lastActivityAt: "2026-07-14T12:01:00.000Z",
      distill: {
        listAgents: async () => [
          { name: "codex", session: "s1", running: true, declared: true, dead: false, crashed: false, kind: "agent" },
          { name: "reviewer", session: "s2", running: false, declared: true, dead: false, crashed: false, kind: "agent" },
          { name: "terminal", session: "s3", running: true, declared: true, dead: false, crashed: false, kind: "terminal" },
        ],
        resumableAgentNames: () => new Set(["reviewer"]),
      },
    });

    expect(view).toMatchObject({
      schemaVersion: 1,
      handoff: {
        canonicalRelativePath: ".tachyon/HANDOFF.md",
        exists: true,
        body: "## Current State\n\nReady.",
        staleness: "needs_distill",
        pendingCount: 1,
        updatedBy: "human",
        notes: [{ agent: "codex", kind: "decision", summary: "Keep the engine authoritative" }],
        distillTargets: [
          { name: "codex", state: "running", declared: true },
          { name: "reviewer", state: "resumable", declared: true },
        ],
      },
    });
  });

  it("materializes the template idempotently and preserves an existing canonical body", () => {
    const root = temp("handoff-ensure-");
    const store = new ProjectHandoffStore(root);

    const ensured = ensureProjectHandoffFile(root, store);
    const relative = ensured.relativePath;
    expect(ensured).toEqual({ relativePath: ".tachyon/HANDOFF.md", created: true });
    expect(resolveHandoffFilePath(root, relative)).toBe(fs.realpathSync(path.join(root, relative)));
    const revision = store.readCanonical()!.revision;
    store.setCanonical("Custom body", revision, "human");

    expect(ensureProjectHandoffFile(root, store)).toEqual({ relativePath: relative, created: false });
    expect(store.readCanonical()?.body).toBe("Custom body");
  });

  it("accepts a workspace opened through a symlink without weakening real containment", async () => {
    const parent = temp("handoff-workspace-alias-");
    const actualRoot = path.join(parent, "actual");
    const workspaceAlias = path.join(parent, "alias");
    fs.mkdirSync(actualRoot);
    fs.symlinkSync(actualRoot, workspaceAlias, "dir");
    const store = new ProjectHandoffStore(workspaceAlias);

    expect(ensureProjectHandoffFile(workspaceAlias, store)).toEqual({
      relativePath: ".tachyon/HANDOFF.md",
      created: true,
    });
    expect(resolveHandoffFilePath(workspaceAlias, ".tachyon/HANDOFF.md"))
      .toBe(fs.realpathSync(path.join(actualRoot, ".tachyon/HANDOFF.md")));

    const view = await projectHandoffView({
      workspaceRoot: workspaceAlias,
      store,
      lastActivityAt: null,
      distill: { listAgents: async () => [], resumableAgentNames: () => new Set() },
    });
    expect(view.handoff.canonicalRelativePath).toBe(".tachyon/HANDOFF.md");
  });

  it("refuses lexical and symlink escapes before the shell can open them", async () => {
    const root = temp("handoff-contained-");
    const escaped = new ProjectHandoffStore(root, { canonicalRelPath: "../outside.md" });
    const escapedSnapshot = vi.spyOn(escaped, "snapshot");
    await expect(projectHandoffView({
      workspaceRoot: root,
      store: escaped,
      lastActivityAt: null,
      distill: { listAgents: async () => [], resumableAgentNames: () => new Set() },
    })).rejects.toThrow(/escapes/i);
    expect(escapedSnapshot).not.toHaveBeenCalled();

    const outside = temp("handoff-outside-");
    fs.symlinkSync(outside, path.join(root, "docs"), "dir");
    const linked = new ProjectHandoffStore(root, { canonicalRelPath: "docs/HANDOFF.md" });
    expect(() => ensureProjectHandoffFile(root, linked)).toThrow(/ancestor.*escapes/i);
    expect(fs.existsSync(path.join(outside, "HANDOFF.md"))).toBe(false);
  });

  it("rejects contradictory counts, target descriptions and unknown fields", async () => {
    const root = temp("handoff-strict-");
    const store = new ProjectHandoffStore(root);
    const valid = await projectHandoffView({
      workspaceRoot: root,
      store,
      lastActivityAt: null,
      distill: { listAgents: async () => [], resumableAgentNames: () => new Set() },
    });

    expect(() => parseHandoffViewV1({ ...valid, extra: true })).toThrow(/unknown or missing/i);
    // t-7b1f87 — pendingCount is now DERIVED from the notes actually returned (idempotent under
    // re-validation, see handoffProjection.ts's comment), not strictly cross-checked against the
    // input: a mismatched input.pendingCount is silently corrected, never thrown.
    const recovered = parseHandoffViewV1({
      ...valid,
      handoff: { ...valid.handoff, pendingCount: 1 },
    });
    expect(recovered.handoff.pendingCount).toBe(valid.handoff.notes.length);
    expect(() => parseHandoffViewV1({
      ...valid,
      handoff: {
        ...valid.handoff,
        distillTargets: [{ name: "codex", state: "running", declared: true, description: "stopped · declared" }],
      },
    })).toThrow(/description contradicts/i);
    expect(() => parseHandoffViewV1({
      ...valid,
      handoff: { ...valid.handoff, exists: true, updatedAt: "", updatedBy: "", revision: "" },
    })).toThrow(/missing canonical metadata/i);
  });

  it("t-7b1f87: a truly unparseable note is dropped, not fatal — the rest of the handoff still projects", async () => {
    const root = temp("handoff-malformed-note-");
    const store = new ProjectHandoffStore(root);
    const valid = await projectHandoffView({
      workspaceRoot: root,
      store,
      lastActivityAt: null,
      distill: { listAgents: async () => [], resumableAgentNames: () => new Set() },
    });

    const parsed = parseHandoffViewV1({
      ...valid,
      handoff: {
        ...valid.handoff,
        pendingCount: 2,
        notes: [
          { ts: "not a real timestamp", agent: "codex", kind: "completed", summary: "genuinely corrupt", evidence: [] },
          { ts: "2026-07-21T15:48:33.000Z", agent: "codex", kind: "completed", summary: "survives", evidence: [] },
        ],
      },
    });
    expect(parsed.handoff.notes).toHaveLength(1);
    expect(parsed.handoff.notes[0].summary).toBe("survives");
    expect(parsed.handoff.pendingCount).toBe(1);
  });

  it("t-7b1f87: a legacy timestamp missing milliseconds is migrated to canonical form, not dropped", async () => {
    const root = temp("handoff-legacy-ts-");
    const store = new ProjectHandoffStore(root);
    const valid = await projectHandoffView({
      workspaceRoot: root,
      store,
      lastActivityAt: null,
      distill: { listAgents: async () => [], resumableAgentNames: () => new Set() },
    });

    const parsed = parseHandoffViewV1({
      ...valid,
      handoff: {
        ...valid.handoff,
        pendingCount: 1,
        notes: [{ ts: "2026-07-21T15:48:33Z", agent: "codex", kind: "completed", summary: "legacy format", evidence: [] }],
      },
    });
    expect(parsed.handoff.notes).toHaveLength(1);
    expect(parsed.handoff.notes[0].ts).toBe("2026-07-21T15:48:33.000Z");
  });
});

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
