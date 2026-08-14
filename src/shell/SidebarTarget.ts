import { randomUUID } from "node:crypto";
import type { TiptapJSON } from "@tachyon/shared/richDoc/types.js";
import {
  parseSidebarMutationInputV1,
  type SidebarMutationInputV1,
} from "../runtime-api/sidebarCommands.js";
import {
  projectSidebarView,
  type SidebarFleetV1,
} from "../runtime-api/sidebarProjection.js";
import type { ObservedModelInput } from "../sidebar/agentModel.js";
import type { SidebarFleetSource } from "../sidebar/sidebarFleetService.js";
import {
  applySidebarMutation,
  type SidebarMutationResult,
} from "../sidebar/sidebarMutationService.js";
import type { PinStudioAttachmentVM } from "../webview/pin-studio/types.js";
import {
  legacyPinStudioTarget,
  workspacePinStudioTarget,
  type LegacyPinStudioSource,
  type WorkspacePinStudioTarget,
} from "./PinStudioTarget.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import { workspacePresentationTarget, type WorkspacePresentationTarget } from "./WorkspacePresentation.js";
import { runStatus } from "../pipeline/runState.js";
import type { DomainActionSource } from "../workspace/domainActions.js";

export interface SidebarPinPreview {
  id: string;
  title: string;
  by?: string;
  done: boolean;
  tags: string[];
  doc: TiptapJSON | null;
  attachments: PinStudioAttachmentVM[];
}

export type SidebarShellCommandContext =
  | { kind: "workspace" }
  | { kind: "agent"; agentName: string; contextValue: string }
  | { kind: "command"; commandName: string }
  | { kind: "runbook"; runbookName: string }
  | { kind: "pin"; pinId: string }
  | { kind: "schedule"; scheduleName: string }
  | { kind: "pipeline"; pipelineName: string; nodeId?: string };

export interface WorkspaceSidebarTarget extends WorkspacePresentationTarget {
  loadSidebar(): Promise<SidebarFleetV1>;
  mutateSidebar(input: SidebarMutationInputV1): Promise<SidebarMutationResult>;
  loadPinPreview(id: string, context: { asWebviewUri(path: string): string }): Promise<SidebarPinPreview>;
  pinAttachmentBlobRoot(): string;
  /** Transitional shell gesture. `extension.ts` removes the legacy Workspace payload at the final registry cutover. */
  shellCommandArgs(context: SidebarShellCommandContext): unknown[];
}

export type LegacySidebarSource = SidebarFleetSource & LegacyPinStudioSource & DomainActionSource;

/** Compatibility adapter until the one atomic extension registry cutover. */
export function legacySidebarTarget(
  source: LegacySidebarSource,
  observedModelFor?: (agentName: string) => ObservedModelInput | undefined,
): WorkspaceSidebarTarget {
  return createSidebarTarget(
    source,
    legacyPinStudioTarget(source),
    () => projectSidebarView(source, { observedModelFor }).then((view) => view.fleet),
    async (input) => applySidebarMutation(source, input, () => undefined),
    (context) => legacyShellCommandArgs(source, context),
  );
}

export function workspaceSidebarTarget(client: WorkspaceClient): WorkspaceSidebarTarget {
  const identity = workspacePresentationTarget(client);
  return createSidebarTarget(
    identity,
    workspacePinStudioTarget(client),
    async () => {
      const result = await client.query({ schemaVersion: 1, method: "sidebar.view", input: {} });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "sidebar.view") throw new Error("sidebar query returned the wrong view");
      if (result.view.fleet.folder.hash !== identity.wsHash) {
        throw new Error("sidebar query returned a different workspace identity");
      }
      return result.view.fleet;
    },
    async (rawInput) => {
      const input = parseSidebarMutationInputV1(rawInput);
      const result = await client.invoke(`sidebar:${randomUUID()}`, {
        schemaVersion: 1,
        method: "sidebar.mutate",
        input,
      });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "sidebar.mutate"
        || result.action !== input.action
        || result.id !== input.id) {
        throw new Error("sidebar mutation returned a mismatched result");
      }
      return { action: result.action, id: result.id, changed: result.changed };
    },
    (context) => [{ workspaceHash: identity.wsHash, ...shellContextFields(context) }],
  );
}

function createSidebarTarget(
  identity: WorkspacePresentationTarget,
  pinStudio: WorkspacePinStudioTarget,
  loadSidebar: () => Promise<SidebarFleetV1>,
  mutateSidebar: (input: SidebarMutationInputV1) => Promise<SidebarMutationResult>,
  shellCommandArgs: (context: SidebarShellCommandContext) => unknown[],
): WorkspaceSidebarTarget {
  return {
    ...identity,
    loadSidebar,
    mutateSidebar,
    pinAttachmentBlobRoot: () => pinStudio.attachmentBlobRoot(),
    shellCommandArgs,
    // t-610705 (Phase D, D3) — `context` (asWebviewUri) is no longer threaded to loadPinStudio: it
    // now always embeds attachment bytes as `data:` URIs (PinStudioTarget.ts's hydrateAttachment,
    // ported from TaskStudioTarget.ts's D2 fix) — no local-resource-root translation needed here
    // either. The `context` param stays (part of WorkspaceSidebarTarget's loadPinPreview contract).
    loadPinPreview: async (id, _context) => {
      const [fleet, detail] = await Promise.all([loadSidebar(), pinStudio.loadPinStudio(id)]);
      const summary = fleet.pins.find((pin) => pin.id === id);
      if (!summary || detail.pinId !== id) throw new Error(`unknown pin '${id}'`);
      return {
        id,
        title: detail.title,
        ...(summary.by ? { by: summary.by } : {}),
        done: summary.done,
        tags: [...detail.tags],
        doc: detail.doc,
        attachments: detail.attachments.map((attachment) => ({ ...attachment })),
      };
    },
  };
}

function legacyShellCommandArgs(source: LegacySidebarSource, context: SidebarShellCommandContext): unknown[] {
  if (context.kind === "workspace") return [{ ws: source }];
  if (context.kind === "agent") {
    return [{ ws: source, agentName: context.agentName, contextValue: context.contextValue }];
  }
  if (context.kind === "command") return [{ ws: source, commandName: context.commandName }];
  if (context.kind === "runbook") return [{ ws: source, runbookName: context.runbookName }];
  if (context.kind === "pin") return [{ ws: source, pinId: context.pinId }];
  if (context.kind === "schedule") return [{ ws: source, scheduleName: context.scheduleName }];
  const run = source.pipelines.allRuns().find((candidate) => candidate.pipeline.name === context.pipelineName && runStatus(candidate) !== "completed");
  return context.nodeId === undefined
    ? [{ ws: source, pipelineName: context.pipelineName, run }]
    : [{ ws: source, runId: run?.id, nodeId: context.nodeId, run }];
}

function shellContextFields(context: SidebarShellCommandContext): Record<string, unknown> {
  if (context.kind === "workspace") return {};
  if (context.kind === "agent") return { agentName: context.agentName, contextValue: context.contextValue };
  if (context.kind === "command") return { commandName: context.commandName };
  if (context.kind === "runbook") return { runbookName: context.runbookName };
  if (context.kind === "pin") return { pinId: context.pinId };
  if (context.kind === "schedule") return { scheduleName: context.scheduleName };
  return { pipelineName: context.pipelineName, ...(context.nodeId === undefined ? {} : { nodeId: context.nodeId }) };
}
