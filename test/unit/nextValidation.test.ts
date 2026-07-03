import { describe, expect, it } from "vitest";
import type { Validation } from "../../src/validations/types.js";
import { nextValidation } from "../../src/validations/nextValidation.js";

const validation = (id: string, over: Partial<Validation> = {}): Validation => ({
  id,
  title: id,
  status: "triaged",
  executor: "either",
  rounds: [],
  author: "human",
  createdAt: `2026-07-03T00:00:0${id.slice(-1)}Z`,
  updatedAt: `2026-07-03T00:00:0${id.slice(-1)}Z`,
  ...over,
});

describe("nextValidation", () => {
  it("does not hand human-only validations to agents", () => {
    expect(nextValidation({ agent: "codex", validations: [validation("v-000001", { executor: "human", assignee: "human" })] })).toEqual({ empty: true, reason: "all-human-only" });
    expect(nextValidation({ agent: "human", validations: [validation("v-000001", { executor: "human", assignee: "human" })] })).toMatchObject({ validation: { id: "v-000001" } });
  });

  it("does not surface untriaged pending validations as next work", () => {
    expect(nextValidation({ agent: "codex", validations: [validation("v-000001", { status: "pending", executor: "agent" })] })).toEqual({ empty: true, reason: "no-validations" });
  });

  it("orders by priority then age and respects assignee", () => {
    const result = nextValidation({
      agent: "codex",
      validations: [
        validation("v-000003", { priority: 2 }),
        validation("v-000001", { priority: 1, assignee: "other" }),
        validation("v-000002", { priority: 1 }),
      ],
    });
    expect(result).toMatchObject({ validation: { id: "v-000002" } });
  });
});
