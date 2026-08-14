import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FleetVM } from "@tachyon/shared/sidebar/types.js";
import { toPluginProjectionV1 } from "../../apps/vscode-extension/src/plugins/ui/projectionBuilder.js";
import { PLUGIN_FLEET_PROJECTION, pluginFleetProjectionMessage, readyMessage } from "@tachyon/webview-ui/plugins/ui/messages";
import { PluginFleetProjectionProvider, PluginProjectionSession } from "../../apps/vscode-extension/src/plugins/ui/projectionProvider.js";

describe("plugin fleet projection", () => {
  it("builds a versioned, pseudonymous projection with handles, coarse statuses, badges, and counts", () => {
    const projection = toPluginProjectionV1(sampleFleet(), 7, (target, generation) => `h-${generation}-${target.agentIndex}`, (target) => `Unit ${target.agentIndex + 1}`);

    expect(projection).toEqual({
      v: 1,
      generation: 7,
      agents: [
        {
          handle: "h-7-0",
          label: "Unit 1",
          status: "running",
          attention: "working",
          badges: ["continuity-fresh", "persistence-active", "evidence-warn"],
        },
        {
          handle: "h-7-1",
          label: "Unit 2",
          status: "needs",
          attention: "needs-input",
          badges: ["continuity-stale", "persistence-failed", "evidence-error", "resumable", "fresh-start"],
        },
      ],
      counts: { agents: 2, running: 1, needs: 1, throttled: 0, idle: 0, done: 0, stopped: 0, crashed: 0 },
    });
  });

  it("does not serialize poisoned FleetVM sentinel values from sensitive fields", () => {
    const sentinel = "SENTINEL_DO_NOT_LEAK";
    const projection = toPluginProjectionV1(poisonedFleet(sentinel), 42, (target, generation) => `opaque-${generation}-${target.agentIndex}`);
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("raw-secret-agent");
    expect(serialized).not.toContain("raw-secret-workspace");
    expect(projection.agents).toHaveLength(1);
    expect(projection.agents[0]).toMatchObject({ handle: "opaque-42-0", label: "Agent 1-1", status: "running" });
  });

  it("keeps the envelope constructor and ready handshake in one pure contract", () => {
    const projection = toPluginProjectionV1(sampleFleet(), 1, (target) => `h-${target.agentIndex}`);

    expect(pluginFleetProjectionMessage(projection)).toEqual({ type: PLUGIN_FLEET_PROJECTION, projection });
    expect(readyMessage()).toEqual({ type: "ready" });
  });

  it("bumps generation on fleet refresh and republishes the last projection on ready", () => {
    const posted: unknown[] = [];
    const session = new PluginProjectionSession();
    const provider = new PluginFleetProjectionProvider(
      { postMessage: (message) => { posted.push(message); return true; } },
      (target, generation) => `h-${generation}-${target.agentIndex}`,
      session.labelFor.bind(session),
    );

    const first = provider.refresh(sampleFleet());
    const second = provider.refresh(sampleFleet({ status: "idle" }));
    provider.handleMessage({ type: "ready" });

    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(second.agents[0]?.label).toBe(first.agents[0]?.label);
    expect(posted.map((m) => (m as { projection: { generation: number } }).projection.generation)).toEqual([1, 2, 2]);
  });

  it("keeps the projection type module detached from FleetVM and vscode imports", async () => {
    const source = await readFile(path.join(process.cwd(), "packages/webview-ui/src/plugins/ui/projectionTypes.ts"), "utf8");

    expect(source).not.toMatch(/\bFleetVM\b/);
    expect(source).not.toMatch(/from ["']vscode["']/);
  });
});

function sampleFleet(overrides: Partial<FleetVM["agents"][number]> = {}): FleetVM {
  return {
    folder: { hash: "raw-secret-workspace", name: "Demo" },
    bridge: { port: "42551", connected: true },
    agents: [
      {
        kind: "agent",
        name: "raw-secret-agent",
        status: "running",
        attention: "working",
        continuity: "fresh",
        persistenceHooks: { state: "active" },
        evidence: { total: 1, stale: 1, warn: 1, error: 0 },
        ...overrides,
      },
      {
        kind: "agent",
        name: "needs-help",
        status: "needs",
        attention: "needs input",
        continuity: "stale",
        persistenceHooks: { state: "failed" },
        evidence: { total: 1, stale: 0, warn: 0, error: 1 },
        resumable: true,
        freshStart: true,
      },
    ],
    terminals: [],
    pipelines: [],
    schedules: [],
    commands: [],
    runbooks: [],
    pins: [],
  };
}

function poisonedFleet(sentinel: string): FleetVM {
  return {
    folder: { hash: `${sentinel}:folder.hash`, name: `${sentinel}:folder.name` },
    bridge: { port: `${sentinel}:bridge.port`, connected: true },
    agents: [
      {
        kind: "agent",
        name: `${sentinel}:name`,
        status: "stopping",
        attention: `${sentinel}:attention`,
        parent: `${sentinel}:parent`,
        sub: `${sentinel}:sub`,
        worktree: `${sentinel}:worktree`,
        persistenceHooks: { state: "skipped", reason: `${sentinel}:hook.reason`, path: `${sentinel}:hook.path`, updatedAt: `${sentinel}:hook.updatedAt` },
      },
    ],
    proposals: [{ id: `${sentinel}:proposal.id`, name: `${sentinel}:proposal.name`, by: `${sentinel}:proposal.by`, reason: `${sentinel}:proposal.reason`, when: `${sentinel}:proposal.when` }],
    terminals: [{ kind: "terminal", name: `${sentinel}:terminal.name`, status: "running", sub: `${sentinel}:terminal.sub` }],
    pipelines: [],
    schedules: [],
    commands: [{ name: `${sentinel}:command.name`, cmd: `${sentinel}:command.cmd`, state: "running", detail: `${sentinel}:command.detail` }],
    runbooks: [{ name: `${sentinel}:runbook.name`, running: false, failed: false, detail: `${sentinel}:runbook.detail`, steps: [{ n: 1, label: `${sentinel}:runbook.step`, state: "passed", detail: `${sentinel}:runbook.step.detail` }] }],
    pins: [{ id: `${sentinel}:pin.id`, text: `${sentinel}:pin.text`, done: false, by: `${sentinel}:pin.by`, tags: [`${sentinel}:pin.tag`], detail: true, attachmentCount: 1 }],
    handoff: { exists: true, staleness: "needs_distill", pendingCount: 1 },
  };
}
