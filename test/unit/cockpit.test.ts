import { describe, expect, it } from "vitest";
import { buildCockpitModel, COCKPIT_SECTION_ORDER, formatCockpitDiagnostics } from "../../src/cockpit/model.js";

describe("cockpit model", () => {
  it("orders sections by ops frequency (no soon slots)", () => {
    expect(COCKPIT_SECTION_ORDER[0]).toBe("overview");
    expect(COCKPIT_SECTION_ORDER[1]).toBe("engine");
    expect(COCKPIT_SECTION_ORDER[2]).toBe("fleet");
    expect(COCKPIT_SECTION_ORDER).toContain("approvals");
    expect(COCKPIT_SECTION_ORDER).toContain("mission");
    expect(COCKPIT_SECTION_ORDER).toContain("validations");
    expect(COCKPIT_SECTION_ORDER.indexOf("validations")).toBeGreaterThan(COCKPIT_SECTION_ORDER.indexOf("mission"));
    expect(COCKPIT_SECTION_ORDER).toContain("worktrees");
    expect(COCKPIT_SECTION_ORDER).toContain("deliveries");
    expect(COCKPIT_SECTION_ORDER).toContain("runtime");
    expect(COCKPIT_SECTION_ORDER).toContain("settings");
  });

  it("builds fleet/worktrees/deliveries overview counts", () => {
    const m = buildCockpitModel(
      [
        {
          control: {
            folderName: "tachyon",
            workspaceRoot: "/w",
            wsHash: "abc",
            bridgeUrl: "http://127.0.0.1:7421/mcp",
            identity: {
              pid: 1,
              instanceId: "i",
              processStartIdentity: "p",
              startedAt: "t",
              bundleId: "b",
              engineVersion: "0.1.0",
              bridge: { instanceId: "br", port: 7421 },
            },
            agents: { total: 2, running: 1 },
          },
          agents: [
            { name: "a", running: true },
            { name: "b", running: false },
          ],
          worktrees: [
            { id: "1", kind: "change", path: "/x", branch: "b", status: "active" },
            { id: "2", kind: "change", path: "/y", branch: "c", status: "abandoned" },
          ],
          deliveries: [
            { id: "d1", phase: "open", branchRef: "br" },
            { id: "d2", phase: "pruned", branchRef: "br2" },
          ],
          approvals: [{ id: "a1", status: "pending" }],
          tmux: { state: "healthy", version: "3.4" },
          companion: {
            tabTools: true,
            allowedHosts: [],
            paired: true,
            baseUrl: "http://127.0.0.1:7421",
            engineLabel: "tachyon",
            devices: [
              {
                id: "dev1",
                kind: "browser",
                name: "Tachyon Companion",
                version: "0.4.8",
                pairedAt: "2026-07-21T12:00:00.000Z",
                live: true,
              },
            ],
          },
        },
      ],
      { section: "overview", nowIso: "now" },
    );
    expect(m.overview.agentsRunning).toBe(1);
    expect(m.overview.worktreesActive).toBe(1);
    expect(m.overview.deliveriesOpen).toBe(1);
    expect(m.overview.approvalsPending).toBe(1);
    expect(m.fleet).toHaveLength(2);
    expect(m.tmux[0]?.state).toBe("healthy");
    expect(m.companion).toMatchObject({
      wsHash: "abc",
      folderName: "tachyon",
      tabTools: true,
      paired: true,
      baseUrl: "http://127.0.0.1:7421",
      engineLabel: "tachyon",
    });
    expect(m.companion?.devices).toHaveLength(1);
    expect(m.companion?.devices[0]?.name).toBe("Tachyon Companion");
    expect(m.companionNeedsWorkspacePick).toBeUndefined();
  });

  it("marks companion settings as needing a workspace pick when All is selected with multi roots", () => {
    const m = buildCockpitModel(
      [
        {
          control: { folderName: "a", workspaceRoot: "/a", wsHash: "h1", bridgeUrl: "http://127.0.0.1:1/mcp" },
          agents: [],
          worktrees: [],
          deliveries: [],
          approvals: [],
          companion: { tabTools: true, allowedHosts: [], paired: false, devices: [] },
        },
        {
          control: { folderName: "b", workspaceRoot: "/b", wsHash: "h2", bridgeUrl: "http://127.0.0.1:2/mcp" },
          agents: [],
          worktrees: [],
          deliveries: [],
          approvals: [],
          companion: { tabTools: false, allowedHosts: ["example.com"], paired: true, devices: [] },
        },
      ],
      { section: "settings", nowIso: "now" },
    );
    expect(m.companion).toBeUndefined();
    expect(m.companionNeedsWorkspacePick).toBe(true);
  });

  // t-d16a39 — shell-level workspace scope
  it("scopes aggregate sections to the selected workspace, keeps the full selector list", () => {
    const bundle = (hash: string, folder: string, agents: number) => ({
      control: {
        folderName: folder,
        workspaceRoot: `/${folder}`,
        wsHash: hash,
        bridgeUrl: "http://127.0.0.1:7421/mcp",
        agents: { total: agents, running: agents },
      },
      agents: Array.from({ length: agents }, (_, i) => ({ name: `a${i}`, running: true })),
      worktrees: [{ id: `${hash}-w`, kind: "change" as const, path: `/${folder}/x`, branch: "b", status: "active" as const }],
      deliveries: [{ id: `${hash}-d`, phase: "open", branchRef: "br" }],
      approvals: [{ id: `${hash}-a`, status: "pending" }],
      tmux: { state: "healthy" },
    });
    const bundles = [bundle("aaa", "alpha", 2), bundle("bbb", "beta", 3)];

    const scoped = buildCockpitModel(bundles, { section: "fleet", wsHash: "bbb", nowIso: "now" });
    expect(scoped.selectedWsHash).toBe("bbb");
    expect(scoped.workspaces).toEqual([
      { hash: "aaa", folder: "alpha" },
      { hash: "bbb", folder: "beta" },
    ]);
    expect(scoped.fleet).toHaveLength(3);
    expect(scoped.fleet.every((a) => !a.name.includes("("))).toBe(true); // single-bundle scope drops the folder suffix
    expect(scoped.worktrees.map((w) => w.id)).toEqual(["bbb-w"]);
    expect(scoped.overview.approvalsPending).toBe(1);
    expect(scoped.tmux).toEqual([{ folder: "beta", state: "healthy", version: undefined }]);

    const all = buildCockpitModel(bundles, { section: "fleet", nowIso: "now" });
    expect(all.selectedWsHash).toBeUndefined();
    expect(all.fleet).toHaveLength(5);

    // a persisted hash whose folder was closed since falls back to All, never an empty Control
    const stale = buildCockpitModel(bundles, { section: "fleet", wsHash: "gone", nowIso: "now" });
    expect(stale.selectedWsHash).toBeUndefined();
    expect(stale.fleet).toHaveLength(5);
  });

  it("formatCockpitDiagnostics is product-oriented", () => {
    const text = formatCockpitDiagnostics(buildCockpitModel([], { nowIso: "now" }));
    expect(text).toMatch(/Control/i);
  });
});
