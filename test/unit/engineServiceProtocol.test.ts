import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  engineBundleId,
  isEngineBundleManifestV1,
  isEngineOperationId,
  isSafeBundlePath,
  isWorkspaceCommandResultV1,
  isWorkspaceCommandV1,
  negotiateEngineShellProtocol,
  workspaceCommandSuccessV1,
  type EngineBundleFileV1,
  type EngineBundleManifestV1,
  type WorkspaceCommandV1,
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
