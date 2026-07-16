/**
 * Headless dogfood — spec 389 restart matrix on real tmux (no EDH GUI).
 * Private TMUX_TMPDIR; does not touch the fleet socket.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { isWorkspaceCommandV1 } from "../../src/engine-service/protocol.js";
import {
  TmuxService,
  defaultExecutor,
  sessionName,
  workspaceHash,
} from "../../src/tmux/TmuxService.js";

const EVIDENCE_DIR = path.resolve(".tachyon/evidence/restart-modes-dogfood");

describe("spec 389 headless dogfood — restart matrix (real tmux)", () => {
  let base: string;
  let workspace: string;
  let tmuxTmp: string;
  let prevTmuxTmpdir: string | undefined;
  let prevTmux: string | undefined;
  let prevPane: string | undefined;
  let manager: AgentManager;
  let tmux: TmuxService;
  let session: string;
  let wsHash: string;
  const evidence: Record<string, unknown>[] = [];

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-restart-modes-dogfood-"));
    workspace = path.join(base, "workspace");
    tmuxTmp = path.join(base, "tmux");
    prevTmuxTmpdir = process.env.TMUX_TMPDIR;
    prevTmux = process.env.TMUX;
    prevPane = process.env.TMUX_PANE;

    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(tmuxTmp, { recursive: true, mode: 0o700 });
    process.env.TMUX_TMPDIR = tmuxTmp;
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;

    // Bash shells are terminals (not kind: agent — that is for LLM CLIs only).
    // looper: dies on graceful EOF; sticky: ignores INT → force-fallback path.
    const yaml = `
settings:
  maxAgents: 8
terminals:
  looper:
    cmd: bash -c 'while true; do echo looper-tick; sleep 1; done'
    autostart: false
    attention: false
  sticky:
    cmd: bash -c 'trap "" INT; trap "" TERM; while true; do echo sticky; sleep 1; done'
    autostart: false
    attention: false
`.trim();
    fs.writeFileSync(path.join(workspace, "tachyon.yml"), `${yaml}\n`);
    const { config, errors } = parseConfig(yaml);
    if (!config || errors.length) throw new Error(`fixture config invalid: ${errors.join("; ")}`);

    wsHash = workspaceHash(workspace);
    session = sessionName(wsHash, "looper");
    const ledger = new SessionLedger(workspace);
    tmux = new TmuxService(defaultExecutor);
    manager = new AgentManager({
      tmux,
      wsHash,
      workspaceRoot: workspace,
      getConfig: () => config,
      getMaxAgents: () => 8,
      ledger,
    });
  });

  afterAll(async () => {
    for (const name of ["looper", "sticky"] as const) {
      try {
        await manager.kill(name);
      } catch {
        /* ignore */
      }
    }
    try {
      await defaultExecutor(["kill-server"]);
    } catch {
      /* ignore */
    }
    if (prevTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = prevTmuxTmpdir;
    if (prevTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = prevTmux;
    if (prevPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = prevPane;

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const report = {
      schemaVersion: 1,
      kind: "restart-modes-dogfood",
      spec: 389,
      stamp,
      evidence,
      passed: evidence.length > 0 && evidence.every((e) => e.ok === true),
    };
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(EVIDENCE_DIR, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);

    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* keep */
    }
  });

  async function ensureRunning(name: string): Promise<{ session: string; pid: number }> {
    const sess = sessionName(wsHash, name);
    const states = await manager.agentStates();
    const st = states.get(name);
    if (!st || st.dead || !(await tmux.hasSession(sess))) {
      // cold or dead — spawn or force-new restart
      try {
        await manager.spawn(name);
      } catch {
        await manager.restart(name, { stop: "force", session: "new" });
      }
    } else if (!st.dead) {
      /* already live */
    }
    // if session exists but dead pane, force replace
    const after = (await manager.agentStates()).get(name);
    if (!after || after.dead) {
      await manager.restart(name, { stop: "force", session: "new" });
    }
    const pid = await tmux.panePid(sess);
    expect(pid).toBeGreaterThan(0);
    return { session: sess, pid };
  }

  async function isProcessAlive(name: string): Promise<boolean> {
    const states = await manager.agentStates();
    const st = states.get(name);
    return !!st && !st.dead;
  }

  it("accepts engine restart wire modes and rejects unknowns", () => {
    expect(isWorkspaceCommandV1({
      schemaVersion: 1,
      method: "agent.restart",
      input: { agent: "looper", stop: "force", session: "new" },
    })).toBe(true);
    expect(isWorkspaceCommandV1({
      schemaVersion: 1,
      method: "agent.restart",
      input: { agent: "looper", stop: "graceful", session: "resume" },
    })).toBe(true);
    expect(isWorkspaceCommandV1({
      schemaVersion: 1,
      method: "agent.restart",
      input: { agent: "looper", stop: "soft" },
    })).toBe(false);
    evidence.push({ name: "protocol", ok: true });
  });

  it("force+new replaces the live pane process", async () => {
    const { pid: pid0 } = await ensureRunning("looper");
    const result = await manager.restart("looper", { stop: "force", session: "new" });
    expect(result).toMatchObject({
      stop: "force",
      session: "new",
      resumed: false,
      forcedAfterGracefulTimeout: false,
    });
    expect(await isProcessAlive("looper")).toBe(true);
    const pid1 = await tmux.panePid(session);
    expect(pid1).toBeGreaterThan(0);
    expect(pid1).not.toBe(pid0);
    evidence.push({ name: "force+new", ok: true, pid0, pid1, result });
  }, 60_000);

  it("force+resume without transcript falls back to new section", async () => {
    const { pid: pidBefore } = await ensureRunning("looper");
    const result = await manager.restart("looper", { stop: "force", session: "resume" });
    expect(result.stop).toBe("force");
    expect(result.session).toBe("resume");
    expect(result.resumed).toBe(false);
    expect(await isProcessAlive("looper")).toBe(true);
    const pidAfter = await tmux.panePid(session);
    expect(pidAfter).not.toBe(pidBefore);
    evidence.push({ name: "force+resume→new", ok: true, result, pidBefore, pidAfter });
  }, 60_000);

  it("graceful+new restarts a cooperative shell (EOF) back to running", async () => {
    await ensureRunning("looper");
    const result = await manager.restart("looper", {
      stop: "graceful",
      session: "new",
      gracefulTimeoutMs: 2_000,
    });
    expect(result.stop).toBe("graceful");
    expect(result.session).toBe("new");
    expect(result.resumed).toBe(false);
    // bash usually dies on C-d → no force fallback; sticky proves fallback separately.
    expect(await isProcessAlive("looper")).toBe(true);
    const listed = await manager.list();
    expect(listed.some((e) => e.name === "looper")).toBe(true);
    evidence.push({
      name: "graceful+new-cooperative",
      ok: true,
      result,
      forced: result.forcedAfterGracefulTimeout,
    });
  }, 60_000);

  it("graceful+new force-falls-back when the process ignores stop keys", async () => {
    const stickySession = sessionName(wsHash, "sticky");
    await ensureRunning("sticky");
    const pid0 = await tmux.panePid(stickySession);
    const result = await manager.restart("sticky", {
      stop: "graceful",
      session: "new",
      gracefulTimeoutMs: 300,
    });
    expect(result.stop).toBe("graceful");
    expect(result.session).toBe("new");
    expect(result.resumed).toBe(false);
    expect(result.forcedAfterGracefulTimeout).toBe(true);
    expect(await isProcessAlive("sticky")).toBe(true);
    const pid1 = await tmux.panePid(stickySession);
    expect(pid1).not.toBe(pid0);
    // row not wiped
    expect((await manager.list()).some((e) => e.name === "sticky")).toBe(true);
    evidence.push({ name: "graceful+new-force-fallback", ok: true, result, pid0, pid1 });
  }, 60_000);

  it("product default is graceful+resume with fallback to new when not resumable", async () => {
    await ensureRunning("looper");
    const result = await manager.restart("looper", { gracefulTimeoutMs: 2_000 });
    expect(result.stop).toBe("graceful");
    expect(result.session).toBe("resume");
    expect(result.resumed).toBe(false);
    expect(await isProcessAlive("looper")).toBe(true);
    evidence.push({ name: "default-graceful+resume→new", ok: true, result });
  }, 60_000);
});
