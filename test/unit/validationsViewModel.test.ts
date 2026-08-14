import { describe, expect, it } from "vitest";
import type { Validation } from "@tachyon/engine/validations/types.js";
import { buildValidationsViewModel } from "../../apps/vscode-extension/src/webview/validations/viewModel.js";

const validation = (overrides: Partial<Validation>): Validation => ({
  id: "v-000001",
  title: "Installed extension dogfood",
  status: "pending",
  executor: "either",
  rounds: [],
  author: "human",
  createdAt: "2026-07-18T10:00:00.000Z",
  updatedAt: "2026-07-18T10:00:00.000Z",
  ...overrides,
});

describe("buildValidationsViewModel", () => {
  it("projects full detail independently of Mission board summaries", () => {
    const vm = buildValidationsViewModel({
      folder: "tachyon",
      wsHash: "abc",
      validations: [validation({
        type: "dogfood",
        priority: 1,
        assignee: "codex",
        instructions: "Install the VSIX and inspect Control.",
        source_refs: [{ type: "task", ref: "t-da934e" }],
        rounds: [{ n: 1, outcome: "failed", result_note: "Old build", evidence_refs: [{ type: "commit", ref: "abc1234" }] }],
      })],
    });
    expect(vm.types).toEqual(["dogfood"]);
    expect(vm.validations[0]).toMatchObject({
      id: "v-000001",
      instructions: "Install the VSIX and inspect Control.",
      sourceRefs: [{ type: "task", ref: "t-da934e" }],
      rounds: [{ n: 1, outcome: "failed", resultNote: "Old build", evidenceRefs: [{ type: "commit", ref: "abc1234" }] }],
    });
  });

  it("orders open work before closed history, then by priority", () => {
    const vm = buildValidationsViewModel({ folder: "x", wsHash: "y", validations: [
      validation({ id: "v-000002", status: "closed", priority: 0 }),
      validation({ id: "v-000003", priority: 3 }),
      validation({ id: "v-000001", priority: 1 }),
    ] });
    expect(vm.validations.map((item) => item.id)).toEqual(["v-000001", "v-000003", "v-000002"]);
  });
});
