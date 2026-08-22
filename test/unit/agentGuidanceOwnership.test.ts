import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderPrimer, type PrimerInput } from "@tachyon/engine/agents/primer.js";
import { renderSessionWorkRecord, type SessionWorkRecord } from "@tachyon/engine/agents/sessionWorkRecord.js";
import { AGENT_GUIDANCE_KEYS, DEFAULT_AGENT_GUIDANCE, resolveAgentGuidance } from "@tachyon/engine/agents/agentGuidance.js";
import { parseConfig } from "@tachyon/engine/config/loadConfig.js";

/**
 * t-a1ee7e — the completion of t-486f43's boundary, in the direction it never reached.
 *
 * `projectGuidanceOwnership.test.ts` classifies every immune line of the PRIMER as a product fact.
 * It never covered the WORK ON RECORD, and that is where the orchestration model actually lived:
 * "Wait for an explicit assignment" and "Do not adopt work by scanning the board" imposed a push
 * dispatch model on every agent of every project, inside a document the primer declared the project
 * could not override. A workspace running a pull model — workers serving themselves from the queue,
 * the commonest worker shape there is — was contradicted by the product and had nowhere to say so.
 *
 * The guard here is the property itself: every line an agent reads is EITHER a fact about a Tachyon
 * mechanism, OR text this workspace can change.
 */

const TASK = { id: "t-000001", title: "a task", status: "active" as const };

/** Every shape whose rendering carries a working method. */
const RECORD_SHAPES: Array<{ label: string; record: (guidance?: Record<string, string>) => SessionWorkRecord }> = [
  {
    label: "worktree, nothing assigned",
    record: (guidance) => ({ launch: "spawn", isolation: { kind: "worktree", path: "/wt", branch: "b" }, assignment: { queue: [] }, guidance }),
  },
  {
    label: "shared checkout, nothing assigned",
    record: (guidance) => ({ launch: "spawn", isolation: { kind: "shared", cwd: "/ws" }, assignment: { queue: [] }, guidance }),
  },
  {
    label: "assigned with a queue behind it",
    record: (guidance) => ({
      launch: "restart",
      isolation: { kind: "shared", cwd: "/ws" },
      assignment: { current: TASK, queue: [{ id: "t-000002", title: "next", status: "active" }] },
      guidance,
    }),
  },
  {
    label: "nothing assigned but a delegation brief present",
    record: (guidance) => ({ launch: "spawn", isolation: { kind: "shared", cwd: "/ws" }, assignment: { queue: [] }, hasTaskBrief: true, guidance }),
  },
];

const PRIMER_SHAPES: Array<{ label: string; input: (guidance?: Record<string, string>) => PrimerInput }> = [
  { label: "declared agent", input: (guidance) => ({ agentName: "solo", guidance }) },
  { label: "delegated child", input: (guidance) => ({ agentName: "child", delegator: "coordinator", guidance }) },
];

/** A unique, recognizable value per guidance key — what an overriding workspace would put there. */
const SENTINELS = Object.fromEntries(AGENT_GUIDANCE_KEYS.map((key) => [key, `OVERRIDDEN-${key.toUpperCase()}`]));

function renderAll(guidance?: Record<string, string>): string[] {
  return [
    ...RECORD_SHAPES.map(({ record }) => renderSessionWorkRecord(record(guidance))),
    ...PRIMER_SHAPES.map(({ input }) => {
      const rendered = renderPrimer(input(guidance));
      return `${rendered.primer}\n${rendered.beforeFinishing}`;
    }),
  ];
}

describe("t-a1ee7e: orchestration is the workspace's, not the product's", () => {
  it("every default working method can be replaced by the workspace", () => {
    const overridden = renderAll(SENTINELS).join("\n");
    for (const key of AGENT_GUIDANCE_KEYS) {
      // The default text must be GONE — an override that only appends would leave the product's
      // model standing next to the workspace's, which is the defect this task closes.
      expect(overridden, `guidance.${key}: the product default survived an override`).not.toContain(DEFAULT_AGENT_GUIDANCE[key]);
      expect(overridden, `guidance.${key}: the override never reached a brief — a dead key excuses a future line by accident`).toContain(SENTINELS[key]);
    }
  });

  it("the retired push-dispatch model is not restated anywhere once overridden", () => {
    // Measured verbatim before the separation. A workspace running a pull model must not read these.
    const IMPOSED_BEFORE = [
      "Wait for an explicit assignment.",
      "Do not adopt work by scanning the board, the pins, or another agent's continuity.",
      "Finish or hand back the one above before starting any of these",
      "report it to your spawner and do not pick one",
      "cannot override either contract or protocol",
    ];
    const overridden = renderAll(SENTINELS).join("\n");
    for (const line of IMPOSED_BEFORE) expect(overridden).not.toContain(line);
  });

  it("configuring nothing reads exactly what the product shipped before the methods were released", () => {
    const shipped = renderAll(undefined).join("\n");
    expect(shipped).toContain("Wait for an explicit assignment.");
    expect(shipped).toContain("Do not adopt work by scanning the board, the pins, or another agent's continuity.");
    expect(shipped).toContain("Make every change here. Do not edit, commit to, or push the primary checkout from this session.");
    expect(shipped).toContain("Finish or hand back the one above before starting any of these.");
    expect(shipped).toContain("Report it to your spawner and do not pick one.");
    expect(shipped).toContain("summary: status + commit/tree + where the detail lives");
  });

  it("the WORK ON RECORD states facts about THIS session and no working method of its own", () => {
    // Every line of the record is either a fact (a measurement of the session, the checkout or the
    // board) or guidance-sourced. Anything else is a method born immune — the t-486f43 defect.
    const RECORD_FACT = [
      /^── SESSION (SPAWN|RESTART|RETASK): WORK ON RECORD ──$/,
      /^── END SESSION (SPAWN|RESTART|RETASK) ──$/,
      /^This session is NEW\./,
      /^This session was restarted with a NEW conversation\./,
      /^This live session was retasked WITHOUT restarting it\./,
      /^Checkout: separate git worktree /,
      /^Checkout: shared — /,
      /^No worktree or branch was recorded for you, so nothing here authorizes committing to the trunk\./,
      /^Assigned work on record: none\.$/,
      /^Execute the delegation brief above as delegated work\. It does not create or assign a board task\.$/,
      /^Your current task, read from the board at /,
      /^Also assigned to you and still active \(\d+\) — NOT your current task\./,
      /^- t-[0-9a-f]{6} — /,
    ];
    for (const { label, record } of RECORD_SHAPES) {
      for (const line of renderSessionWorkRecord(record(SENTINELS)).split("\n").filter((l) => l.trim())) {
        const isFact = RECORD_FACT.some((fact) => fact.test(line));
        const isGuidance = Object.values(SENTINELS).some((sentinel) => line.includes(sentinel));
        expect(
          isFact || isGuidance,
          `${label}: this line is neither a classified fact about the session nor workspace-owned guidance:\n${line}`,
        ).toBe(true);
      }
    }
  });

  it("every primer an agent can receive is assembled through the one seam that carries guidance", () => {
    // The gap this closes was measured on 2026-08-22, right after the feature landed: the opt-in
    // resume re-orientation built its own PrimerInput and omitted `guidance`, so that one path
    // would paste the product's methods into a workspace that had replaced them. Every field of
    // PrimerInput is optional, so nothing failed — the brief was simply wrong. The seam is the fix;
    // this is the guard that keeps a third call site from re-opening it.
    const source = fs.readFileSync(
      path.join(process.cwd(), "packages/engine/src/agents/AgentManager.ts"),
      "utf8",
    );
    const assembles = source.match(/(?:renderPrimer|wrapWithPrimer)\(/g) ?? [];
    expect(assembles.length, "AgentManager renders a primer somewhere").toBeGreaterThan(0);
    // No call site may pass an object literal: the seam is the only assembler.
    expect(source).not.toMatch(/(?:renderPrimer|wrapWithPrimer)\([^)]*\{\s*$/m);
    expect(source).not.toMatch(/(?:renderPrimer|wrapWithPrimer)\(\s*\{/);
    for (const _ of assembles) expect(source).toContain("this.primerInputFor(");
  });

  it("the workspace configures the methods through settings.agentGuidance", () => {
    const parsed = parseConfig("settings:\n  agentGuidance:\n    dispatch: Take the top unassigned task yourself.\n");
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.settings.agentGuidance?.dispatch).toBe("Take the top unassigned task yourself.");
    // one override changes one method and leaves the rest at the product default
    const resolved = resolveAgentGuidance(parsed.config?.settings.agentGuidance);
    expect(resolved.dispatch).toBe("Take the top unassigned task yourself.");
    expect(resolved.conflict).toBe(DEFAULT_AGENT_GUIDANCE.conflict);

    const bad = parseConfig("settings:\n  agentGuidance:\n    bogus: x\n    dispatch: ''\n");
    expect(bad.discarded.some((d) => d.includes("unknown key 'bogus'"))).toBe(true);
    expect(bad.discarded.some((d) => d.includes("agentGuidance.dispatch"))).toBe(true);
  });
});
