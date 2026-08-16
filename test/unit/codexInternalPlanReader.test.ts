import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_INTERNAL_PLAN_NOTIFICATION,
  readCodexInternalPlan,
} from "@tachyon/engine/runtime/codexInternalPlanReader.js";

/**
 * t-1ee107 — the production Codex plan reader, driven by the `turn/plan/updated`
 * notification a real authenticated session emitted (PoC 2026-08-16,
 * docs/research/poc-plano-interno-codex.md).
 *
 * These tests import `readCodexInternalPlan` — the host door. A helper-only
 * parser that the host never calls will not satisfy them. Disconnecting the
 * reader (always mute, or a canned projection that does not read the
 * notification) turns the suite red.
 */

const FIXTURE_DIR = path.resolve("test/fixtures/codex-internal-plan");
const MEASURED_PLAN = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "turn-plan-updated.json"), "utf8"),
) as unknown;
const TURN_COMPLETED = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "turn-completed.json"), "utf8"),
) as unknown;
const PLAN_DELTA = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "item-plan-delta.json"), "utf8"),
) as unknown;

describe("t-1ee107 — readCodexInternalPlan (production door)", () => {
  it("projects the measured authenticated turn/plan/updated without inventing an id", () => {
    const plan = readCodexInternalPlan({ notifications: [MEASURED_PLAN] });
    expect(plan).toEqual({
      state: "snapshot",
      items: [
        { texto: "Boil water", status: "pending" },
        { texto: "Steep the tea", status: "pending" },
        { texto: "Serve the tea", status: "pending" },
      ],
    });
    if (plan.state === "snapshot") {
      for (const item of plan.items) {
        expect(item).not.toHaveProperty("id");
        expect(item).not.toHaveProperty("blockedBy");
      }
    }
  });

  it("is mute when the channel never spoke", () => {
    expect(readCodexInternalPlan({ notifications: [] })).toEqual({ state: "mute" });
    expect(readCodexInternalPlan({ notifications: [{ method: "turn/started", params: {} }] })).toEqual({
      state: "mute",
    });
  });

  it("does not treat item/plan/delta as a plan", () => {
    expect(readCodexInternalPlan({ notifications: [PLAN_DELTA] })).toEqual({ state: "mute" });
    expect(readCodexInternalPlan({ notifications: [PLAN_DELTA, TURN_COMPLETED] })).toEqual({
      state: "mute",
    });
  });

  it("does not treat turn.completed.items as a plan snapshot", () => {
    expect(readCodexInternalPlan({ notifications: [TURN_COMPLETED] })).toEqual({ state: "mute" });
  });

  it("maps schema camelCase inProgress and keeps last turn/plan/updated", () => {
    const later = {
      method: CODEX_INTERNAL_PLAN_NOTIFICATION,
      params: {
        threadId: "t",
        turnId: "u",
        explanation: null,
        plan: [
          { step: "Boil water", status: "completed" },
          { step: "Steep the tea", status: "inProgress" },
          { step: "Serve the tea", status: "pending" },
        ],
      },
    };
    expect(readCodexInternalPlan({ notifications: [MEASURED_PLAN, later] })).toEqual({
      state: "snapshot",
      items: [
        { texto: "Boil water", status: "completed" },
        { texto: "Steep the tea", status: "in-progress" },
        { texto: "Serve the tea", status: "pending" },
      ],
    });
  });

  it("omits a rogue id field on the step — Codex has no per-step identity", () => {
    const notification = {
      method: CODEX_INTERNAL_PLAN_NOTIFICATION,
      params: {
        threadId: "t",
        turnId: "u",
        explanation: null,
        plan: [{ step: "only step", status: "pending", id: "forged" }],
      },
    };
    expect(readCodexInternalPlan({ notifications: [notification] })).toEqual({
      state: "snapshot",
      items: [{ texto: "only step", status: "pending" }],
    });
  });

  it("fails if the reader does not read the notification (red proof)", () => {
    const canary = {
      method: CODEX_INTERNAL_PLAN_NOTIFICATION,
      params: {
        threadId: "red-proof-thread",
        turnId: "red-proof-turn",
        explanation: null,
        plan: [{ step: "CANARY_PLAN_READ", status: "completed" }],
      },
    };
    expect(readCodexInternalPlan({ notifications: [canary] })).toEqual({
      state: "snapshot",
      items: [{ texto: "CANARY_PLAN_READ", status: "completed" }],
    });
  });

  it("this suite calls the production reader, not a test-local stand-in", () => {
    const source = fs.readFileSync(path.resolve("test/unit/codexInternalPlanReader.test.ts"), "utf8");
    expect(source).toMatch(/from "@tachyon\/engine\/runtime\/codexInternalPlanReader\.js"/);
    expect(source).toMatch(/readCodexInternalPlan\(/);
    expect(source).not.toMatch(/function readCodexInternalPlan\(/);
  });
});
