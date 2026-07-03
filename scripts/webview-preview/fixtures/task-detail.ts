/**
 * spec 342 dogfood round 2 (#4) — Task Detail fixtures for the dev preview harness. Provenance:
 * `synthetic-edge` — typed against the real TaskDetailVM. `default` covers the round 2 (#3) header-actions
 * move (Open in Studio / Refresh now render in `.td-head`, not floating at the page bottom).
 */

import type { TaskDetailVM } from "../../../src/webview/task-detail/messages";
import type { Fixture } from "../routes";

const detailTask: TaskDetailVM = {
  wsHash: "a1b2c3",
  id: "t-4f2c91",
  tombstone: false,
  task: {
    id: "t-4f2c91",
    title: "Fix KitSelect width parity on the Task Studio fields row",
    body: "Priority KitSelect rendered content-width next to the flexible-width Kind/Assignee inputs.",
    status: "active",
    priority: 1,
    kind: "bug",
    author: "claude",
    assignee: "codex",
    artifact_refs: [{ type: "spec", ref: "342" }],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
  },
  deps: [{ id: "t-1a2b3c", title: "Vendor shadcn/Radix components", status: "done", missing: false }],
};

export const taskDetailFixtures: Record<string, Fixture<TaskDetailVM>> = {
  default: { provenance: "synthetic-edge", vm: detailTask },
};
