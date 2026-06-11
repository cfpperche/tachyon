import { describe, it, expect } from "vitest";
import { classifySession } from "../../src/inspector/classify.js";
import { buildInspectorModel } from "../../src/inspector/model.js";
import { TmuxService, type ExecResult, type PaneSnapshot } from "../../src/tmux/TmuxService.js";

const HASH = "a1b2c3d4";
const HASH2 = "deadbeef";

describe("classifySession", () => {
  it("classifies the engine anchor", () => {
    expect(classifySession(`tachyon-ctl-${HASH}`)).toEqual({ kind: "anchor", wsHash: HASH, label: "engine anchor" });
  });

  it("classifies an agent/terminal session", () => {
    expect(classifySession(`tachyon-${HASH}-claude`)).toEqual({ kind: "session", wsHash: HASH, label: "claude" });
  });

  it("keeps multi-dash labels intact", () => {
    expect(classifySession(`tachyon-${HASH}-my-dev-server`)).toEqual({ kind: "session", wsHash: HASH, label: "my-dev-server" });
  });

  it("classifies a command run", () => {
    expect(classifySession(`tachyon-cmd-${HASH}-lint`)).toEqual({ kind: "command", wsHash: HASH, label: "lint" });
  });

  it("classifies a runbook step", () => {
    expect(classifySession(`tachyon-rb-${HASH}-ship-2`)).toEqual({ kind: "runbook", wsHash: HASH, label: "ship-2" });
  });

  it("treats non-tachyon names as unknown, surfacing the raw name", () => {
    expect(classifySession("someone-elses-session")).toEqual({ kind: "unknown", label: "someone-elses-session" });
  });

  it("falls back to unknown when the hash segment is malformed", () => {
    expect(classifySession("tachyon-notahash-x")).toEqual({ kind: "unknown", label: "tachyon-notahash-x" });
  });
});

function pane(session: string, over: Partial<PaneSnapshot> = {}): PaneSnapshot {
  return { session, window: 0, pane: 0, pid: 100, dead: false, currentCommand: "node", startCommand: "node", ...over };
}

describe("buildInspectorModel", () => {
  it("groups by workspace and resolves open-folder names", () => {
    const snap = [
      pane(`tachyon-${HASH}-claude`),
      pane(`tachyon-cmd-${HASH}-lint`, { dead: true, exitCode: 0 }),
      pane(`tachyon-${HASH2}-shell`),
    ];
    const model = buildInspectorModel(snap, new Map([[HASH, "orbit-api"]]));

    expect(model.totalSessions).toBe(3);
    expect(model.liveSessions).toBe(2);

    const known = model.groups.find((g) => g.wsHash === HASH);
    expect(known?.workspace).toBe("orbit-api");
    expect(known?.foreign).toBe(false);
    expect(known?.sessions.map((s) => s.label)).toEqual(["claude", "lint"]); // session kind before command kind

    const foreign = model.groups.find((g) => g.wsHash === HASH2);
    expect(foreign?.foreign).toBe(true);
    expect(foreign?.workspace).toContain("workspace");
  });

  it("orders open workspaces before foreign ones", () => {
    const model = buildInspectorModel(
      [pane(`tachyon-${HASH2}-x`), pane(`tachyon-${HASH}-y`)],
      new Map([[HASH, "mine"]]),
    );
    expect(model.groups[0].foreign).toBe(false);
    expect(model.groups[model.groups.length - 1].foreign).toBe(true);
  });

  it("propagates dead + exit code onto sessions", () => {
    const model = buildInspectorModel([pane(`tachyon-cmd-${HASH}-test`, { dead: true, exitCode: 1 })], new Map());
    const s = model.groups[0].sessions[0];
    expect(s.dead).toBe(true);
    expect(s.exitCode).toBe(1);
  });
});

function fixedExecutor(stdout: string): { calls: string[][]; exec: (a: string[]) => Promise<ExecResult> } {
  const calls: string[][] = [];
  return { calls, exec: async (args) => (calls.push(args), { stdout, stderr: "" }) };
}

describe("TmuxService.serverSnapshot", () => {
  it("parses list-panes output into typed rows and filters by prefix", async () => {
    const lines = [
      `tachyon-${HASH}-claude\t0\t0\t4242\t0\t\tnode\tclaude --foo`,
      `tachyon-cmd-${HASH}-lint\t0\t0\t4300\t1\t2\tbash\tnpm run lint`,
      `unrelated-session\t0\t0\t9\t0\t\tzsh\tzsh`, // outside our namespace -> filtered
    ].join("\n");
    const { calls, exec } = fixedExecutor(lines);
    const svc = new TmuxService(exec);

    const snap = await svc.serverSnapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0]).toMatchObject({ session: `tachyon-${HASH}-claude`, pid: 4242, dead: false, currentCommand: "node" });
    expect(snap[1]).toMatchObject({ session: `tachyon-cmd-${HASH}-lint`, pid: 4300, dead: true, exitCode: 2 });
    // single list-panes call on the socket
    expect(calls[0]).toContain("list-panes");
    expect(calls[0]).toContain("-a");
  });

  it("returns an empty snapshot when the server isn't running", async () => {
    const svc = new TmuxService(async () => {
      throw new Error("no server running on /tmp/tmux");
    });
    expect(await svc.serverSnapshot()).toEqual([]);
  });
});
