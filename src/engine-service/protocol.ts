import { createHash } from "node:crypto";
import {
  isAgentInputCommandV1,
  type AgentInputCommandV1,
} from "../runtime-api/agentInputCommands.js";
import {
  isActivityContextViewV1,
  parseActivityContextViewV1,
  type ActivityContextViewV1,
} from "../runtime-api/activityProjection.js";
import {
  isHandoffDistillInputV1,
  type HandoffDistillInputV1,
} from "../runtime-api/handoffCommands.js";
import {
  isHandoffViewV1,
  parseHandoffViewV1,
  type HandoffViewV1,
} from "../runtime-api/handoffProjection.js";
import { isSafeHandoffRelativePath } from "../handoff/handoffPath.js";
import {
  isMissionControlTaskReorderInputV1,
  isMissionControlTaskUpdateInputV1,
  isMissionControlValidationCloseInputV1,
  type MissionControlTaskReorderInputV1,
  type MissionControlTaskUpdateInputV1,
  type MissionControlValidationCloseInputV1,
} from "../runtime-api/missionControlCommands.js";
import {
  isMissionControlViewV1,
  parseMissionControlViewV1,
  type MissionControlViewV1,
} from "../runtime-api/missionControlProjection.js";
import {
  isTaskPrototypeReviewInputV1,
  type TaskPrototypeReviewInputV1,
} from "../runtime-api/taskDetailCommands.js";
import {
  isTaskDetailViewV1,
  parseTaskDetailViewV1,
  type TaskDetailViewV1,
} from "../runtime-api/taskDetailProjection.js";
import {
  isPinStudioApplyInputV1,
  type PinStudioApplyActionV1,
  type PinStudioApplyInputV1,
} from "../runtime-api/pinStudioCommands.js";
import {
  isPinStudioViewV1,
  parsePinStudioViewV1,
  type PinStudioViewV1,
} from "../runtime-api/pinStudioProjection.js";
import { richDocAttachmentV1Schema } from "../runtime-api/richDocWire.js";
import {
  isTaskStudioApplyInputV1,
  isTaskStudioCancelInputV1,
  type TaskStudioApplyActionV1,
  type TaskStudioApplyInputV1,
  type TaskStudioCancelInputV1,
} from "../runtime-api/taskStudioCommands.js";
import {
  isTaskStudioViewV1,
  parseTaskStudioViewV1,
  type TaskStudioViewV1,
} from "../runtime-api/taskStudioProjection.js";

export { isStagedPayloadRefV1, type StagedPayloadRefV1 } from "../runtime-api/stagedPayload.js";

export const ENGINE_BUNDLE_SCHEMA_VERSION = 1 as const;
export const ENGINE_SHELL_PROTOCOL = 1 as const;

export interface EngineProtocolRangeV1 {
  min: number;
  max: number;
}

export interface EngineBundleFileV1 {
  /** POSIX-style path relative to the bundle root. */
  path: string;
  sha256: string;
  executable?: boolean;
}

export interface EngineBundleManifestV1 {
  schemaVersion: typeof ENGINE_BUNDLE_SCHEMA_VERSION;
  engineVersion: string;
  protocol: EngineProtocolRangeV1;
  entrypoint: string;
  files: EngineBundleFileV1[];
  build: {
    commit: string;
    treeSha: string;
    workingTreeClean: boolean;
  };
}

export interface EngineServiceIdentityV1 {
  schemaVersion: 1;
  workspaceRoot: string;
  workspaceHash: string;
  instanceId: string;
  pid: number;
  processStartIdentity: string;
  startedAt: string;
  bundleId: string;
  engineVersion: string;
  protocol: EngineProtocolRangeV1;
  bridge: {
    instanceId: string;
    port: number;
  };
}

export interface EngineShellHelloV1 {
  schemaVersion: 1;
  op: "attach";
  workspaceRoot: string;
  workspaceHash: string;
  shell: {
    id: string;
    version: string;
    locale: string;
  };
  protocol: EngineProtocolRangeV1;
  capabilities: string[];
  settingsDigest: string;
}

export interface EngineShellSessionV1 {
  schemaVersion: 1;
  shellId: string;
  sessionToken: string;
  protocol: number;
  engine: EngineServiceIdentityV1;
  snapshotSeq: number;
  leaseExpiresAt: string;
}

export interface WorkspaceSnapshotEnvelopeV1 {
  schemaVersion: 1;
  engineInstanceId: string;
  seq: number;
  projections: Record<string, unknown>;
}

export interface WorkspaceEventV1 {
  schemaVersion: 1;
  engineInstanceId: string;
  seq: number;
  at: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface WorkspaceEventBatchV1 {
  schemaVersion: 1;
  engineInstanceId: string;
  afterSeq: number;
  oldestSeq: number;
  latestSeq: number;
  resyncRequired: boolean;
  events: WorkspaceEventV1[];
}

export type WorkspaceCommandMethodV1 =
  | "agent.start"
  | "agent.stop"
  | "agent.kill"
  | "agent.restart"
  | "agent.resume"
  | "agent.input"
  | "studio.submit"
  | "task.update"
  | "task.reorder-lane"
  | "validation.close"
  | "task.prototype.review"
  | "task.studio.apply"
  | "task.studio.cancel"
  | "pin.studio.apply"
  | "handoff.ensure"
  | "handoff.distill";

export type WorkspaceAgentCommandMethodV1 = Extract<WorkspaceCommandMethodV1, `agent.${string}`>;
export type WorkspaceAgentLifecycleCommandMethodV1 = Exclude<WorkspaceAgentCommandMethodV1, "agent.input">;
export type WorkspaceSimpleCommandMethodV1 = Exclude<
  WorkspaceCommandMethodV1,
  "studio.submit" | "task.studio.apply" | "pin.studio.apply" | "handoff.ensure" | "handoff.distill"
>;

/** Exact versioned wire shape of the five config-backed Studio forms. */
export interface WorkspaceStudioFormV1 {
  name: string;
  cmd: string;
  kind: "agent" | "terminal" | "command" | "runbook" | "schedule";
  instructions: string;
  role: string;
  watch: string;
  steps: string;
  cwd: string;
  autostart: boolean;
  restartOnCrash: boolean;
  attention: boolean;
  worktree: boolean;
  branch: string;
  worktreeSetup: string;
  verify: string;
  harness: boolean;
  harnessInherit: string;
  harnessMcp: string;
  harnessRules: string;
  harnessInstructions: string;
  harnessSkills: string;
  harnessHooks: string;
  isolate: boolean;
  schedTiming: "every" | "at";
  schedEvery: string;
  schedAt: string;
  schedAction: "run" | "spawn";
  schedTarget: string;
  catchUp: boolean;
}

export type WorkspaceCommandV1 = {
  schemaVersion: 1;
  method: WorkspaceAgentLifecycleCommandMethodV1;
  input: { agent: string };
} | {
  schemaVersion: 1;
  method: "agent.input";
  input: AgentInputCommandV1;
} | {
  schemaVersion: 1;
  method: "studio.submit";
  input: { state: WorkspaceStudioFormV1; editingName?: string };
} | {
  schemaVersion: 1;
  method: "task.update";
  input: MissionControlTaskUpdateInputV1;
} | {
  schemaVersion: 1;
  method: "task.reorder-lane";
  input: MissionControlTaskReorderInputV1;
} | {
  schemaVersion: 1;
  method: "validation.close";
  input: MissionControlValidationCloseInputV1;
} | {
  schemaVersion: 1;
  method: "task.prototype.review";
  input: TaskPrototypeReviewInputV1;
} | {
  schemaVersion: 1;
  method: "task.studio.apply";
  input: TaskStudioApplyInputV1;
} | {
  schemaVersion: 1;
  method: "task.studio.cancel";
  input: TaskStudioCancelInputV1;
} | {
  schemaVersion: 1;
  method: "pin.studio.apply";
  input: PinStudioApplyInputV1;
} | {
  schemaVersion: 1;
  method: "handoff.ensure";
  input: Record<string, never>;
} | {
  schemaVersion: 1;
  method: "handoff.distill";
  input: HandoffDistillInputV1;
};

export type WorkspaceCommandResultV1 =
  | {
      schemaVersion: 1;
      method: WorkspaceSimpleCommandMethodV1;
      status: "ok";
    }
  | {
      schemaVersion: 1;
      method: "studio.submit";
      status: "ok";
      errors: string[];
      truncated: boolean;
    }
  | {
      schemaVersion: 1;
      method: "task.studio.apply";
      status: "ok";
      action: TaskStudioApplyActionV1;
      outcome: "saved" | "conflict" | "attachment-stored" | "prototype-imported";
      message?: string;
      attachment?: import("../richDoc/types.js").RichDocAttachment;
      overSoftLimit?: boolean;
    }
  | {
      schemaVersion: 1;
      method: "pin.studio.apply";
      status: "ok";
      action: PinStudioApplyActionV1;
      outcome: "saved" | "attachment-stored";
      pinId?: string;
      attachment?: import("../richDoc/types.js").RichDocAttachment;
      overSoftLimit?: boolean;
    }
  | {
      schemaVersion: 1;
      method: "handoff.ensure";
      status: "ok";
      canonicalRelativePath: string;
    }
  | {
      schemaVersion: 1;
      method: "handoff.distill";
      status: "ok";
      mode: HandoffDistillInputV1["mode"];
      agent: string;
    }
  | {
      schemaVersion: 1;
      method: WorkspaceCommandMethodV1;
      status: "error";
      code: string;
      message: string;
    };

export type WorkspaceQueryMethodV1 = "activity.context" | "probe.view" | "task.board" | "task.detail" | "task.studio" | "pin.studio" | "handoff.view";

export interface WorkspaceProbeViewRowV1 {
  runId: string;
  shortId: string;
  runtime: string;
  archetype: string;
  caller: string;
  status: "running" | "completed" | "failed";
  reason: string;
  ageLabel: string;
  excerpt: string;
}

export interface WorkspaceProbeViewV1 {
  rows: WorkspaceProbeViewRowV1[];
  total: number;
  running: number;
  completed: number;
  failed: number;
  empty: boolean;
  caller?: string;
}

/** Authenticated, side-effect-free reads do not enter the mutation operation registry. */
export type WorkspaceQueryV1 =
  | {
      schemaVersion: 1;
      method: "activity.context";
      input: { agent: string };
    }
  | {
      schemaVersion: 1;
      method: "probe.view";
      input: { caller?: string };
    }
  | {
      schemaVersion: 1;
      method: "task.board";
      input: { liveAdhocAgents: string[] };
    }
  | {
      schemaVersion: 1;
      method: "task.detail";
      input: { id: string };
    }
  | {
      schemaVersion: 1;
      method: "task.studio";
      input: { id: string };
    }
  | {
      schemaVersion: 1;
      method: "pin.studio";
      input: { id: string };
    }
  | {
      schemaVersion: 1;
      method: "handoff.view";
      input: Record<string, never>;
    };

export type WorkspaceQueryResultV1 =
  | {
      schemaVersion: 1;
      method: "activity.context";
      status: "ok";
      view: ActivityContextViewV1;
    }
  | {
      schemaVersion: 1;
      method: "probe.view";
      status: "ok";
      view: WorkspaceProbeViewV1;
    }
  | {
      schemaVersion: 1;
      method: "task.board";
      status: "ok";
      view: MissionControlViewV1;
    }
  | {
      schemaVersion: 1;
      method: "task.detail";
      status: "ok";
      view: TaskDetailViewV1;
    }
  | {
      schemaVersion: 1;
      method: "task.studio";
      status: "ok";
      view: TaskStudioViewV1;
    }
  | {
      schemaVersion: 1;
      method: "pin.studio";
      status: "ok";
      view: PinStudioViewV1;
    }
  | {
      schemaVersion: 1;
      method: "handoff.view";
      status: "ok";
      view: HandoffViewV1;
    }
  | {
      schemaVersion: 1;
      method: WorkspaceQueryMethodV1;
      status: "error";
      code: string;
      message: string;
    };

export type EngineControlRequestV1 =
  | { schemaVersion: 1; op: "health"; workspaceHash: string }
  | { schemaVersion: 1; op: "attach"; workspaceHash: string; hello: EngineShellHelloV1 }
  | { schemaVersion: 1; op: "touch"; workspaceHash: string; shellId: string; sessionToken: string }
  | { schemaVersion: 1; op: "snapshot"; workspaceHash: string; shellId: string; sessionToken: string }
  | { schemaVersion: 1; op: "events"; workspaceHash: string; shellId: string; sessionToken: string; afterSeq: number; limit: number }
  | { schemaVersion: 1; op: "query"; workspaceHash: string; shellId: string; sessionToken: string; query: WorkspaceQueryV1 }
  | { schemaVersion: 1; op: "invoke"; workspaceHash: string; shellId: string; sessionToken: string; operationId: string; command: WorkspaceCommandV1 }
  | { schemaVersion: 1; op: "detach"; workspaceHash: string; shellId: string; sessionToken: string };

export type EngineControlResponseV1 =
  | { ok: true; op: "health"; engine: EngineServiceIdentityV1; shellCount: number }
  | { ok: true; op: "attach" | "touch"; session: EngineShellSessionV1 }
  | { ok: true; op: "snapshot"; snapshot: WorkspaceSnapshotEnvelopeV1 }
  | { ok: true; op: "events"; batch: WorkspaceEventBatchV1 }
  | { ok: true; op: "query"; result: WorkspaceQueryResultV1 }
  | { ok: true; op: "invoke"; operationId: string; result: WorkspaceCommandResultV1 }
  | { ok: true; op: "detach"; detached: true }
  | { ok: false; code: string; message: string };

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_ID_RE = /^[a-f0-9]{7,64}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
export const MISSION_CONTROL_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
export const TASK_DETAIL_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const TASK_STUDIO_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
export const PIN_STUDIO_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
export const HANDOFF_VIEW_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const WORKSPACE_COMMAND_METHODS = new Set<WorkspaceCommandMethodV1>([
  "agent.start",
  "agent.stop",
  "agent.kill",
  "agent.restart",
  "agent.resume",
  "agent.input",
  "studio.submit",
  "task.update",
  "task.reorder-lane",
  "validation.close",
  "task.prototype.review",
  "task.studio.apply",
  "task.studio.cancel",
  "pin.studio.apply",
  "handoff.ensure",
  "handoff.distill",
]);

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

export function isEngineOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION_ID_RE.test(value);
}

export function isWorkspaceCommandV1(value: unknown): value is WorkspaceCommandV1 {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["schemaVersion", "method", "input"])
    || value.schemaVersion !== 1
    || typeof value.method !== "string"
    || !WORKSPACE_COMMAND_METHODS.has(value.method as WorkspaceCommandMethodV1)
    || !isRecord(value.input)) return false;
  if (value.method === "studio.submit") return isWorkspaceStudioSubmitInputV1(value.input);
  if (value.method === "agent.input") return isAgentInputCommandV1(value.input);
  if (value.method === "task.update") return isMissionControlTaskUpdateInputV1(value.input);
  if (value.method === "task.reorder-lane") return isMissionControlTaskReorderInputV1(value.input);
  if (value.method === "validation.close") return isMissionControlValidationCloseInputV1(value.input);
  if (value.method === "task.prototype.review") return isTaskPrototypeReviewInputV1(value.input);
  if (value.method === "task.studio.apply") return isTaskStudioApplyInputV1(value.input);
  if (value.method === "task.studio.cancel") return isTaskStudioCancelInputV1(value.input);
  if (value.method === "pin.studio.apply") return isPinStudioApplyInputV1(value.input);
  if (value.method === "handoff.ensure") return hasOnlyKeys(value.input, []);
  if (value.method === "handoff.distill") return isHandoffDistillInputV1(value.input);
  return hasOnlyKeys(value.input, ["agent"])
    && typeof value.input.agent === "string"
    && AGENT_NAME_RE.test(value.input.agent);
}

export function isWorkspaceCommandResultV1(value: unknown): value is WorkspaceCommandResultV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.method !== "string"
    || !WORKSPACE_COMMAND_METHODS.has(value.method as WorkspaceCommandMethodV1)) return false;
  if (value.status === "ok" && value.method === "studio.submit") {
    return hasOnlyKeys(value, ["schemaVersion", "method", "status", "errors", "truncated"])
      && Array.isArray(value.errors)
      && value.errors.length <= 50
      && value.errors.every((error) => typeof error === "string" && error.length > 0 && error.length <= 1_000)
      && typeof value.truncated === "boolean";
  }
  if (value.status === "ok" && value.method === "task.studio.apply") {
    const expectedKeys = ["schemaVersion", "method", "status", "action", "outcome"];
    if (value.message !== undefined) expectedKeys.push("message");
    if (value.attachment !== undefined) expectedKeys.push("attachment");
    if (value.overSoftLimit !== undefined) expectedKeys.push("overSoftLimit");
    if (!hasOnlyKeys(value, expectedKeys)
      || (value.action !== "save" && value.action !== "put-image" && value.action !== "put-sketch" && value.action !== "import-prototype")
      || (value.outcome !== "saved" && value.outcome !== "conflict" && value.outcome !== "attachment-stored" && value.outcome !== "prototype-imported")) return false;
    if (value.action === "save") {
      return (value.outcome === "saved" || value.outcome === "conflict")
        && (value.outcome !== "conflict" || (typeof value.message === "string" && value.message.length > 0 && value.message.length <= 1_000))
        && (value.outcome !== "saved" || value.message === undefined)
        && value.attachment === undefined && value.overSoftLimit === undefined;
    }
    if (value.action === "import-prototype") {
      return value.outcome === "prototype-imported" && value.message === undefined
        && value.attachment === undefined && value.overSoftLimit === undefined;
    }
    const attachment = richDocAttachmentV1Schema.safeParse(value.attachment);
    return value.outcome === "attachment-stored" && value.message === undefined
      && attachment.success
      && ((value.action === "put-image" && attachment.data.kind === "image")
        || (value.action === "put-sketch" && attachment.data.kind === "excalidraw"))
      && typeof value.overSoftLimit === "boolean";
  }
  if (value.status === "ok" && value.method === "pin.studio.apply") {
    const expectedKeys = ["schemaVersion", "method", "status", "action", "outcome"];
    if (value.pinId !== undefined) expectedKeys.push("pinId");
    if (value.attachment !== undefined) expectedKeys.push("attachment");
    if (value.overSoftLimit !== undefined) expectedKeys.push("overSoftLimit");
    if (!hasOnlyKeys(value, expectedKeys)
      || (value.action !== "save" && value.action !== "put-image" && value.action !== "put-sketch")
      || (value.outcome !== "saved" && value.outcome !== "attachment-stored")) return false;
    if (value.action === "save") {
      return value.outcome === "saved"
        && typeof value.pinId === "string" && /^p-[0-9a-f]{6}$/.test(value.pinId)
        && value.attachment === undefined && value.overSoftLimit === undefined;
    }
    const attachment = richDocAttachmentV1Schema.safeParse(value.attachment);
    return value.outcome === "attachment-stored" && value.pinId === undefined
      && attachment.success
      && ((value.action === "put-image" && attachment.data.kind === "image")
        || (value.action === "put-sketch" && attachment.data.kind === "excalidraw"))
      && typeof value.overSoftLimit === "boolean";
  }
  if (value.status === "ok" && value.method === "handoff.ensure") {
    return hasOnlyKeys(value, ["schemaVersion", "method", "status", "canonicalRelativePath"])
      && isSafeHandoffRelativePath(value.canonicalRelativePath);
  }
  if (value.status === "ok" && value.method === "handoff.distill") {
    return hasOnlyKeys(value, ["schemaVersion", "method", "status", "mode", "agent"])
      && (value.mode === "existing" || value.mode === "adhoc")
      && typeof value.agent === "string"
      && AGENT_NAME_RE.test(value.agent);
  }
  if (value.status === "ok") {
    return hasOnlyKeys(value, ["schemaVersion", "method", "status"])
      && value.method !== "studio.submit"
      && value.method !== "task.studio.apply"
      && value.method !== "pin.studio.apply"
      && value.method !== "handoff.ensure"
      && value.method !== "handoff.distill";
  }
  return value.status === "error"
    && hasOnlyKeys(value, ["schemaVersion", "method", "status", "code", "message"])
    && typeof value.code === "string"
    && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code)
    && typeof value.message === "string"
    && value.message.length > 0
    && value.message.length <= 1_000;
}

export function isWorkspaceQueryV1(value: unknown): value is WorkspaceQueryV1 {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["schemaVersion", "method", "input"])
    || value.schemaVersion !== 1
    || !isRecord(value.input)) return false;
  if (value.method === "activity.context") {
    return hasOnlyKeys(value.input, ["agent"])
      && typeof value.input.agent === "string"
      && AGENT_NAME_RE.test(value.input.agent);
  }
  if (value.method === "task.board") {
    return hasOnlyKeys(value.input, ["liveAdhocAgents"])
      && Array.isArray(value.input.liveAdhocAgents)
      && value.input.liveAdhocAgents.length <= 500
      && value.input.liveAdhocAgents.every((agent) => typeof agent === "string" && AGENT_NAME_RE.test(agent))
      && new Set(value.input.liveAdhocAgents).size === value.input.liveAdhocAgents.length;
  }
  if (value.method === "task.detail" || value.method === "task.studio") {
    return hasOnlyKeys(value.input, ["id"])
      && typeof value.input.id === "string"
      && /^t-[0-9a-f]{6}$/.test(value.input.id);
  }
  if (value.method === "pin.studio") {
    return hasOnlyKeys(value.input, ["id"])
      && typeof value.input.id === "string"
      && /^p-[0-9a-f]{6}$/.test(value.input.id);
  }
  if (value.method === "handoff.view") return hasOnlyKeys(value.input, []);
  if (value.method !== "probe.view") return false;
  const keys = Object.keys(value.input);
  return keys.every((key) => key === "caller")
    && (value.input.caller === undefined
      || (typeof value.input.caller === "string" && AGENT_NAME_RE.test(value.input.caller)));
}

export function isWorkspaceQueryResultV1(value: unknown): value is WorkspaceQueryResultV1 {
  if (!isRecord(value) || value.schemaVersion !== 1
    || (value.method !== "activity.context" && value.method !== "probe.view" && value.method !== "task.board" && value.method !== "task.detail" && value.method !== "task.studio" && value.method !== "pin.studio" && value.method !== "handoff.view")) return false;
  if (value.status === "ok") {
    return hasOnlyKeys(value, ["schemaVersion", "method", "status", "view"])
      && (value.method === "activity.context"
        ? isActivityContextViewV1(value.view)
        : value.method === "probe.view"
          ? isWorkspaceProbeViewV1(value.view)
          : value.method === "task.board"
            ? isMissionControlViewV1(value.view)
            : value.method === "task.detail"
              ? isTaskDetailViewV1(value.view)
              : value.method === "task.studio"
                ? isTaskStudioViewV1(value.view)
                : value.method === "pin.studio"
                  ? isPinStudioViewV1(value.view)
                  : isHandoffViewV1(value.view));
  }
  return value.status === "error"
    && hasOnlyKeys(value, ["schemaVersion", "method", "status", "code", "message"])
    && typeof value.code === "string"
    && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code)
    && typeof value.message === "string"
    && value.message.length > 0
    && value.message.length <= 1_000;
}

/** Cross-binds every successful query result to the identity supplied by the authenticated request. */
export function isWorkspaceQueryResultBoundToInput(
  query: WorkspaceQueryV1,
  result: WorkspaceQueryResultV1,
): boolean {
  if (query.method !== result.method) return false;
  if (result.status === "error") return true;
  if (query.method === "activity.context" && result.method === "activity.context") {
    return result.view.context.agent === query.input.agent;
  }
  if (query.method === "probe.view" && result.method === "probe.view") {
    return result.view.caller === query.input.caller;
  }
  if (query.method === "task.detail" && result.method === "task.detail") {
    return result.view.detail.task.id === query.input.id;
  }
  if (query.method === "task.studio" && result.method === "task.studio") {
    return result.view.studio.taskId === query.input.id;
  }
  if (query.method === "pin.studio" && result.method === "pin.studio") {
    return result.view.studio.pinId === query.input.id;
  }
  return true;
}

export function workspaceActivityContextSuccessV1(view: ActivityContextViewV1): WorkspaceQueryResultV1 {
  return {
    schemaVersion: 1,
    method: "activity.context",
    status: "ok",
    view: parseActivityContextViewV1(view),
  };
}

/** Bounds the journal/prototype metadata response without moving attachment bytes through control. */
export function workspaceTaskDetailViewSuccessV1(view: TaskDetailViewV1): WorkspaceQueryResultV1 {
  const result = {
    schemaVersion: 1,
    method: "task.detail",
    status: "ok",
    view: parseTaskDetailViewV1(view),
  } as const;
  const transportEnvelope = { ok: true as const, op: "query" as const, result };
  if (Buffer.byteLength(`${JSON.stringify(transportEnvelope)}\n`, "utf8") > TASK_DETAIL_RESPONSE_MAX_BYTES) {
    throw new Error("Task Detail view exceeds its dedicated response size limit");
  }
  return result;
}

export function workspaceTaskStudioViewSuccessV1(view: TaskStudioViewV1): WorkspaceQueryResultV1 {
  const result = {
    schemaVersion: 1,
    method: "task.studio",
    status: "ok",
    view: parseTaskStudioViewV1(view),
  } as const;
  const transportEnvelope = { ok: true as const, op: "query" as const, result };
  if (Buffer.byteLength(`${JSON.stringify(transportEnvelope)}\n`, "utf8") > TASK_STUDIO_RESPONSE_MAX_BYTES) {
    throw new Error("Task Studio view exceeds its dedicated response size limit");
  }
  return result;
}

export function workspacePinStudioViewSuccessV1(view: PinStudioViewV1): WorkspaceQueryResultV1 {
  const result = {
    schemaVersion: 1,
    method: "pin.studio",
    status: "ok",
    view: parsePinStudioViewV1(view),
  } as const;
  const transportEnvelope = { ok: true as const, op: "query" as const, result };
  if (Buffer.byteLength(`${JSON.stringify(transportEnvelope)}\n`, "utf8") > PIN_STUDIO_RESPONSE_MAX_BYTES) {
    throw new Error("Pin Studio view exceeds its dedicated response size limit");
  }
  return result;
}

export function workspaceHandoffViewSuccessV1(view: HandoffViewV1): WorkspaceQueryResultV1 {
  const result = {
    schemaVersion: 1,
    method: "handoff.view",
    status: "ok",
    view: parseHandoffViewV1(view),
  } as const;
  const transportEnvelope = { ok: true as const, op: "query" as const, result };
  if (Buffer.byteLength(`${JSON.stringify(transportEnvelope)}\n`, "utf8") > HANDOFF_VIEW_RESPONSE_MAX_BYTES) {
    throw new Error("Project Handoff view exceeds its dedicated response size limit");
  }
  return result;
}

/** Builds and bounds the large board read without relaxing the 64 KiB limit of any other control response. */
export function workspaceMissionControlViewSuccessV1(view: MissionControlViewV1): WorkspaceQueryResultV1 {
  const result = {
    schemaVersion: 1,
    method: "task.board",
    status: "ok",
    view: parseMissionControlViewV1(view),
  } as const;
  const transportEnvelope = { ok: true as const, op: "query" as const, result };
  // The control server terminates every response with a newline. Measure the exact bytes the
  // client receives so a payload at the boundary cannot pass here and fail one byte later.
  if (Buffer.byteLength(`${JSON.stringify(transportEnvelope)}\n`, "utf8") > MISSION_CONTROL_RESPONSE_MAX_BYTES) {
    throw new Error("Mission Control view exceeds its dedicated response size limit");
  }
  return result;
}

/** Bound the daemon-owned Probe model before it crosses the 64 KiB control response boundary. */
export function workspaceProbeViewSuccessV1(view: WorkspaceProbeViewV1): WorkspaceQueryResultV1 {
  if (!Array.isArray(view.rows) || view.rows.length > 50) throw new Error("probe view exceeds its row limit");
  const rows = view.rows.map((row) => {
    if (row.status !== "running" && row.status !== "completed" && row.status !== "failed") {
      throw new Error("probe view contains an invalid status");
    }
    return {
      runId: queryText(row.runId, 1, 128, "probe runId"),
      shortId: queryText(row.shortId, 1, 16, "probe shortId"),
      runtime: queryText(row.runtime, 1, 64, "probe runtime"),
      archetype: queryText(row.archetype, 1, 64, "probe archetype"),
      caller: queryText(row.caller, 1, 128, "probe caller"),
      status: row.status,
      reason: queryText(row.reason, 1, 128, "probe reason"),
      ageLabel: queryText(row.ageLabel, 1, 32, "probe ageLabel"),
      excerpt: queryText(row.excerpt, 0, 240, "probe excerpt"),
    } satisfies WorkspaceProbeViewRowV1;
  });
  const caller = view.caller === undefined ? undefined : queryAgentName(view.caller, "probe view caller");
  return {
    schemaVersion: 1,
    method: "probe.view",
    status: "ok",
    view: {
      rows,
      total: rows.length,
      running: rows.filter((row) => row.status === "running").length,
      completed: rows.filter((row) => row.status === "completed").length,
      failed: rows.filter((row) => row.status === "failed").length,
      empty: rows.length === 0,
      ...(caller !== undefined ? { caller } : {}),
    },
  };
}

export function workspaceCommandSuccessV1(
  command: WorkspaceCommandV1,
  studioErrors: readonly string[] = [],
): WorkspaceCommandResultV1 {
  if (command.method === "task.studio.apply" || command.method === "pin.studio.apply"
    || command.method === "handoff.ensure" || command.method === "handoff.distill") {
    throw new Error("command requires an exact outcome");
  }
  if (command.method !== "studio.submit") {
    return { schemaVersion: 1, method: command.method, status: "ok" };
  }
  const normalized = studioErrors.map((error) => error.trim() || "Studio validation failed");
  return {
    schemaVersion: 1,
    method: command.method,
    status: "ok",
    errors: normalized.slice(0, 50).map((error) => error.slice(0, 1_000)),
    truncated: normalized.length > 50 || normalized.some((error) => error.length > 1_000),
  };
}

export function workspaceHandoffEnsureSuccessV1(
  command: Extract<WorkspaceCommandV1, { method: "handoff.ensure" }>,
  canonicalRelativePath: string,
): WorkspaceCommandResultV1 {
  const candidate: WorkspaceCommandResultV1 = {
    schemaVersion: 1,
    method: command.method,
    status: "ok",
    canonicalRelativePath,
  };
  if (!isWorkspaceCommandResultV1(candidate)) throw new Error("Project Handoff ensure result is invalid");
  return candidate;
}

export function workspaceHandoffDistillSuccessV1(
  command: Extract<WorkspaceCommandV1, { method: "handoff.distill" }>,
  result: { mode: HandoffDistillInputV1["mode"]; agent: string },
): WorkspaceCommandResultV1 {
  if (result.mode !== command.input.mode) throw new Error("Project Handoff distill result changed its requested mode");
  if (command.input.mode === "existing" && result.agent !== command.input.agent) {
    throw new Error("Project Handoff distill result changed its requested agent");
  }
  const candidate: WorkspaceCommandResultV1 = {
    schemaVersion: 1,
    method: command.method,
    status: "ok",
    mode: result.mode,
    agent: result.agent,
  };
  if (!isWorkspaceCommandResultV1(candidate)) throw new Error("Project Handoff distill result is invalid");
  return candidate;
}

export function workspaceTaskStudioApplySuccessV1(
  command: Extract<WorkspaceCommandV1, { method: "task.studio.apply" }>,
  outcome:
    | { outcome: "saved" }
    | { outcome: "conflict"; message: string }
    | { outcome: "attachment-stored"; attachment: import("../richDoc/types.js").RichDocAttachment; overSoftLimit: boolean }
    | { outcome: "prototype-imported" },
): WorkspaceCommandResultV1 {
  const candidate: WorkspaceCommandResultV1 = {
    schemaVersion: 1,
    method: command.method,
    status: "ok",
    action: command.input.action,
    ...outcome,
  };
  if (!isWorkspaceCommandResultV1(candidate)) throw new Error("Task Studio apply result contradicts its action");
  return candidate;
}

export function workspacePinStudioApplySuccessV1(
  command: Extract<WorkspaceCommandV1, { method: "pin.studio.apply" }>,
  outcome:
    | { outcome: "saved"; pinId: string }
    | { outcome: "attachment-stored"; attachment: import("../richDoc/types.js").RichDocAttachment; overSoftLimit: boolean },
): WorkspaceCommandResultV1 {
  if (command.input.action === "save" && command.input.pinId !== undefined
    && outcome.outcome === "saved" && outcome.pinId !== command.input.pinId) {
    throw new Error("Pin Studio save result changed the requested pin identity");
  }
  const candidate: WorkspaceCommandResultV1 = {
    schemaVersion: 1,
    method: command.method,
    status: "ok",
    action: command.input.action,
    ...outcome,
  };
  if (!isWorkspaceCommandResultV1(candidate)) throw new Error("Pin Studio apply result contradicts its action");
  return candidate;
}

const STUDIO_FORM_STRING_KEYS = [
  "name", "cmd", "instructions", "role", "watch", "steps", "cwd", "branch", "worktreeSetup",
  "verify", "harnessInherit", "harnessMcp", "harnessRules", "harnessInstructions", "harnessSkills",
  "harnessHooks", "schedEvery", "schedAt", "schedTarget",
] as const;
const STUDIO_FORM_BOOLEAN_KEYS = [
  "autostart", "restartOnCrash", "attention", "worktree", "harness", "isolate", "catchUp",
] as const;
const STUDIO_FORM_KEYS = [
  ...STUDIO_FORM_STRING_KEYS,
  ...STUDIO_FORM_BOOLEAN_KEYS,
  "kind", "schedTiming", "schedAction",
];

function isWorkspaceStudioSubmitInputV1(value: Record<string, unknown>): boolean {
  const inputKeys = Object.keys(value);
  if (!("state" in value)
    || inputKeys.some((key) => key !== "state" && key !== "editingName")
    || !isRecord(value.state)) return false;
  if (value.editingName !== undefined
    && (typeof value.editingName !== "string" || !AGENT_NAME_RE.test(value.editingName))) return false;
  const state = value.state;
  if (!hasOnlyKeys(state, STUDIO_FORM_KEYS)) return false;
  if (STUDIO_FORM_STRING_KEYS.some((key) => typeof state[key] !== "string" || (state[key] as string).length > 32_768)) return false;
  if (STUDIO_FORM_BOOLEAN_KEYS.some((key) => typeof state[key] !== "boolean")) return false;
  return ["agent", "terminal", "command", "runbook", "schedule"].includes(state.kind as string)
    && (state.schedTiming === "every" || state.schedTiming === "at")
    && (state.schedAction === "run" || state.schedAction === "spawn");
}

/** Bundle paths are canonical POSIX relative paths on every host. */
export function isSafeBundlePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240) return false;
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || value.includes("\0")) return false;
  const segments = value.split("/");
  return segments.every((segment) => /^[A-Za-z0-9_@.+-]+$/.test(segment) && segment !== "." && segment !== "..");
}

export function isEngineProtocolRangeV1(value: unknown): value is EngineProtocolRangeV1 {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.min)
    && Number.isSafeInteger(value.max)
    && (value.min as number) > 0
    && (value.max as number) >= (value.min as number);
}

export function isEngineBundleManifestV1(value: unknown): value is EngineBundleManifestV1 {
  if (!isRecord(value) || value.schemaVersion !== ENGINE_BUNDLE_SCHEMA_VERSION) return false;
  if (typeof value.engineVersion !== "string" || value.engineVersion.trim().length === 0) return false;
  if (!isEngineProtocolRangeV1(value.protocol) || !isSafeBundlePath(value.entrypoint)) return false;
  if (!Array.isArray(value.files) || value.files.length === 0) return false;
  const seen = new Set<string>();
  let hasEntrypoint = false;
  for (const candidate of value.files) {
    if (!isRecord(candidate) || !isSafeBundlePath(candidate.path) || !isSha256(candidate.sha256)) return false;
    if (candidate.executable !== undefined && typeof candidate.executable !== "boolean") return false;
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    if (candidate.path === value.entrypoint) hasEntrypoint = true;
  }
  if (!hasEntrypoint || !isRecord(value.build)) return false;
  return typeof value.build.commit === "string"
    && GIT_ID_RE.test(value.build.commit)
    && typeof value.build.treeSha === "string"
    && GIT_ID_RE.test(value.build.treeSha)
    && typeof value.build.workingTreeClean === "boolean";
}

export function isEngineShellHelloV1(value: unknown): value is EngineShellHelloV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.op !== "attach") return false;
  if (typeof value.workspaceRoot !== "string" || value.workspaceRoot.length === 0) return false;
  if (typeof value.workspaceHash !== "string" || value.workspaceHash.length === 0) return false;
  if (!isRecord(value.shell)
    || typeof value.shell.id !== "string" || value.shell.id.length < 8 || value.shell.id.length > 128
    || typeof value.shell.version !== "string" || value.shell.version.length === 0
    || typeof value.shell.locale !== "string" || value.shell.locale.length === 0) return false;
  if (!isEngineProtocolRangeV1(value.protocol)) return false;
  if (!Array.isArray(value.capabilities)
    || value.capabilities.length > 128
    || value.capabilities.some((capability) => typeof capability !== "string" || capability.length === 0 || capability.length > 128)
    || new Set(value.capabilities).size !== value.capabilities.length) return false;
  return isSha256(value.settingsDigest);
}

export function isEngineServiceIdentityV1(value: unknown): value is EngineServiceIdentityV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.workspaceRoot !== "string" || value.workspaceRoot.length === 0 || value.workspaceRoot.length > 4_096) return false;
  if (typeof value.workspaceHash !== "string" || value.workspaceHash.length === 0 || value.workspaceHash.length > 128) return false;
  if (typeof value.instanceId !== "string" || value.instanceId.length < 8 || value.instanceId.length > 128) return false;
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return false;
  if (typeof value.processStartIdentity !== "string" || value.processStartIdentity.length === 0 || value.processStartIdentity.length > 256) return false;
  if (typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) return false;
  if (!isSha256(value.bundleId)) return false;
  if (typeof value.engineVersion !== "string" || value.engineVersion.length === 0 || value.engineVersion.length > 128) return false;
  if (!isEngineProtocolRangeV1(value.protocol) || !isRecord(value.bridge)) return false;
  return typeof value.bridge.instanceId === "string"
    && value.bridge.instanceId.length >= 8
    && value.bridge.instanceId.length <= 128
    && Number.isSafeInteger(value.bridge.port)
    && (value.bridge.port as number) > 0
    && (value.bridge.port as number) <= 65_535;
}

export function isWorkspaceSnapshotEnvelopeV1(value: unknown): value is WorkspaceSnapshotEnvelopeV1 {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.engineInstanceId === "string"
    && value.engineInstanceId.length >= 8
    && value.engineInstanceId.length <= 128
    && Number.isSafeInteger(value.seq)
    && (value.seq as number) >= 0
    && isRecord(value.projections);
}

export function isEngineShellSessionV1(value: unknown): value is EngineShellSessionV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.shellId !== "string" || value.shellId.length < 8 || value.shellId.length > 128) return false;
  if (typeof value.sessionToken !== "string" || value.sessionToken.length < 32 || value.sessionToken.length > 256) return false;
  if (!Number.isSafeInteger(value.protocol) || (value.protocol as number) <= 0) return false;
  if (!isEngineServiceIdentityV1(value.engine)) return false;
  if (!Number.isSafeInteger(value.snapshotSeq) || (value.snapshotSeq as number) < 0) return false;
  return typeof value.leaseExpiresAt === "string" && Number.isFinite(Date.parse(value.leaseExpiresAt));
}

export function isWorkspaceEventV1(value: unknown): value is WorkspaceEventV1 {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.engineInstanceId === "string"
    && value.engineInstanceId.length >= 8
    && value.engineInstanceId.length <= 128
    && Number.isSafeInteger(value.seq)
    && (value.seq as number) > 0
    && typeof value.at === "string"
    && Number.isFinite(Date.parse(value.at))
    && typeof value.kind === "string"
    && /^[a-z][a-z0-9.-]{0,63}$/.test(value.kind)
    && isRecord(value.payload);
}

export function isWorkspaceEventBatchV1(value: unknown): value is WorkspaceEventBatchV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.engineInstanceId !== "string" || value.engineInstanceId.length < 8 || value.engineInstanceId.length > 128) return false;
  if (!Number.isSafeInteger(value.afterSeq) || (value.afterSeq as number) < 0
    || !Number.isSafeInteger(value.oldestSeq) || (value.oldestSeq as number) < 1
    || !Number.isSafeInteger(value.latestSeq) || (value.latestSeq as number) < 0
    || typeof value.resyncRequired !== "boolean" || !Array.isArray(value.events) || value.events.length > 200) return false;
  if ((value.oldestSeq as number) > (value.latestSeq as number) + 1) return false;
  const shouldResync = (value.afterSeq as number) > (value.latestSeq as number)
    || (value.afterSeq as number) < (value.oldestSeq as number) - 1;
  if (value.resyncRequired !== shouldResync) return false;
  let previous = value.afterSeq as number;
  for (const event of value.events) {
    if (!isWorkspaceEventV1(event)
      || event.engineInstanceId !== value.engineInstanceId
      || event.seq !== previous + 1
      || event.seq > (value.latestSeq as number)) return false;
    previous = event.seq;
  }
  if (value.resyncRequired && value.events.length > 0) return false;
  if (!value.resyncRequired && (value.afterSeq as number) < (value.latestSeq as number) && value.events.length === 0) return false;
  return true;
}

export function isEngineControlResponseV1(value: unknown): value is EngineControlResponseV1 {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) {
    return typeof value.code === "string"
      && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code)
      && typeof value.message === "string"
      && value.message.length > 0
      && value.message.length <= 4_096;
  }
  if (value.op === "health") {
    return isEngineServiceIdentityV1(value.engine)
      && Number.isSafeInteger(value.shellCount)
      && (value.shellCount as number) >= 0;
  }
  if (value.op === "attach" || value.op === "touch") return isEngineShellSessionV1(value.session);
  if (value.op === "snapshot") return isWorkspaceSnapshotEnvelopeV1(value.snapshot);
  if (value.op === "events") return isWorkspaceEventBatchV1(value.batch);
  if (value.op === "query") return isWorkspaceQueryResultV1(value.result);
  if (value.op === "invoke") {
    return isEngineOperationId(value.operationId)
      && isWorkspaceCommandResultV1(value.result);
  }
  return value.op === "detach" && value.detached === true;
}

/** Highest mutually supported protocol, or undefined when the ranges do not overlap. */
export function negotiateEngineShellProtocol(
  engine: EngineProtocolRangeV1,
  shell: EngineProtocolRangeV1,
): number | undefined {
  const lower = Math.max(engine.min, shell.min);
  const upper = Math.min(engine.max, shell.max);
  return lower <= upper ? upper : undefined;
}

/** Stable id for a byte-identical manifest; field order supplied by callers cannot change it. */
export function engineBundleId(manifest: EngineBundleManifestV1): string {
  const normalized = {
    schemaVersion: manifest.schemaVersion,
    engineVersion: manifest.engineVersion,
    protocol: { min: manifest.protocol.min, max: manifest.protocol.max },
    entrypoint: manifest.entrypoint,
    files: [...manifest.files]
      .map((file) => ({ path: file.path, sha256: file.sha256, executable: file.executable === true }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    build: {
      commit: manifest.build.commit,
      treeSha: manifest.build.treeSha,
      workingTreeClean: manifest.build.workingTreeClean,
    },
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isWorkspaceProbeViewV1(value: unknown): value is WorkspaceProbeViewV1 {
  if (!isRecord(value)) return false;
  const expected = ["rows", "total", "running", "completed", "failed", "empty"];
  if (value.caller !== undefined) expected.push("caller");
  if (!hasOnlyKeys(value, expected)
    || !Array.isArray(value.rows)
    || value.rows.length > 50
    || typeof value.empty !== "boolean"
    || (value.caller !== undefined
      && (typeof value.caller !== "string" || !AGENT_NAME_RE.test(value.caller)))) return false;
  const counts = [value.total, value.running, value.completed, value.failed];
  if (counts.some((count) => !Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 50)) return false;
  if ((value.total as number) !== value.rows.length
    || value.empty !== (value.rows.length === 0)
    || (value.running as number) + (value.completed as number) + (value.failed as number) !== value.rows.length) return false;
  let running = 0;
  let completed = 0;
  let failed = 0;
  for (const row of value.rows) {
    if (!isRecord(row)
      || !hasOnlyKeys(row, ["runId", "shortId", "runtime", "archetype", "caller", "status", "reason", "ageLabel", "excerpt"])
      || !queryTextValid(row.runId, 1, 128)
      || !queryTextValid(row.shortId, 1, 16)
      || !queryTextValid(row.runtime, 1, 64)
      || !queryTextValid(row.archetype, 1, 64)
      || !queryTextValid(row.caller, 1, 128)
      || !queryTextValid(row.reason, 1, 128)
      || !queryTextValid(row.ageLabel, 1, 32)
      || !queryTextValid(row.excerpt, 0, 240)) return false;
    if (row.status === "running") running++;
    else if (row.status === "completed") completed++;
    else if (row.status === "failed") failed++;
    else return false;
  }
  return running === value.running && completed === value.completed && failed === value.failed;
}

function queryText(value: unknown, min: number, max: number, label: string): string {
  if (!queryTextValid(value, min, max)) throw new Error(`${label} is invalid or exceeds its wire limit`);
  return value;
}

function queryAgentName(value: unknown, label: string): string {
  if (typeof value !== "string" || !AGENT_NAME_RE.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function queryTextValid(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}
