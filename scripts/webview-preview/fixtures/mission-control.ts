/**
 * spec 346 — Mission Control fixture for the dev preview harness. Provenance: synthetic-edge, typed against
 * the real MissionControlVM. It covers the validations strip, all always-on board columns, a dropped card,
 * agent chips, priorities, assignees, SDD badges, attention, and attachment count.
 */

import type { MissionControlVM } from "../../../src/webview/mission-control/messages";
import type { BoardSnapshot } from "../../../src/tasks/boardSnapshot";
import type { Task, TaskView } from "../../../src/tasks/types";
import type { ValidationSummary } from "../../../src/validations/ValidationStore";
import type { ValidationCandidate } from "../../../src/validations/types";
import type { Fixture } from "../routes";

const now = "2026-07-03T20:05:00.000Z";

function task(id: string, status: Task["status"], title: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title,
    status,
    author: "human",
    createdAt: "2026-07-03T18:00:00.000Z",
    updatedAt: now,
    ...patch,
  };
}

const views: TaskView[] = [
  {
    task: task("t-2d3580", "inbox", "Bridge: sessoes MCP antigas nao veem tools novas apos reload", {
      kind: "bug",
      body: "Resident agents need a reload path when bridge tools change.",
    }),
  },
  {
    task: task("t-4bf28a", "inbox", "Board: file watcher em .tachyon/tasks nao refresca out-of-band", {
      kind: "feature",
      priority: 2,
    }),
  },
  {
    task: task("t-8f86e2", "triaged", "Verificar: spec 341 resolveu perdas de entrega do notify_agent", {
      kind: "bug",
      priority: 1,
      assignee: "claude",
    }),
    attention: [{ code: "ready_to_close", message: "Needs maintainer verification before close" }],
  },
  {
    task: task("t-9a41b2", "triaged", "Board v1.1: reorder in-column mantendo rank", {
      kind: "feature",
      assignee: "codex",
      artifact_refs: [{ type: "sdd", ref: "shipped-partial" }],
    }),
    derived: { sdd: { type: "sdd", ref: "335", status: "shipped-partial" } },
  },
  {
    task: task("t-a11f0e", "active", "Spec: Task Studio form completo de criacao/edicao de tasks", {
      kind: "feature",
      priority: 1,
      assignee: "claude",
      artifact_refs: [{ type: "sdd", ref: "335" }],
    }),
    derived: { sdd: { type: "sdd", ref: "335", status: "in-progress" } },
  },
  {
    task: task("t-82f870", "active", "Board: separar trabalho landed do que ainda esta em voo", {
      kind: "feature",
      priority: 2,
      assignee: "finished-runner",
      artifact_refs: [{ type: "sdd", ref: "335" }],
    }),
    derived: { sdd: { type: "sdd", ref: "335", status: "in-progress" } },
  },
  {
    task: task("t-c04b3e", "done", "Design system: componentizar elementos de formulario repetitivos", {
      kind: "feature",
      priority: 2,
      assignee: "claude",
    }),
  },
  {
    task: task("t-c0e711", "dropped", "Board: context menu no card para mover para Dropped", {
      kind: "feature",
      priority: 1,
      assignee: "mcFixes2",
    }),
  },
];

const validations: ValidationSummary[] = [
  {
    id: "v-186aaa",
    title: "Validate 186-tachyon-vscode-extension",
    type: "sdd",
    status: "triaged",
    executor: "agent",
    priority: 2,
    assignee: "codex",
    rounds: [],
    author: "human",
    createdAt: "2026-07-03T18:10:00.000Z",
    updatedAt: now,
  },
  {
    id: "v-205bbb",
    title: "Validate 205-tachyon-init",
    type: "sdd",
    status: "pending",
    executor: "human",
    rounds: [],
    author: "human",
    createdAt: "2026-07-03T18:20:00.000Z",
    updatedAt: now,
  },
];

const candidates: ValidationCandidate[] = [
  {
    title: "Validate 209-tachyon-agent-resume",
    type: "sdd",
    executor: "either",
    source_ref: { type: "spec", ref: "209" },
    excerpt: "Spec has shipped and needs validation proof.",
  },
];

const snapshot: BoardSnapshot = {
  views,
  allowedDropStatuses: Object.fromEntries(views.map((v) => [v.task.id, ["triaged", "active", "done", "dropped"]])),
  chips: [
    { agent: "claude", source: "declared", next: { task: views[2].task, attention: views[2].attention } },
    { agent: "codex", source: "declared", next: { task: views[3].task, derived: views[3].derived } },
    { agent: "human", source: "human", next: { empty: true, reason: "all-assigned-elsewhere" } },
    { agent: "mcFixes2", source: "assignee", next: { empty: true, reason: "no-tasks" } },
  ],
  liveAgents: ["claude"],
  validations: {
    items: validations,
    pendingCount: 2,
    humanPendingCount: 1,
    agentPendingCount: 1,
    candidateCount: candidates.length,
    candidates,
  },
  attachmentCounts: { "t-a11f0e": 2 },
};

export const missionControlFixtures: Record<string, Fixture<MissionControlVM>> = {
  default: {
    provenance: "synthetic-edge",
    vm: {
      folder: "tachyon",
      wsHash: "a1b2c3",
      workspaces: [{ hash: "a1b2c3", folder: "tachyon" }],
      snapshot,
    },
  },
};
