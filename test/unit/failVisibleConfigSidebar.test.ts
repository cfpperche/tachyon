/**
 * t-8354ae acceptance (a): sidebar view-model contains configError banner payload
 * AND ledger-derived rows — never an empty-roster-only signal when config is invalid.
 */
import { describe, expect, it } from "vitest";
import { degradedRosterExtras, toConfigErrorVM } from "../../src/config/configFailure.js";
import { toAgentVM } from "../../src/sidebar/agentModel.js";
import type { AgentVM, FleetVM } from "../../src/sidebar/types.js";
import type { SessionRecord } from "../../src/resume/SessionLedger.js";

function buildDegradedFleet(opts: {
  failure: { path: string; file: string; errors: string[]; at: string };
  ledger: Array<[string, SessionRecord]>;
  lkgAgents?: Array<{ name: string; kind: "agent" | "terminal"; cmd?: string }>;
  live?: AgentVM[];
}): FleetVM {
  const existing = new Set((opts.live ?? []).map((a) => a.name));
  const extras = degradedRosterExtras({
    existingNames: existing,
    ledger: opts.ledger,
    lkg: opts.lkgAgents
      ? {
          schemaVersion: 1,
          savedAt: "2026-07-10T15:00:00.000Z",
          sourceFile: opts.failure.file,
          agents: opts.lkgAgents,
        }
      : null,
  });
  const agents: AgentVM[] = [...(opts.live ?? [])];
  for (const e of extras) {
    if (e.kind !== "agent") continue;
    agents.push(
      toAgentVM(
        {
          name: e.name,
          cmd: e.cmd,
          running: false,
          dead: false,
          crashed: false,
          parent: e.parent,
          declaredOwner: e.declaredOwner,
        },
        {
          kind: "agent",
          adhoc: e.lifetime === "temporary",
          resumable: e.resumable,
          configInvalid: true,
        },
      ),
    );
  }
  return {
    bridge: { port: "—", connected: false },
    agents,
    terminals: [],
    pipelines: [],
    schedules: [],
    commands: [],
    runbooks: [],
    pins: [],
    configError: toConfigErrorVM(opts.failure),
  };
}

describe("fail-visible sidebar view-model", () => {
  it("includes configError + ledger rows; empty placeholder is not the only signal", () => {
    const fleet = buildDegradedFleet({
      failure: {
        path: "/ws/tachyon.yml",
        file: "tachyon.yml",
        errors: ["'reviewer' is not declared in agents/terminals"],
        at: "2026-07-10T16:09:00.000Z",
      },
      ledger: [
        [
          "codex",
          {
            cwd: "/ws",
            instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true },
            updatedAt: "2026-07-10T15:00:00.000Z",
            resume: { runtime: "codex", sessionId: "sess-1" },
          },
        ],
      ],
      lkgAgents: [
        { name: "codex", kind: "agent", cmd: "codex" },
        { name: "reviewer", kind: "agent", cmd: "claude" },
      ],
    });

    expect(fleet.configError).toBeDefined();
    expect(fleet.configError!.file).toBe("tachyon.yml");
    expect(fleet.configError!.summary).toContain("reviewer");
    expect(fleet.agents.map((a) => a.name).sort()).toEqual(["codex", "reviewer"]);
    expect(fleet.agents.every((a) => a.configInvalid)).toBe(true);
    expect(fleet.agents.find((a) => a.name === "codex")?.resumable).toBe(true);
    // acceptance: never empty-roster-only while config file failed with known agents
    expect(fleet.agents.length).toBeGreaterThan(0);
    expect(fleet.configError).toBeTruthy();
  });
});
