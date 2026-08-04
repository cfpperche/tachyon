import { describe, expect, it } from "vitest";
import { buildCockpitModel, COCKPIT_SECTION_ORDER, formatCockpitDiagnostics } from "../../src/cockpit/model.js";

describe("cockpit model", () => {
  it("orders sections by ops frequency (no soon slots)", () => {
    expect(COCKPIT_SECTION_ORDER[0]).toBe("overview");
    expect(COCKPIT_SECTION_ORDER).not.toContain("settings");
    expect(COCKPIT_SECTION_ORDER).not.toContain("execution-graph");
    expect(COCKPIT_SECTION_ORDER).not.toContain("engine");
    // SDD 485 D4 — the Human Inbox is a standalone `dashboard` app: still a CockpitSectionId (so a
    // persisted or deep-linked `section:inbox` decodes and can be redirected) and still a launcher tile,
    // but Control renders no section for it. `approvals` and `validations` below were never on this list
    // for a DIFFERENT reason — they are compatibility routes the Inbox aggregates, not apps.
    expect(COCKPIT_SECTION_ORDER).not.toContain("inbox");
    expect(COCKPIT_SECTION_ORDER).not.toContain("approvals");
    // SDD 485 C5 — the Board is a standalone app: it is still a CockpitSectionId (so a persisted or
    // deep-linked route decodes and can be redirected) and still a launcher tile, but Control renders no
    // section for it, and this list is what Control renders.
    expect(COCKPIT_SECTION_ORDER).not.toContain("mission");
    expect(COCKPIT_SECTION_ORDER).not.toContain("validations");
    // SDD 485 D6 — Worktrees is now a standalone dashboard. The id remains decodable and the tile
    // remains visible, but Control no longer renders this section.
    expect(COCKPIT_SECTION_ORDER).not.toContain("worktrees");
    expect(COCKPIT_SECTION_ORDER).not.toContain("fleet");
    // t-e88c8a — the Deliveries tab was retired with the Delivery tool surface.
    expect(COCKPIT_SECTION_ORDER).not.toContain("deliveries");
    // SDD 485 D3 — Runtime Ops is a standalone `window` app, so Control renders no section for it. Its
    // Its launcher neighbour followed in D8, with opposite cardinality because it reads one project.
    expect(COCKPIT_SECTION_ORDER).not.toContain("runtime");
    expect(COCKPIT_SECTION_ORDER).not.toContain("runtime-config");
  });

  it("builds fleet/worktrees overview counts", () => {
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
          approvals: [],
          companion: { tabTools: true, allowedHosts: [], paired: false, devices: [] },
        },
        {
          control: { folderName: "b", workspaceRoot: "/b", wsHash: "h2", bridgeUrl: "http://127.0.0.1:2/mcp" },
          agents: [],
          worktrees: [],
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

    // t-4917e4 — the SELECTOR-RENDERS-EMPTY property, stated the way the UI actually binds it.
    // Overview omits the "All workspaces" option when there is a single root, so a model that leaves
    // the selection undefined there gives the control a value with no matching option: a blank
    // button, which is the reported bug. Every valid loaded state must name an option that exists.
    const optionValues = (m: ReturnType<typeof buildCockpitModel>): string[] => [
      ...(m.workspaces.length > 1 ? ["__all__"] : []),
      ...m.workspaces.map((w) => w.hash),
    ];
    for (const [label, m] of [
      ["single root, no persisted selection", buildCockpitModel([bundle("solo", "only", 1)], { section: "overview", nowIso: "now" })],
      ["single root, stale persisted selection", buildCockpitModel([bundle("solo", "only", 1)], { section: "overview", wsHash: "gone", nowIso: "now" })],
      ["single root, explicit selection", buildCockpitModel([bundle("solo", "only", 1)], { section: "overview", wsHash: "solo", nowIso: "now" })],
      ["multi root, no selection", all],
      ["multi root, explicit selection", scoped],
      ["multi root, stale selection", stale],
    ] as const) {
      const rendered = m.selectedWsHash ?? "__all__";
      expect(optionValues(m), `${label}: selector value must be an offered option`).toContain(rendered);
    }

    // And the single-root selection is the root itself, not the aggregate sentinel.
    expect(buildCockpitModel([bundle("solo", "only", 1)], { section: "overview", nowIso: "now" }).selectedWsHash)
      .toBe("solo");
    // Scoping is unchanged by naming it: one bundle filtered is one bundle.
    expect(buildCockpitModel([bundle("solo", "only", 1)], { section: "fleet", nowIso: "now" }).fleet).toHaveLength(1);
  });

  it("formatCockpitDiagnostics is product-oriented", () => {
    const text = formatCockpitDiagnostics(buildCockpitModel([], { nowIso: "now" }));
    expect(text).toMatch(/Control/i);
  });
});
