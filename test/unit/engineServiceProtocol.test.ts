import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  engineBundleId,
  isEngineBundleManifestV1,
  isEngineOperationId,
  isEngineUiRequestV1,
  isSafeBundlePath,
  isWorkspaceCommandResultBoundToInput,
  isWorkspaceCommandResultV1,
  isWorkspaceCommandV1,
  isWorkspaceQueryResultBoundToInput,
  isWorkspaceQueryResultV1,
  isWorkspaceQueryV1,
  negotiateEngineShellProtocol,
  workspaceCommandSuccessV1,
  workspaceExtensionCommandSuccessV1,
  workspaceExtensionQuerySuccessV1,
  workspaceActivityContextSuccessV1,
  workspaceHandoffDistillSuccessV1,
  workspaceHandoffEnsureSuccessV1,
  workspaceHandoffViewSuccessV1,
  workspaceMissionControlViewSuccessV1,
  workspacePinStudioApplySuccessV1,
  workspacePinStudioViewSuccessV1,
  workspaceProbeViewSuccessV1,
  workspaceSidebarMutationSuccessV1,
  workspaceSidebarViewSuccessV1,
  workspaceTaskDetailViewSuccessV1,
  workspaceTaskStudioApplySuccessV1,
  workspaceTaskStudioViewSuccessV1,
  type EngineBundleFileV1,
  type EngineBundleManifestV1,
  type WorkspaceCommandV1,
  type WorkspaceProbeViewV1,
  type WorkspaceStudioFormV1,
} from "../../src/engine-service/protocol.js";
import { isExtensionCommandV1, isExtensionQueryV1 } from "../../src/runtime-api/extensionOperations.js";

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
    expect(isEngineBundleManifestV1({ ...manifest(), channel: "stable" })).toBe(true);
    expect(isEngineBundleManifestV1({ ...manifest(), channel: "dev" })).toBe(true);
    expect(isEngineBundleManifestV1({ ...manifest(), channel: "candidate" })).toBe(false);
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

  it("accepts only exact bounded terminal UI requests", () => {
    const operationId = "ui-operation-0001";
    expect(isEngineUiRequestV1({
      schemaVersion: 1,
      operationId,
      kind: "terminal.present",
      agent: "codex",
      session: "tachyon-one-codex",
      viewColumn: 2,
      title: "Codex",
    })).toBe(true);
    expect(isEngineUiRequestV1({
      schemaVersion: 1,
      operationId,
      kind: "terminal.close",
      agent: "codex",
      session: "tachyon-one-codex",
    })).toBe(true);
    expect(isEngineUiRequestV1({
      schemaVersion: 1,
      operationId,
      kind: "terminal.present",
      agent: "codex",
      session: "tachyon-one-codex",
      extra: true,
    })).toBe(false);
    expect(isEngineUiRequestV1({
      schemaVersion: 1,
      operationId,
      kind: "notice.present",
      noticeId: "notice-id-0001",
      message: "x".repeat(4_097),
      level: "info",
      actions: [],
    } as unknown)).toBe(false);
  });

  it("validates engine-owned tmux reads and identity-bound mutations", () => {
    const expected = {
      session: "tachyon-abc12345-codex",
      window: 0,
      pane: 0,
      pid: 4242,
      startCommand: "codex",
      createdAt: 1_700_000_000,
    };
    expect(isExtensionQueryV1({ action: "tmux.snapshot" })).toBe(true);
    expect(isExtensionQueryV1({ action: "tmux.health" })).toBe(true);
    expect(isExtensionQueryV1({ action: "tmux.capture", session: expected.session })).toBe(true);
    expect(isExtensionCommandV1({ action: "tmux.kill", expected })).toBe(true);
    expect(isExtensionCommandV1({ action: "tmux.recover" })).toBe(true);
    expect(isExtensionCommandV1({
      action: "terminal.open",
      agent: "cmd:verify",
      session: "tachyon-cmd-abc12345-verify",
      title: "$ verify",
    })).toBe(true);
    expect(isExtensionCommandV1({
      action: "terminal.close",
      agent: "cmd:verify",
      session: "tachyon-cmd-abc12345-verify",
    })).toBe(true);
    expect(isExtensionCommandV1({ action: "tmux.kill", expected: { ...expected, pid: -1 } })).toBe(false);
    expect(isExtensionCommandV1({ action: "tmux.kill", expected: { ...expected, extra: true } })).toBe(false);
    expect(isExtensionQueryV1({ action: "tmux.capture", session: "bad\nsession" })).toBe(false);
    expect(isExtensionCommandV1({
      action: "terminal.open",
      agent: "cmd:verify",
      session: "bad\nsession",
    })).toBe(false);
    expect(isExtensionCommandV1({
      action: "terminal.close",
      agent: "cmd:verify",
      session: "tachyon-cmd-abc12345-verify",
      extra: true,
    })).toBe(false);
  });

  it("derives one stable bundle id independent of file declaration order", () => {
    const a = { path: "engine.cjs", sha256: hash("engine"), executable: true };
    const b = { path: "assets/helper.js", sha256: hash("helper") };
    expect(engineBundleId(manifest([a, b]))).toBe(engineBundleId(manifest([b, a])));
    expect(engineBundleId(manifest([a]))).not.toBe(engineBundleId(manifest([a, b])));
    expect(engineBundleId({ ...manifest([a]), channel: "stable" }))
      .not.toBe(engineBundleId({ ...manifest([a]), channel: "dev" }));
  });

  it("accepts only closed idempotency-keyed workspace commands and typed results", () => {
    const command = { schemaVersion: 1, method: "agent.start", input: { agent: "worker-1" } };
    expect(isWorkspaceCommandV1(command)).toBe(true);
    expect(isWorkspaceCommandV1({ ...command, method: "shell.exec" })).toBe(false);
    expect(isWorkspaceCommandV1({ ...command, input: { agent: "../escape" } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...command, input: { agent: "worker", extra: true } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...command, extra: true })).toBe(false);
    // spec 389 — agent.restart accepts optional stop/session; rejects unknown values/keys
    expect(isWorkspaceCommandV1({ schemaVersion: 1, method: "agent.restart", input: { agent: "worker" } })).toBe(true);
    expect(isWorkspaceCommandV1({
      schemaVersion: 1,
      method: "agent.restart",
      input: { agent: "worker", stop: "graceful", session: "resume" },
    })).toBe(true);
    expect(isWorkspaceCommandV1({
      schemaVersion: 1,
      method: "agent.restart",
      input: { agent: "worker", stop: "force", session: "new" },
    })).toBe(true);
    expect(isWorkspaceCommandV1({
      schemaVersion: 1,
      method: "agent.restart",
      input: { agent: "worker", stop: "soft" },
    })).toBe(false);
    expect(isWorkspaceCommandV1({
      schemaVersion: 1,
      method: "agent.restart",
      input: { agent: "worker", session: "fresh" },
    })).toBe(false);
    expect(isWorkspaceCommandV1({
      schemaVersion: 1,
      method: "agent.restart",
      input: { agent: "worker", extra: true },
    })).toBe(false);
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

  it("validates and cross-binds the closed extension operation contract", () => {
    const query = {
      schemaVersion: 1,
      method: "extension.query",
      input: { action: "agent.inspect", agent: "worker-1" },
    } as const;
    expect(isWorkspaceQueryV1(query)).toBe(true);
    expect(isWorkspaceQueryV1({ ...query, input: { action: "agent.inspect", agent: "../escape" } })).toBe(false);
    expect(isWorkspaceQueryV1({ ...query, input: { action: "unknown" } })).toBe(false);
    const queryResult = workspaceExtensionQuerySuccessV1(query, { session: "tachyon-worker-1" });
    expect(isWorkspaceQueryResultV1(queryResult)).toBe(true);
    expect(isWorkspaceQueryResultBoundToInput(query, queryResult)).toBe(true);
    expect(isWorkspaceQueryResultBoundToInput(
      { schemaVersion: 1, method: "extension.query", input: { action: "agents.list" } },
      queryResult,
    )).toBe(false);

    const command = {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "proposal.create", name: "nightly", schedule: { at: "03:00", spawn: "worker-1", instructions: "audit" }, by: "codex" },
    } as const;
    expect(isWorkspaceCommandV1(command)).toBe(true);
    expect(isWorkspaceCommandV1({ ...command, input: { ...command.input, schedule: { at: "03:00", run: "lint", spawn: "worker-1" } } })).toBe(false);
    const commandResult = workspaceExtensionCommandSuccessV1(command, { id: "proposal-1" });
    expect(isWorkspaceCommandResultV1(commandResult)).toBe(true);
    expect(isWorkspaceCommandResultBoundToInput(command, commandResult)).toBe(true);
    expect(isWorkspaceCommandResultBoundToInput(
      { schemaVersion: 1, method: "extension.invoke", input: { action: "command.tick" } },
      commandResult,
    )).toBe(false);

    const soulQuery = {
      schemaVersion: 1 as const,
      method: "extension.query" as const,
      input: { action: "soul.profile.status" as const, agent: "worker-1" },
    };
    expect(isWorkspaceQueryV1(soulQuery)).toBe(true);
    expect(isWorkspaceQueryV1({ ...soulQuery, input: { ...soulQuery.input, agent: "../escape" } })).toBe(false);
    const soulPayload = { schemaVersion: 1 as const, token: "a".repeat(48), sha256: "b".repeat(64), byteSize: 64 * 1024 };
    const soulReplace = {
      schemaVersion: 1 as const,
      method: "extension.invoke" as const,
      input: {
        action: "soul.profile.replace" as const,
        agent: "worker-1",
        payload: soulPayload,
        expectedDigest: "c".repeat(64),
      },
    };
    expect(isWorkspaceCommandV1(soulReplace)).toBe(true);
    expect(isWorkspaceCommandV1({ ...soulReplace, input: { ...soulReplace.input, payload: { ...soulPayload, byteSize: 64 * 1024 + 1 } } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...soulReplace, input: { ...soulReplace.input, expectedDigest: "stale" } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...soulReplace, input: { ...soulReplace.input, sourcePath: "/tmp/SOUL.md" } })).toBe(false);
    expect(() => workspaceExtensionQuerySuccessV1(
      { schemaVersion: 1, method: "extension.query", input: { action: "agents.list" } },
      "x".repeat(2 * 1024 * 1024),
    )).toThrow(/size limit/);
  });

  it("binds bounded agent input and Activity context to exact identities", () => {
    const input = {
      schemaVersion: 1 as const,
      method: "agent.input" as const,
      input: { agent: "reviewer", text: "review this", submit: false },
    };
    expect(isWorkspaceCommandV1(input)).toBe(true);
    expect(workspaceCommandSuccessV1(input)).toEqual({
      schemaVersion: 1,
      method: "agent.input",
      status: "ok",
    });
    expect(isWorkspaceCommandV1({ ...input, input: { ...input.input, submit: "no" } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...input, input: { ...input.input, text: "x".repeat(48 * 1024 + 1) } })).toBe(false);

    const query = { schemaVersion: 1, method: "activity.context", input: { agent: "codex" } } as const;
    const result = workspaceActivityContextSuccessV1({
      schemaVersion: 1,
      context: {
        schemaVersion: 1,
        agent: "codex",
        sharedCwd: false,
        attention: null,
        targets: { total: 1, truncated: false, items: [{ name: "reviewer", declared: true }] },
      },
    });
    expect(isWorkspaceQueryV1(query)).toBe(true);
    expect(isWorkspaceQueryResultV1(result)).toBe(true);
    expect(isWorkspaceQueryResultBoundToInput(query, result)).toBe(true);
    expect(isWorkspaceQueryResultBoundToInput(
      { ...query, input: { agent: "reviewer" } },
      result,
    )).toBe(false);
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

  it("binds Task Studio staged commands, projections and outcomes to one exact action", () => {
    const payload = {
      schemaVersion: 1 as const,
      token: "a".repeat(48),
      sha256: "b".repeat(64),
      byteSize: 123,
    };
    const save = {
      schemaVersion: 1 as const,
      method: "task.studio.apply" as const,
      input: { taskId: "t-abc123", action: "save" as const, payload },
    };
    expect(isWorkspaceCommandV1(save)).toBe(true);
    expect(isWorkspaceCommandV1({ ...save, input: { ...save.input, action: "unknown" } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...save, input: { ...save.input, payload: { ...payload, token: "../escape" } } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...save, input: { ...save.input, payload: { ...payload, byteSize: 0 } } })).toBe(false);
    expect(() => workspaceCommandSuccessV1(save)).toThrow(/exact outcome/);

    const saved = workspaceTaskStudioApplySuccessV1(save, { outcome: "saved" });
    expect(saved).toEqual({
      schemaVersion: 1,
      method: "task.studio.apply",
      status: "ok",
      action: "save",
      outcome: "saved",
    });
    expect(isWorkspaceCommandResultV1(saved)).toBe(true);
    expect(isWorkspaceCommandResultV1({ ...saved, action: "put-image" })).toBe(false);
    expect(isWorkspaceCommandResultV1({ ...saved, message: "not allowed" })).toBe(false);

    const query = { schemaVersion: 1, method: "task.studio", input: { id: "t-abc123" } } as const;
    expect(isWorkspaceQueryV1(query)).toBe(true);
    expect(isWorkspaceQueryV1({ ...query, input: { id: "../escape" } })).toBe(false);
    const result = workspaceTaskStudioViewSuccessV1({
      schemaVersion: 1,
      studio: {
        schemaVersion: 1,
        taskId: "t-abc123",
        title: "remote studio",
        deps: [],
        artifact_refs: [],
        doc: { type: "doc", content: [{ type: "paragraph" }] },
        attachments: [],
        anchor: "load",
        prototypes: { readOnly: false, prototypes: [] },
      },
    });
    expect(isWorkspaceQueryResultV1(result)).toBe(true);
    if (result.status !== "ok" || result.method !== "task.studio") throw new Error("expected Task Studio result");
    expect(isWorkspaceQueryResultV1({ ...result, view: { ...result.view, extra: true } })).toBe(false);
  });

  it("binds Pin Studio staged commands, optional identity and outcomes to one exact action", () => {
    const payload = {
      schemaVersion: 1 as const,
      token: "a".repeat(48),
      sha256: "b".repeat(64),
      byteSize: 123,
    };
    const save = {
      schemaVersion: 1 as const,
      method: "pin.studio.apply" as const,
      input: { action: "save" as const, pinId: "p-abc123", payload },
    };
    expect(isWorkspaceCommandV1(save)).toBe(true);
    expect(isWorkspaceCommandV1({ ...save, input: { ...save.input, action: "unknown" } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...save, input: { action: "put-image", pinId: "p-abc123", payload } })).toBe(false);
    expect(() => workspaceCommandSuccessV1(save)).toThrow(/exact outcome/);

    const saved = workspacePinStudioApplySuccessV1(save, { outcome: "saved", pinId: "p-abc123" });
    expect(saved).toEqual({
      schemaVersion: 1,
      method: "pin.studio.apply",
      status: "ok",
      action: "save",
      outcome: "saved",
      pinId: "p-abc123",
    });
    expect(isWorkspaceCommandResultV1(saved)).toBe(true);
    expect(isWorkspaceCommandResultV1({ ...saved, action: "put-image" })).toBe(false);
    expect(isWorkspaceCommandResultV1({ ...saved, pinId: "../escape" })).toBe(false);
    expect(() => workspacePinStudioApplySuccessV1(save, { outcome: "saved", pinId: "p-def456" }))
      .toThrow(/changed the requested pin identity/);

    const query = { schemaVersion: 1, method: "pin.studio", input: { id: "p-abc123" } } as const;
    expect(isWorkspaceQueryV1(query)).toBe(true);
    expect(isWorkspaceQueryV1({ ...query, input: { id: "t-abc123" } })).toBe(false);
    const result = workspacePinStudioViewSuccessV1({
      schemaVersion: 1,
      studio: {
        schemaVersion: 1,
        pinId: "p-abc123",
        title: "remote pin",
        tags: ["ui"],
        doc: { type: "doc", content: [{ type: "paragraph" }] },
        attachments: [],
      },
    });
    expect(isWorkspaceQueryResultV1(result)).toBe(true);
    if (result.status !== "ok" || result.method !== "pin.studio") throw new Error("expected Pin Studio result");
    expect(isWorkspaceQueryResultV1({ ...result, view: { ...result.view, extra: true } })).toBe(false);
  });

  it("validates exact Project Handoff reads, materialization and distillation intent", () => {
    const ensure = { schemaVersion: 1, method: "handoff.ensure", input: {} } as const;
    const existing = {
      schemaVersion: 1,
      method: "handoff.distill",
      input: { mode: "existing", agent: "codex", instructions: "Keep decisions" },
    } as const;
    const adhoc = {
      schemaVersion: 1,
      method: "handoff.distill",
      input: { mode: "adhoc", profileId: "claude:default", args: "--model sonnet" },
    } as const;
    expect(isWorkspaceCommandV1(ensure)).toBe(true);
    expect(isWorkspaceCommandV1(existing)).toBe(true);
    expect(isWorkspaceCommandV1(adhoc)).toBe(true);
    expect(isWorkspaceCommandV1({ ...ensure, input: { extra: true } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...existing, input: { ...existing.input, agent: "../escape" } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...adhoc, input: { ...adhoc.input, profileId: "bash:default" } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...adhoc, input: { ...adhoc.input, args: "--model sonnet\nrm nope" } })).toBe(false);

    expect(workspaceHandoffEnsureSuccessV1(ensure, ".tachyon/HANDOFF.md")).toEqual({
      schemaVersion: 1,
      method: "handoff.ensure",
      status: "ok",
      canonicalRelativePath: ".tachyon/HANDOFF.md",
    });
    expect(() => workspaceHandoffEnsureSuccessV1(ensure, "../outside.md")).toThrow(/invalid/i);
    expect(() => workspaceHandoffEnsureSuccessV1(ensure, "C:/outside.md")).toThrow(/invalid/i);
    expect(workspaceHandoffDistillSuccessV1(existing, { mode: "existing", agent: "codex" }))
      .toMatchObject({ method: "handoff.distill", status: "ok", mode: "existing", agent: "codex" });
    expect(() => workspaceHandoffDistillSuccessV1(existing, { mode: "existing", agent: "reviewer" }))
      .toThrow(/changed its requested agent/i);
    expect(() => workspaceCommandSuccessV1(ensure)).toThrow(/exact outcome/i);

    const query = { schemaVersion: 1, method: "handoff.view", input: {} } as const;
    expect(isWorkspaceQueryV1(query)).toBe(true);
    expect(isWorkspaceQueryV1({ ...query, input: { extra: true } })).toBe(false);
    const result = workspaceHandoffViewSuccessV1({
      schemaVersion: 1,
      handoff: {
        canonicalRelativePath: ".tachyon/HANDOFF.md",
        exists: false,
        body: "",
        staleness: "fresh",
        pendingCount: 0,
        updatedAt: "",
        updatedBy: "",
        revision: "",
        notes: [],
        distillTargets: [],
      },
    });
    expect(isWorkspaceQueryResultV1(result)).toBe(true);
    if (result.status !== "ok" || result.method !== "handoff.view") throw new Error("expected Handoff result");
    expect(isWorkspaceQueryResultV1({ ...result, view: { ...result.view, extra: true } })).toBe(false);
  });

  it("validates a closed Sidebar projection and identity-bound mutations", () => {
    const query = { schemaVersion: 1, method: "sidebar.view", input: {} } as const;
    const toggle = {
      schemaVersion: 1,
      method: "sidebar.mutate",
      input: { action: "pin.toggle", id: "p-abc123", done: true },
    } as const;
    expect(isWorkspaceQueryV1(query)).toBe(true);
    expect(isWorkspaceQueryV1({ ...query, input: { extra: true } })).toBe(false);
    expect(isWorkspaceCommandV1(toggle)).toBe(true);
    expect(isWorkspaceCommandV1({ ...toggle, input: { ...toggle.input, id: "p-nope00" } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...toggle, input: { ...toggle.input, extra: true } })).toBe(false);
    expect(isWorkspaceCommandV1({ ...toggle, input: { action: "proposal.reject", id: "abcdef123456" } })).toBe(true);
    expect(() => workspaceCommandSuccessV1(toggle)).toThrow(/exact outcome/i);

    const mutation = workspaceSidebarMutationSuccessV1(toggle, {
      action: "pin.toggle",
      id: "p-abc123",
      changed: true,
    });
    expect(mutation).toEqual({
      schemaVersion: 1,
      method: "sidebar.mutate",
      status: "ok",
      action: "pin.toggle",
      id: "p-abc123",
      changed: true,
    });
    expect(isWorkspaceCommandResultV1(mutation)).toBe(true);
    expect(isWorkspaceCommandResultV1({ ...mutation, id: "p-nope00" })).toBe(false);
    expect(() => workspaceSidebarMutationSuccessV1(toggle, {
      action: "pin.delete",
      id: "p-abc123",
      changed: true,
    })).toThrow(/does not match/i);

    const result = workspaceSidebarViewSuccessV1(sidebarView());
    expect(isWorkspaceQueryResultV1(result)).toBe(true);
    expect(isWorkspaceQueryResultBoundToInput(query, result)).toBe(true);
    if (result.status !== "ok" || result.method !== "sidebar.view") throw new Error("expected Sidebar result");
    expect(isWorkspaceQueryResultV1({ ...result, view: { ...result.view, extra: true } })).toBe(false);
    expect(() => workspaceSidebarViewSuccessV1({
      ...sidebarView(),
      fleet: { ...sidebarView().fleet, pins: [{ ...sidebarView().fleet.pins[0]!, id: "p-nope00" }] },
    })).toThrow(/invalid_string|regex|invalid/i);
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

function sidebarView() {
  return {
    schemaVersion: 1 as const,
    fleet: {
      folder: { hash: "workspace-hash", name: "workspace" },
      bridge: { port: "42897", connected: true },
      agents: [],
      terminals: [],
      commands: [],
      runbooks: [],
      pins: [{ id: "p-abc123", text: "Pinned", done: false, by: "human", tags: ["ui"] }],
      schedules: [],
      pipelines: [],
      proposals: [],
      handoff: { exists: false, staleness: "fresh" as const, pendingCount: 0 },
    },
  };
}

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
    soul: false,
    selfEvolution: false,
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
