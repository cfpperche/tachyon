import { randomUUID } from "node:crypto";
import type { ProjectHandoffStore } from "@tachyon/engine/handoff/ProjectHandoffStore.js";
import {
  startHandoffDistillation,
  workspaceHandoffDistillOperations,
  type HandoffDistillResult,
  type WorkspaceHandoffDistillSource,
} from "@tachyon/engine/handoff/handoffDistillService.js";
import { ensureProjectHandoffFile } from "@tachyon/engine/handoff/handoffFileService.js";
import { resolveHandoffFilePath } from "@tachyon/engine/handoff/handoffPath.js";
import {
  parseHandoffDistillInputV1,
  type HandoffDistillInputV1,
} from "@tachyon/engine/runtime-api/handoffCommands.js";
import {
  projectHandoffView,
  type HandoffProjectionV1,
} from "@tachyon/engine/runtime-api/handoffProjection.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import { workspacePresentationTarget, type WorkspacePresentationTarget } from "./WorkspacePresentation.js";

export interface WorkspaceHandoffTarget extends WorkspacePresentationTarget {
  loadHandoff(): Promise<HandoffProjectionV1>;
  ensureHandoffFile(): Promise<string>;
  startHandoffDistill(input: HandoffDistillInputV1): Promise<HandoffDistillResult>;
}

export interface LegacyHandoffSource extends WorkspacePresentationTarget, WorkspaceHandoffDistillSource {
  readonly handoffStore: ProjectHandoffStore;
  lastActivityAt(): string | null;
}

/** Compatibility adapter until the single production registry cutover. */
export function legacyHandoffTarget(source: LegacyHandoffSource): WorkspaceHandoffTarget {
  const distill = workspaceHandoffDistillOperations(source, { reveal: true });
  return {
    workspaceRoot: source.workspaceRoot,
    wsHash: source.wsHash,
    folderName: source.folderName,
    loadHandoff: async () => (await projectHandoffView({
      workspaceRoot: source.workspaceRoot,
      store: source.handoffStore,
      lastActivityAt: source.lastActivityAt(),
      distill,
    })).handoff,
    ensureHandoffFile: async () => resolveHandoffFilePath(
      source.workspaceRoot,
      ensureProjectHandoffFile(source.workspaceRoot, source.handoffStore).relativePath,
    ),
    startHandoffDistill: (input) => startHandoffDistillation(distill, input),
  };
}

export function workspaceHandoffTarget(client: WorkspaceClient): WorkspaceHandoffTarget {
  const identity = workspacePresentationTarget(client);
  return {
    ...identity,
    loadHandoff: async () => {
      const result = await client.query({ schemaVersion: 1, method: "handoff.view", input: {} });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "handoff.view") throw new Error("Project Handoff query returned the wrong view");
      return result.view.handoff;
    },
    ensureHandoffFile: async () => {
      const result = await client.invoke(`handoff-ensure:${randomUUID()}`, {
        schemaVersion: 1,
        method: "handoff.ensure",
        input: {},
      });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "handoff.ensure") throw new Error("Project Handoff ensure returned the wrong result");
      return resolveHandoffFilePath(identity.workspaceRoot, result.canonicalRelativePath);
    },
    startHandoffDistill: async (rawInput) => {
      const input = parseHandoffDistillInputV1(rawInput);
      const result = await client.invoke(`handoff-distill:${randomUUID()}`, {
        schemaVersion: 1,
        method: "handoff.distill",
        input,
      });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "handoff.distill" || result.mode !== input.mode) {
        throw new Error("Project Handoff distill returned the wrong result");
      }
      if (input.mode === "existing" && result.agent !== input.agent) {
        throw new Error("Project Handoff distill changed the selected agent");
      }
      return { mode: result.mode, agent: result.agent };
    },
  };
}
