import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  CallerIdentityRegistry,
  type CallerScope,
} from "@tachyon/bridge/callerIdentity.js";
import {
  findAgentNameForBridgeToken,
  healUnknownBearerFromAgents,
  readProcEnvVar,
  type ProcFs,
} from "@tachyon/bridge/agentTokenHeal.js";
import { workspaceBridgePort } from "@tachyon/bridge/workspaceComposition.js";
import { managedAgentPaneRoots } from "@tachyon/engine/workspace/Workspace.js";

const SCOPE: CallerScope = { workspaceId: "ws", instanceId: "inst" };
const KEY = crypto.randomBytes(32);

function fakeProc(files: Record<string, string>): ProcFs {
  return {
    readdirSync(dir: string) {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const seg = rest.split("/")[0];
        if (seg) names.add(seg);
      }
      // also include pid dirs from top-level /proc keys
      if (dir === "/proc" || dir === "/proc/") {
        for (const p of Object.keys(files)) {
          const m = p.match(/^\/proc\/(\d+)\//);
          if (m) names.add(m[1]!);
        }
      }
      return [...names];
    },
    readFileSync(file: string) {
      if (file in files) return files[file]!;
      throw new Error(`ENOENT ${file}`);
    },
  };
}

const REAL_TOKEN = "ab".repeat(32);
const FORGED_TOKEN = "cd".repeat(32);

/**
 * One machine, two processes carrying the SAME agent name in their env:
 *
 *   pid 100  tmux pane root of managed agent 'grok'   (this is what the roster knows)
 *     pid 101  the runtime, holding grok's real token
 *   pid 999  `sleep`, spawned by anyone, OUTSIDE every managed pane, whose env claims
 *            TACHYON_AGENT_NAME=grok and carries a token its author chose (t-28e932's repro)
 */
function twoProcessMachine(): ProcFs {
  return fakeProc({
    "/proc/1/stat": "1 (init) S 0",
    "/proc/1/environ": "PATH=/\0",
    "/proc/100/stat": "100 (tmux) S 1",
    "/proc/100/environ": "PATH=/\0",
    "/proc/101/stat": "101 (grok) S 100",
    "/proc/101/environ": `TACHYON_AGENT_NAME=grok\0TACHYON_AGENT_BRIDGE_TOKEN=${REAL_TOKEN}\0`,
    "/proc/999/stat": "999 (sleep) S 1",
    "/proc/999/environ": `TACHYON_AGENT_NAME=grok\0TACHYON_AGENT_BRIDGE_TOKEN=${FORGED_TOKEN}\0`,
  });
}

const GROK_PANE = [{ name: "grok", panePid: 100 }] as const;

describe("agentTokenHeal", () => {
  it("readProcEnvVar parses null-separated environ", () => {
    const proc = fakeProc({
      "/proc/42/environ": "FOO=1\0TACHYON_AGENT_BRIDGE_TOKEN=aabb\0TACHYON_AGENT_NAME=grok\0",
    });
    expect(readProcEnvVar(42, "TACHYON_AGENT_NAME", "/proc", proc)).toBe("grok");
    expect(readProcEnvVar(42, "TACHYON_AGENT_BRIDGE_TOKEN", "/proc", proc)).toBe("aabb");
    expect(readProcEnvVar(42, "MISSING", "/proc", proc)).toBeUndefined();
  });

  it("finds the bearer only inside a managed pane tree", () => {
    const proc = twoProcessMachine();
    // pid 101 is a descendant of grok's pane root → found, named from the roster.
    expect(findAgentNameForBridgeToken(REAL_TOKEN, { agents: GROK_PANE, procRoot: "/proc", proc }))
      .toBe("grok");
    // pid 999 is not → nothing to find, even though its env names a real agent. Until t-2a7d24 a
    // full /proc scan answered "grok" here, straight out of pid 999's own TACHYON_AGENT_NAME.
    expect(findAgentNameForBridgeToken(FORGED_TOKEN, { agents: GROK_PANE, procRoot: "/proc", proc }))
      .toBeUndefined();
    // No pane list is no search: the empty list heals nothing rather than falling back to /proc.
    expect(findAgentNameForBridgeToken(REAL_TOKEN, { agents: [], procRoot: "/proc", proc }))
      .toBeUndefined();
    expect(findAgentNameForBridgeToken("ef".repeat(32), { agents: GROK_PANE, procRoot: "/proc", proc }))
      .toBeUndefined();
  });

  it("names the agent from the roster, never from the scanned process env", () => {
    // The pane tree of managed agent 'grok' holds a process whose env claims to be someone else.
    // The heal must answer 'grok' — the name comes from the pane row, not from /proc.
    const proc = fakeProc({
      "/proc/1/stat": "1 (init) S 0",
      "/proc/100/stat": "100 (tmux) S 1",
      "/proc/100/environ": "PATH=/\0",
      "/proc/101/stat": "101 (impostor) S 100",
      "/proc/101/environ": `TACHYON_AGENT_NAME=coordenador\0TACHYON_AGENT_BRIDGE_TOKEN=${REAL_TOKEN}\0`,
    });
    expect(findAgentNameForBridgeToken(REAL_TOKEN, { agents: GROK_PANE, procRoot: "/proc", proc }))
      .toBe("grok");
  });

  // PROOF 1 (t-2a7d24) — a forged bearer presented by a process outside every managed pane is not
  // adopted. Reproduced end-to-end against the real registry: the identity that the /proc full scan
  // used to hand out (t-28e932) now has no path into it.
  it("refuses a forged bearer from a process outside every managed pane", () => {
    const reg = new CallerIdentityRegistry(KEY);
    const proc = twoProcessMachine();

    const healed = healUnknownBearerFromAgents(reg, FORGED_TOKEN, GROK_PANE, SCOPE, {
      procRoot: "/proc",
      proc,
    });

    expect(healed).toEqual({ ok: false, reason: "no_match" });
    // and nothing was written: the bearer stays unknown, so the Bridge answers 401.
    expect(reg.resolve(FORGED_TOKEN, SCOPE)).toEqual({ ok: false, reason: "token_unknown" });
  });

  // PROOF 2 (t-2a7d24) — the legitimate case the heal exists for still works: a managed agent whose
  // token the digest-only registry forgot (remint/sweep/registry reload) recovers on its next MCP
  // hit, with no restart. Second heal is already_ok.
  it("still heals a managed agent whose token the registry forgot", () => {
    const reg = new CallerIdentityRegistry(KEY);
    const proc = twoProcessMachine();
    expect(reg.resolve(REAL_TOKEN, SCOPE)).toEqual({ ok: false, reason: "token_unknown" });

    const healed = healUnknownBearerFromAgents(reg, REAL_TOKEN, GROK_PANE, SCOPE, {
      procRoot: "/proc",
      proc,
    });
    expect(healed).toEqual({ ok: true, name: "grok", adopted: true });
    expect(reg.resolve(REAL_TOKEN, SCOPE)).toEqual({ ok: true, snapshot: { kind: "agent", name: "grok" } });

    expect(healUnknownBearerFromAgents(reg, REAL_TOKEN, GROK_PANE, SCOPE, { procRoot: "/proc", proc }))
      .toEqual({ ok: true, name: "grok", adopted: false });
  });
});

/**
 * The junction, asserted from the path production uses.
 *
 * t-2a7d24 was not a wrong algorithm: `healUnknownBearerFromAgents` was already correct and already
 * tested. What shipped was a composition root that called it with a hardcoded `[]`, so the only live
 * door was the full scan. Testing the heal alone cannot see that — these two assertions cover the
 * two links between it and production.
 */
describe("agentTokenHeal wiring", () => {
  it("the engine builds the pane list from the live roster, never empty by construction", async () => {
    const sessions: string[] = [];
    const manager = {
      runningAgents: async () => ["grok", "shell", "ghost"],
      kindOf: (name: string) => (name === "shell" ? "terminal" : "agent"),
      session: (name: string) => `tachyon-${name}`,
    };
    const tmux = {
      panePid: async (session: string) => {
        sessions.push(session);
        if (session === "tachyon-ghost") throw new Error("can't find session");
        return 100;
      },
    };

    const roots = await managedAgentPaneRoots(manager, tmux);

    expect(roots).toEqual([{ name: "grok", panePid: 100 }]);
    // the terminal was never asked for a pane pid; the agent tmux cannot answer for is dropped.
    expect(sessions).toEqual(["tachyon-grok", "tachyon-ghost"]);
  });

  it("the production composition root forwards that list into the confined heal", () => {
    const reg = new CallerIdentityRegistry(KEY);
    const proc = twoProcessMachine();
    // Same port object `createWorkspaceForTest` and the extension compose with.
    const heal = (agents: ReadonlyArray<{ name: string; panePid: number }>, bearer: string) =>
      workspaceBridgePort.healUnknownBearer(reg, bearer, agents, SCOPE, { procRoot: "/proc", proc });

    expect(heal(GROK_PANE, REAL_TOKEN)).toEqual({ ok: true, name: "grok", adopted: true });
    expect(heal(GROK_PANE, FORGED_TOKEN)).toEqual({ ok: false, reason: "no_match" });
  });
});
