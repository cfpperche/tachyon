/**
 * spec 346 — Board fixture for the dev preview harness. Provenance: synthetic-edge, typed against
 * the real BoardVM. It covers the validations strip, all always-on board columns, a dropped card,
 * agent chips, priorities, assignees, SDD badges, attention, and attachment count.
 */

import type { BoardVM } from "@tachyon/webview-ui/webview/board/messages";
import type { BoardSnapshot } from "@tachyon/engine/tasks/boardSnapshot.js";
import type { Task, TaskView } from "@tachyon/shared/tasks/types";
import type { ValidationSummary } from "@tachyon/engine/validations/ValidationStore.js";
import type { ValidationCandidate } from "@tachyon/engine/validations/types.js";
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
      author: "grok",
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
      currentAssignee: "claude",
    }),
    attention: [{ code: "awaiting_human", message: "Needs maintainer verification before close" }],
  },
  {
    task: task("t-9a41b2", "triaged", "Board v1.1: reorder in-column mantendo rank", {
      kind: "feature",
      author: "codex",
      assignee: "codex",
      currentAssignee: "codex",
      artifact_refs: [{ type: "sdd", ref: "shipped-partial" }],
    }),
  },
  {
    task: task("t-a11f0e", "active", "Spec: Task Studio form completo de criacao/edicao de tasks", {
      kind: "feature",
      author: "claude",
      priority: 1,
      assignee: "claude",
      currentAssignee: "claude",
      artifact_refs: [{ type: "sdd", ref: "335" }],
    }),
    derived: { sdd: { type: "sdd", ref: "335", status: "in-progress" } },
  },
  {
    task: task("t-82f870", "landed", "Board: separar trabalho landed do que ainda esta em voo", {
      kind: "feature",
      author: "author-with-a-deliberately-long-name",
      priority: 2,
      lastDeliverer: "assignee-with-a-deliberately-long-name",
      artifact_refs: [{ type: "sdd", ref: "335" }],
    }),
    derived: { sdd: { type: "sdd", ref: "335", status: "in-progress" } },
  },
  {
    task: task("t-c04b3e", "done", "Design system: componentizar elementos de formulario repetitivos", {
      kind: "feature",
      priority: 2,
      lastDeliverer: "claude",
    }),
  },
  {
    task: task("t-c0e711", "dropped", "Board: context menu no card para mover para Dropped", {
      kind: "feature",
      priority: 1,
      lastDeliverer: "mcFixes2",
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
  allowedDropStatuses: Object.fromEntries(views.map((v) => [v.task.id, ["triaged", "active", "landed", "done", "dropped"]])),
  chips: [
    { agent: "claude", source: "declared", next: { task: views[2].task, attention: views[2].attention } },
    { agent: "codex", source: "declared", next: { task: views[3].task, derived: views[3].derived } },
    { agent: "human", source: "human", next: { empty: true, reason: "all-assigned-elsewhere" } },
    { agent: "mcFixes2", source: "assignee", next: { empty: true, reason: "no-tasks" } },
  ],
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

/**
 * t-32c872 — the VOLUME fixture, and the reason it exists is a defect the `default` fixture above could not
 * show. Eight cards spread over six statuses fit inside any frame, so the Board looked right standalone even
 * though its per-column scrolling was gone: nothing was tall enough to need a scroll region, so nothing
 * revealed that the region had no height to scroll inside.
 *
 * The shape is the owner's own board on the day the bug was reported (0.56.164): INBOX 99 / TRIAGED 11 /
 * ACTIVE 0 / LANDED 76. ACTIVE stays EMPTY on purpose — an empty column beside two tall ones is where the
 * chain breaks visibly (a column that collapses to its content instead of filling the board's height), and
 * a fixture where every column is full would hide it.
 */
function bulk(prefix: string, status: Task["status"], count: number, title: (i: number) => string): TaskView[] {
  return Array.from({ length: count }, (_, i) => ({
    task: task(`t-${prefix}${String(i).padStart(4, "0")}`, status, title(i), {
      kind: i % 3 === 0 ? "bug" : "feature",
      ...(i % 4 === 0 ? { priority: (i % 3) as 0 | 1 | 2 } : {}),
      ...(i % 5 === 0 ? { assignee: ["claude", "codex", "grok"][i % 3] } : {}),
      author: i % 2 === 0 ? "human" : "claude",
    }),
  }));
}

const volumeViews: TaskView[] = [
  ...bulk("i", "inbox", 99, (i) => `Inbox item ${i + 1}: triage this report and decide whether it is a task`),
  ...bulk("t", "triaged", 11, (i) => `Triaged ${i + 1}: scoped and waiting for an agent`),
  ...bulk("l", "landed", 76, (i) => `Landed ${i + 1}: shipped and contained in main`),
];

const volumeSnapshot: BoardSnapshot = {
  views: volumeViews,
  allowedDropStatuses: Object.fromEntries(volumeViews.map((v) => [v.task.id, ["triaged", "active", "landed", "done", "dropped"]])),
  chips: [
    { agent: "claude", source: "declared", next: { task: volumeViews[1]!.task } },
    { agent: "codex", source: "declared", next: { empty: true, reason: "no-tasks" } },
    { agent: "human", source: "human", next: { empty: true, reason: "all-assigned-elsewhere" } },
  ],
  validations: { items: [], pendingCount: 0, humanPendingCount: 0, agentPendingCount: 0, candidateCount: 0, candidates: [] },
  attachmentCounts: {},
};

export const boardFixtures: Record<string, Fixture<BoardVM>> = {
  default: {
    provenance: "synthetic-edge",
    vm: {
      folder: "tachyon",
      wsHash: "a1b2c3",
      snapshot,
    },
  },
  volume: {
    provenance: "synthetic-edge",
    vm: {
      folder: "tachyon",
      wsHash: "a1b2c3",
      snapshot: volumeSnapshot,
    },
  },
};
