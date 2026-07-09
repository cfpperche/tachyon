import { describe, expect, it } from "vitest";
import { hostActionTouchesHostUi, isLauncherExternalToolKind } from "../../src/externalTools/filters.js";
import { ExternalToolRegistry } from "../../src/externalTools/registry.js";
import { scanExternalToolProcesses, type ProcEntry } from "../../src/externalTools/procScanner.js";
import { toAgentVM } from "../../src/sidebar/agentModel.js";

describe("ExternalToolRegistry", () => {
  it("summarizes one active browser session for the sidebar VM", () => {
    const registry = new ExternalToolRegistry();
    registry.upsert({
      id: "ets-browser",
      agent: "cx",
      kind: "browser",
      tool: "chromium",
      source: "tool-launcher",
      confidence: "strong",
      startedAt: "2026-07-09T12:00:00.000Z",
      lastSeenAt: "2026-07-09T12:00:00.000Z",
      state: "active",
    });

    expect(registry.summary("cx")).toEqual({
      active: 1,
      kinds: ["browser"],
      strongestConfidence: "strong",
      items: [{
        id: "ets-browser",
        kind: "browser",
        tool: "chromium",
        startedAt: "2026-07-09T12:00:00.000Z",
        source: "tool-launcher",
        confidence: "strong",
      }],
    });
  });

  it("collapses multiple active tools and preserves the strongest confidence", () => {
    const registry = new ExternalToolRegistry();
    registry.upsert({ id: "a", agent: "cx", kind: "browser", tool: "chrome", source: "proc-tree", confidence: "weak" });
    registry.upsert({ id: "b", agent: "cx", kind: "host-action", tool: "reloadWindow", source: "host-action", confidence: "strong" });

    const summary = registry.summary("cx");
    expect(summary?.active).toBe(2);
    expect(summary?.kinds).toEqual(["browser", "host-action"]);
    expect(summary?.strongestConfidence).toBe("strong");
  });

  it("clears badges when a recorded pid exits", () => {
    const registry = new ExternalToolRegistry();
    registry.upsert({ id: "pid-session", agent: "cx", kind: "browser", tool: "chrome", source: "proc-env", confidence: "medium", pid: 42 });
    expect(registry.summary("cx")?.active).toBe(1);

    registry.reconcile({ isPidAlive: () => false });
    expect(registry.summary("cx")).toBeUndefined();
    expect(registry.all().find((s) => s.id === "pid-session")?.state).toBe("exited");
  });

  it("projects summaries through toAgentVM", () => {
    const registry = new ExternalToolRegistry();
    registry.upsert({ id: "a", agent: "cx", kind: "browser", tool: "chrome", source: "proc-tree", confidence: "weak" });
    const vm = toAgentVM({ name: "cx", running: true, dead: false, crashed: false }, { ai: true, externalTools: registry.summary("cx") });

    expect(vm.externalTools?.active).toBe(1);
    expect(vm.externalTools?.strongestConfidence).toBe("weak");
  });

  it("ignores unknown-kind sessions for sidebar badge projections", () => {
    const registry = new ExternalToolRegistry();
    registry.upsert({ id: "cli", agent: "cx", kind: "unknown", tool: "ffmpeg", source: "tool-launcher", confidence: "strong" });

    expect(registry.byAgent("cx")).toEqual([]);
    expect(registry.summary("cx")).toBeUndefined();
  });
});

describe("external tool badge filters", () => {
  it("only treats browser, desktop, and screen launcher kinds as external tools", () => {
    expect(isLauncherExternalToolKind("browser")).toBe(true);
    expect(isLauncherExternalToolKind("desktop")).toBe(true);
    expect(isLauncherExternalToolKind("screen")).toBe(true);
    expect(isLauncherExternalToolKind("unknown")).toBe(false);
    expect(isLauncherExternalToolKind("host-action")).toBe(false);
  });

  it("records only host actions that heuristically mutate host UI", () => {
    expect(hostActionTouchesHostUi("reloadWindow")).toBe(true);
    expect(hostActionTouchesHostUi("focusTerminal")).toBe(true);
    expect(hostActionTouchesHostUi("captureScreenshot")).toBe(true);
    expect(hostActionTouchesHostUi("readFile")).toBe(false);
    expect(hostActionTouchesHostUi("list_tasks")).toBe(false);
  });
});

describe("scanExternalToolProcesses", () => {
  const entries: ProcEntry[] = [
    { pid: 100, ppid: 1, comm: "bash", cmdline: ["bash"] },
    { pid: 101, ppid: 100, comm: "node", cmdline: ["node"] },
    { pid: 102, ppid: 101, comm: "chromium", cmdline: ["chromium"] },
    { pid: 200, ppid: 1, comm: "bash", cmdline: ["bash"] },
    { pid: 201, ppid: 200, comm: "google-chrome", cmdline: ["google-chrome"], environAgent: "other" },
    { pid: 300, ppid: 1, comm: "google-chrome", cmdline: ["google-chrome"] },
  ];

  it("creates weak agent-row attribution from pane descendants only", () => {
    expect(scanExternalToolProcesses([{ agent: "cx", panePid: 100 }], entries)).toMatchObject([{
      id: "ets-proc-102",
      agent: "cx",
      kind: "browser",
      tool: "chromium",
      source: "proc-tree",
      confidence: "weak",
      pid: 102,
    }]);
  });

  it("uses inherited TACHYON_AGENT_NAME as medium attribution", () => {
    expect(scanExternalToolProcesses([{ agent: "other", panePid: 200 }], entries)).toMatchObject([{
      id: "ets-proc-201",
      agent: "other",
      source: "proc-env",
      confidence: "medium",
    }]);
  });

  it("does not create fleet-noise badges for non-descendant GUI processes", () => {
    expect(scanExternalToolProcesses([{ agent: "cx", panePid: 100 }], entries).some((s) => s.pid === 300)).toBe(false);
  });
});
