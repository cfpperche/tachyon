/**
 * spec 342 dogfood round 2 (#4) / spec 350 T3 — Task Studio fixtures for the dev preview harness, migrated
 * onto the studio shell's protocol (`load`/`error`/`restore` envelopes) the same way pipeline-studio's
 * fixtures were (see fixtures/pipeline-studio.ts). `default`/`new` are the pre-migration scenarios kept
 * byte-equivalent; `conflict` is new — the CAS precondition-failed banner (T4's shell-level proof).
 */

import type { TaskDetailEntity } from "@tachyon/webview-ui/webview/task-studio/domain";
import type { Fixture, Route } from "../routes";

const STUDIO_PROTOCOL_VERSION = 1;

function envelope<T extends { type: string }>(message: T) {
  return { ...message, studioProtocolVersion: STUDIO_PROTOCOL_VERSION };
}

interface TaskStudioFixtureVM {
  entity: TaskDetailEntity;
  loadError?: { code: string; message: string };
  conflict?: string;
}

export function taskStudioMakeMessage(vm: TaskStudioFixtureVM): unknown[] {
  if (vm.loadError) {
    return [envelope({ type: "error", code: vm.loadError.code, message: vm.loadError.message, blocking: true })];
  }
  const messages: unknown[] = [
    envelope({ type: "load", entity: vm.entity, concurrency: { kind: "cas", expected: vm.entity.expectUpdatedAt }, saveInFlight: false }),
  ];
  if (vm.conflict) messages.push(envelope({ type: "error", code: "task/precondition-failed", message: vm.conflict, blocking: true }));
  return messages;
}

const editTask: TaskDetailEntity = {
  workspaceHash: "a1b2c3",
  folder: "tachyon",
  taskId: "t-4f2c91",
  title: "Fix KitSelect width parity on the Task Studio fields row",
  kind: "bug",
  priority: 1,
  assignee: "claude",
  deps: [
    { id: "t-1a2b3c", title: "Vendor shadcn/Radix components behind a Kit namespace with a legacy fallback", missing: false },
    { id: "t-9f8e7d", title: "Ship the compat gate", missing: false },
  ],
  // t-dd22e8 — long screenshot path + multiple relation chips (preview / visual QA).
  artifact_refs: [
    { type: "screenshot", ref: "/mnt/c/Users/cfpp/Pictures/Screenshots/Screenshot 2026-07-12 210316.png" },
    { type: "relation", ref: "t-f87651" },
    { type: "relation", ref: "docs/specs/370-runtime-launch-preflight" },
  ],
  doc: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Priority KitSelect rendered content-width next to the flexible-width Kind/Assignee inputs." }] },
    ],
  },
  attachments: [],
  anchor: "load",
  expectUpdatedAt: "2026-07-03T00:00:00.000Z",
  knownAgents: ["claude", "codex"],
};

const newTask: TaskDetailEntity = {
  workspaceHash: "a1b2c3",
  folder: "tachyon",
  taskId: "t-000001",
  title: "",
  deps: [],
  artifact_refs: [],
  doc: { type: "doc", content: [{ type: "paragraph" }] },
  attachments: [],
  anchor: "load",
  knownAgents: ["claude", "codex"],
};

export const taskStudioFixtures: Record<string, Fixture<TaskStudioFixtureVM>> = {
  default: { provenance: "synthetic-edge", vm: { entity: editTask } },
  new: { provenance: "synthetic-edge", vm: { entity: newTask } },
  conflict: { provenance: "synthetic-edge", vm: { entity: editTask, conflict: "precondition-failed: updatedAt did not match" } },
  // t-610705 (Phase D, D2) — the cockpit route's generic studio-fixture dispatch (routes.ts's
  // byStudio table) always requests "dense-edit" for a studio-edit route, same key every other
  // migrated studio's fixtures module provides — task is edit-only in practice (studio-new is
  // rejected for "task"), so this is just an alias of `default`.
  "dense-edit": { provenance: "synthetic-edge", vm: { entity: editTask } },
};

export type { TaskStudioFixtureVM };
export type TaskStudioRoute = Route<TaskStudioFixtureVM>;
