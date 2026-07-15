import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  engineBundleId,
  isEngineBundleManifestV1,
  isEngineOperationId,
  isSafeBundlePath,
  isWorkspaceCommandResultV1,
  isWorkspaceCommandV1,
  isWorkspaceQueryResultV1,
  isWorkspaceQueryV1,
  negotiateEngineShellProtocol,
  workspaceCommandSuccessV1,
  workspaceMissionControlViewSuccessV1,
  workspaceProbeViewSuccessV1,
  workspaceTaskDetailViewSuccessV1,
  type EngineBundleFileV1,
  type EngineBundleManifestV1,
  type WorkspaceCommandV1,
  type WorkspaceProbeViewV1,
  type WorkspaceStudioFormV1,
} from "../../src/engine-service/protocol.js";

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function manifest(
  files: EngineBundleFileV1[] = [{ path: "engine.cjs", sha256: hash("engine"), executable: true }],
): EngineBundleManifestV1 {
  return {
    schemaVersion: 1,
    engineVersion: "0.57.0",
    protocol: { min: 1, max: 2 },
    entrypoint: "engine.cjs",
    files,
    build: { commit: "a".repeat(40), treeSha: "b".repeat(40), workingTreeClean: true },
  };
}

describe("persistent engine protocol", () => {
  it("validates a closed, traversal-free bundle manifest", () => {
    expect(isEngineBundleManifestV1(manifest())).toBe(true);
    for (const unsafe of ["", "/abs", "../escape", "a/../escape", "./engine.cjs", "a\\engine.cjs", "a//b", "C:/escape", "a:b"]) {
      expect(isSafeBundlePath(unsafe), unsafe).toBe(false);
    }
    expect(isEngineBundleManifestV1({ ...manifest(), entrypoint: "../engine.cjs" })).toBe(false);
    expect(isEngineBundleManifestV1({ ...manifest(), files: [...manifest().files, ...manifest().files] })).toBe(false);
    expect(isEngineBundleManifestV1({ ...manifest(), entrypoint: "missing.cjs" })).toBe(false);
  });

  it("negotiates only overlapping protocol ranges and picks the highest shared version", () => {
    expect(negotiateEngineShellProtocol({ min: 1, max: 3 }, { min: 2, max: 4 })).toBe(3);
    expect(negotiateEngineShellProtocol({ min: 1, max: 1 }, { min: 2, max: 2 })).toBeUndefined();
  });

  it("derives one stable bundle id independent of file declaration order", () => {
    const a = { path: "engine.cjs", sha256: hash("engine"), executable: true };
    const b = { path: "assets/helper.js", sha256: hash("helper") };
    expect(engineBundleId(manifest([a, b]))).toBe(engineBundleId(manifest([b, a])));
    expect(engineBundleId(manifest([a]))).not.toBe(engineBundleId(manifest([a, b])));
  });

  it("accepts only closed idempotency-keyed workspace commands and typed results", () => {
    const command = { schemaVersion: 1, method: "agent.start", input: { agent: "worker-1" } };
    expect(isWorkspaceCommandV1(command)).toBe(true);
    expect(isWorkspaceCommandV1({ ...command, method: "shell.exec" })).toBe(false);
    expect(isWorkspaceCommandV1({ ...command, input: { agent: "../escape" } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...command, input: { agent: "worker", extra: true } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...command, extra: true })).toBe(false);
    expect(isEngineOperationId("op-12345678")).toBe(true);
    expect(isEngineOperationId("short")).toBe(false);
    expect(isWorkspaceCommandResultV1({
      schemaVersion: 1,
      method: "agent.start",
      status: "ok",
    })).toBe(true);
    expect(isWorkspaceCommandResultV1({
      schemaVersion: 1,
      method: "agent.start",
      status: "error",
      code: "COMMAND_FAILED",
      message: "already running",
    })).toBe(true);
    expect(isWorkspaceCommandResultV1({
      schemaVersion: 1,
      method: "agent.start",
      status: "ok",
      changed: false,
    })).toBe(false);
  });

  it("validates the exact bounded Studio submit wire shape and result", () => {
    const state = studioForm();
    const command = {
      schemaVersion: 1,
      method: "studio.submit",
      input: { state, editingName: "lint" },
    } satisfies WorkspaceCommandV1;
    expect(isWorkspaceCommandV1(command)).toBe(true);
    expect(isWorkspaceCommandV1({ ...command, input: { state: { ...state, extra: true } } })).toBe(false);
    const { cwd: _cwd, ...missing } = state;
    expect(isWorkspaceCommandV1({ ...command, input: { state: missing } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...command, input: { state: { ...state, kind: "unknown" } } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...command, input: { state: { ...state, cmd: "x".repeat(32_769) } } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...command, input: { state, editingName: "../escape" } })).toBe(false);

    const result = workspaceCommandSuccessV1(command, ["bad command"]);
    expect(result).toEqual({
      schemaVersion: 1,
      method: "studio.submit",
      status: "ok",
      errors: ["bad command"],
      truncated: false,
    });
    expect(isWorkspaceCommandResultV1(result)).toBe(true);
    expect(isWorkspaceCommandResultV1({ schemaVersion: 1, method: "studio.submit", status: "ok" })).toBe(false);
    expect(workspaceCommandSuccessV1(
      command,
      Array.from({ length: 51 }, (_, index) => `error-${index}`),
    )).toMatchObject({ errors: expect.arrayContaining(["error-0"]), truncated: true });
  });

  it("accepts only exact Mission Control reads and idempotency-keyed mutations", () => {
    const updatedAt = "2026-07-14T12:00:00.000Z";
    const update = {
      schemaVersion: 1,
      method: "task.update",
      input: { id: "t-abc123", patch: { status: "triaged", expect: { status: "inbox", updatedAt } } },
    } as const;
    const reorder = {
      schemaVersion: 1,
      method: "task.reorder-lane",
      input: { status: "triaged", priority: 1, orderedIds: ["t-abc123"], expect: { "t-abc123": updatedAt } },
    } as const;
    const close = {
      schemaVersion: 1,
      method: "validation.close",
      input: { id: "v-abc123", outcome: "passed", result_note: "installed dogfood passed" },
    } as const;
    for (const command of [update, reorder, close]) {
      expect(isWorkspaceCommandV1(command), command.method).toBe(true);
      expect(isWorkspaceCommandResultV1(workspaceCommandSuccessV1(command as WorkspaceCommandV1))).toBe(true);
    }
    expect(isWorkspaceCommandV1({ ...update, input: { ...update.input, patch: { status: "triaged", now: updatedAt } } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...update, input: { ...update.input, patch: { title: "not a board mutation" } } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...update, input: { ...update.input, patch: {} } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...reorder, input: { ...reorder.input, expect: {} } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...reorder, input: { ...reorder.input, orderedIds: ["t-abc123", "t-abc123"] } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...close, input: { ...close.input, result_note: " " } })).toBe(false);

    const query = { schemaVersion: 1, method: "task.board", input: { liveAdhocAgents: ["reviewer"] } } as const;
    expect(isWorkspaceQueryV1(query)).toBe(true);
    expect(isWorkspaceQueryV1({ ...query, input: { liveAdhocAgents: ["reviewer", "reviewer"] } })).toBe(false);
    expect(isWorkspaceQueryV1({ ...query, input: { liveAdhocAgents: ["../escape"] } })).toBe(false);
    const result = workspaceMissionControlViewSuccessV1({
      schemaVersion: 1,
      board: { schemaVersion: 1, views: [], allowedDropStatuses: {}, chips: [] },
    });
    expect(isWorkspaceQueryResultV1(result)).toBe(true);
    if (result.status !== "ok" || result.method !== "task.board") throw new Error("expected Mission Control result");
    expect(isWorkspaceQueryResultV1({ ...result, view: { ...result.view, extra: true } })).toBe(false);
  });

  it("accepts only exact Task Detail reads and prototype-review mutations", () => {
    const approve = {
      schemaVersion: 1,
      method: "task.prototype.review",
      input: {
        taskId: "t-abc123",
        prototypeId: "p-0123456789ab",
        action: "approve",
        expectUpdatedAt: "2026-07-14T12:00:00.000Z",
        review: "ship it",
      },
    } as const;
    const note = { ...approve, input: { ...approve.input, action: "note" as const } };
    expect(isWorkspaceCommandV1(approve)).toBe(true);
    expect(isWorkspaceCommandV1(note)).toBe(true);
    expect(isWorkspaceCommandResultV1(workspaceCommandSuccessV1(approve))).toBe(true);
    expect(isWorkspaceCommandV1({ ...note, input: { ...note.input, review: undefined } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...approve, input: { ...approve.input, extra: true } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...approve, input: { ...approve.input, prototypeId: "../escape" } })).toBe(false);

    const query = { schemaVersion: 1, method: "task.detail", input: { id: "t-abc123" } } as const;
    expect(isWorkspaceQueryV1(query)).toBe(true);
    expect(isWorkspaceQueryV1({ ...query, input: { id: "../escape" } })).toBe(false);
    expect(isWorkspaceQueryV1({ ...query, input: { id: "t-abc123", extra: true } })).toBe(false);
    const result = workspaceTaskDetailViewSuccessV1({
      schemaVersion: 1,
      detail: {
        schemaVersion: 1,
        task: {
          id: "t-abc123",
          title: "remote detail",
          status: "inbox",
          author: "human",
          createdAt: "2026-07-14T12:00:00.000Z",
          updatedAt: "2026-07-14T12:00:00.000Z",
        },
        journal: [],
        deps: [],
        imageAttachments: [],
        prototypes: { readOnly: false, prototypes: [] },
      },
    });
    expect(isWorkspaceQueryResultV1(result)).toBe(true);
    if (result.status !== "ok" || result.method !== "task.detail") throw new Error("expected Task Detail result");
    expect(isWorkspaceQueryResultV1({ ...result, view: { ...result.view, extra: true } })).toBe(false);
  });

  it("keeps authenticated Probe reads separate, exact and response-bounded", () => {
    const query = { schemaVersion: 1, method: "probe.view", input: { caller: "codex" } } as const;
    expect(isWorkspaceQueryV1(query)).toBe(true);
    expect(isWorkspaceQueryV1({ ...query, input: { caller: "../escape" } })).toBe(false);
    expect(isWorkspaceQueryV1({ ...query, input: { caller: "codex", extra: true } })).toBe(false);

    const view: WorkspaceProbeViewV1 = {
      rows: [{
        runId: "probe-12345678",
        shortId: "12345678",
        runtime: "codex",
        archetype: "adversarial-review",
        caller: "codex",
        status: "completed",
        reason: "ok",
        ageLabel: "2s ago",
        excerpt: "accepted",
      }],
      total: 99,
      running: 99,
      completed: 0,
      failed: 0,
      empty: true,
      caller: "codex",
    };
    const result = workspaceProbeViewSuccessV1(view);
    expect(result).toMatchObject({
      method: "probe.view",
      status: "ok",
      view: { total: 1, running: 0, completed: 1, failed: 0, empty: false, caller: "codex" },
    });
    expect(isWorkspaceQueryResultV1(result)).toBe(true);
    if (result.status !== "ok") throw new Error("expected Probe view result");
    expect(isWorkspaceQueryResultV1({ ...result, view: { ...result.view, total: 2 } })).toBe(false);
    expect(() => workspaceProbeViewSuccessV1({
      ...view,
      rows: [{ ...view.rows[0], excerpt: "x".repeat(241) }],
    })).toThrow(/wire limit/);
    expect(() => workspaceProbeViewSuccessV1({ ...view, caller: "../escape" })).toThrow(/caller is invalid/);
    const maxRow = {
      ...view.rows[0],
      runId: "r".repeat(128),
      shortId: "s".repeat(16),
      runtime: "r".repeat(64),
      archetype: "a".repeat(64),
      caller: "c".repeat(128),
      reason: "r".repeat(128),
      ageLabel: "a".repeat(32),
      excerpt: "e".repeat(240),
    };
    const maximal = workspaceProbeViewSuccessV1({ ...view, rows: Array.from({ length: 50 }, () => maxRow) });
    expect(Buffer.byteLength(JSON.stringify({ ok: true, op: "query", result: maximal }), "utf8"))
      .toBeLessThan(64 * 1024);
  });
});

function studioForm(): WorkspaceStudioFormV1 {
  return {
    name: "lint",
    cmd: "npm run lint",
    kind: "command",
    instructions: "",
    role: "",
    watch: "",
    steps: "",
    cwd: "",
    autostart: false,
    restartOnCrash: false,
    attention: false,
    worktree: false,
    branch: "",
    worktreeSetup: "",
    verify: "",
    harness: false,
    harnessInherit: "workspace",
    harnessMcp: "",
    harnessRules: "",
    harnessInstructions: "",
    harnessSkills: "",
    harnessHooks: "",
    isolate: false,
    schedTiming: "every",
    schedEvery: "1h",
    schedAt: "09:00",
    schedAction: "run",
    schedTarget: "",
    catchUp: false,
  };
}
