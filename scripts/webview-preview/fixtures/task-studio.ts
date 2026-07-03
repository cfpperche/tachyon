/**
 * spec 342 dogfood round 2 (#4) — Task Studio fixtures for the dev preview harness. Provenance:
 * `synthetic-edge` — typed against the real TaskStudioVM. `default` carries a long-titled dependency so the
 * fields row + deps chip truncation (round 2 #1/#2) are both visible to the reviewer's pre-human visual pass,
 * not just the isolated browser assertions.
 */

import type { TaskStudioVM } from "../../../src/webview/task-studio/types";
import type { Fixture } from "../routes";

const assets = {
  excalidrawScriptUri: "/dist/webview/excalidraw.js",
  excalidrawCssUri: "/dist/webview/excalidraw.css",
  excalidrawAssetPath: "/dist/webview/",
};

const editTask: TaskStudioVM = {
  workspaceHash: "a1b2c3",
  folder: "tachyon",
  mode: "edit",
  taskId: "t-4f2c91",
  title: "Fix KitSelect width parity on the Task Studio fields row",
  kind: "bug",
  priority: 1,
  assignee: "claude",
  deps: [
    { id: "t-1a2b3c", title: "Vendor shadcn/Radix components behind a Kit namespace with a legacy fallback", missing: false },
    { id: "t-9f8e7d", title: "Ship the compat gate", missing: false },
  ],
  artifact_refs: [{ type: "spec", ref: "342" }],
  doc: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Priority KitSelect rendered content-width next to the flexible-width Kind/Assignee inputs." }] },
    ],
  },
  attachments: [],
  assets,
  anchor: "load",
  expectUpdatedAt: "2026-07-03T00:00:00.000Z",
  knownAgents: ["claude", "codex"],
};

const newTask: TaskStudioVM = {
  workspaceHash: "a1b2c3",
  folder: "tachyon",
  mode: "new",
  taskId: "t-000001",
  title: "",
  deps: [],
  artifact_refs: [],
  doc: { type: "doc", content: [{ type: "paragraph" }] },
  attachments: [],
  assets,
  anchor: "load",
  knownAgents: ["claude", "codex"],
};

export const taskStudioFixtures: Record<string, Fixture<TaskStudioVM>> = {
  default: { provenance: "synthetic-edge", vm: editTask },
  new: { provenance: "synthetic-edge", vm: newTask },
};
