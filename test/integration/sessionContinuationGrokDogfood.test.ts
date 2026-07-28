/**
 * Headless dogfood — SDD 443 continue_task with real Grok runtime agents on real tmux.
 * Private TMUX_TMPDIR; does not touch the fleet socket.
 *
 *   npx vitest run test/integration/sessionContinuationGrokDogfood.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../../src/workspace/Workspace.js";
import { TmuxService, defaultExecutor } from "../../src/tmux/TmuxService.js";
import { makeSocketTemp } from "../helpers/socketTemp.js";
import { gateCmdRuntimeChange } from "../../src/agents/cmdRuntimeGate.js";
import { writeCanonicalAgent, canonicalAgentSecrets, canonicalAgentsYaml } from "../helpers/canonicalAgentFixture.js";

/** Seeded by the fixture setup below, then handed to every DogfoodHost this run builds. */
let canonicalSecrets = new Map<string, string>();
function dogfoodHost(storageDir: string): DogfoodHost {
  const host = new DogfoodHost(storageDir);
  for (const [key, value] of canonicalSecrets) host.secrets.set(key, value);
  return host;
}

const EVIDENCE_DIR = path.resolve(".tachyon/evidence/session-continuation-grok-dogfood");

function grokAvailable(): boolean {
  try {
    execFileSync("grok", ["--version"], { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Minimal EngineHost for headless Workspace.createForTest (mirrors deliveryFreeAbandon WiringHost). */
class DogfoodHost {
  constructor(private readonly storageDir: string) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  t = (m: string, ...a: (string | number | boolean)[]): string =>
    m.replace(/\{(\d+)\}/g, (_x, i) => String(a[Number(i)] ?? ""));
  notify(): void {}
  focusPrimaryView(): void {}
  openTask(): void {}
  executeCommand(command: string): Promise<unknown> {
    return Promise.reject(new Error(`unexpected host command in dogfood: ${command}`));
  }
  watch(): { dispose(): void } {
    return { dispose() {} };
  }
  getSetting<T>(_s: string, _k: string, d: T): T {
    return d;
  }
  globalStoragePath(): string {
    return this.storageDir;
  }
  getState<T>(_k: string): T | undefined {
    return undefined;
  }
  setState(): void {}
  readonly secrets = new Map<string, string>();
  getSecret(key: string): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(key));
  }
  setSecret(): Promise<void> {
    return Promise.resolve();
  }
  appVersion(): string {
    return "0.0.0-dogfood";
  }
  mediaPath(...s: string[]): string {
    return path.join(this.storageDir, ...s);
  }
  webviewRoot(): unknown {
    return undefined;
  }
  onViewsChanged(): void {}
}

describe.skipIf(!grokAvailable() || !tmuxAvailable())(
  "SDD 443 dogfood — continue_task with real grok agents (tmux)",
  () => {
    let base: string;
    let workspace: string;
    let tmuxTmp: string;
    let prevTmuxTmpdir: string | undefined;
    let prevTmux: string | undefined;
    let prevPane: string | undefined;
    let ws: Workspace;
    const evidence: Record<string, unknown>[] = [];

    beforeAll(async () => {
      base = makeSocketTemp("sc-grok-");
      workspace = path.join(base, "ws");
      tmuxTmp = path.join(base, "t");
      prevTmuxTmpdir = process.env.TMUX_TMPDIR;
      prevTmux = process.env.TMUX;
      prevPane = process.env.TMUX_PANE;
      fs.mkdirSync(workspace, { recursive: true });
      fs.mkdirSync(tmuxTmp, { recursive: true, mode: 0o700 });
      process.env.TMUX_TMPDIR = tmuxTmp;
      delete process.env.TMUX;
      delete process.env.TMUX_PANE;

      // Two declared Grok agents — continue_task requires distinct rows.
      // SDD 478 M7 — a declared agent is a canonical profile pointer plus the host-custodied
      // authority that attests it; `agents:` no longer accepts an inline definition.
      const canonical = ["source", "dest"].map((name) =>
        writeCanonicalAgent(workspace, name, { runtime: "grok", autostart: false, attention: { enabled: false } }));
      canonicalSecrets = canonicalAgentSecrets(workspace, canonical);
      const yaml = `settings:\n  maxAgents: 8\n${canonicalAgentsYaml(canonical)}`;
      fs.writeFileSync(path.join(workspace, "tachyon.yml"), yaml);
      // minimal git so worktree paths stay sane
      execFileSync("git", ["init", "-q", "-b", "main", workspace], { stdio: "ignore" });
      execFileSync("git", ["-C", workspace, "commit", "-q", "--allow-empty", "-m", "root"], {
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });

      const tmux = new TmuxService(defaultExecutor);
      ws = await Workspace.createForTest(
        workspace,
        { host: dogfoodHost(path.join(base, "storage")), onViewsChanged: () => {} },
        { tmux, startBridge: false },
      );
    }, 60_000);

    afterAll(async () => {
      for (const name of ["source", "dest"] as const) {
        try {
          await ws.manager.kill(name);
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
        kind: "session-continuation-grok-dogfood",
        spec: 443,
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
    }, 60_000);

    it(
      "spawns source (grok), continue_task → dest (grok), handoff on disk, dest running",
      async () => {
        // 1) Source agent live on real grok TUI
        await ws.manager.spawn("source", { reveal: false });
        // Refresh inventory so isKnownAliveSync / runningAgents see the pane
        await ws.manager.agentStates();
        const runningAfterSpawn = await ws.manager.runningAgents();
        const sourceUp = runningAfterSpawn.includes("source");
        evidence.push({ step: "spawn-source-grok", ok: sourceUp, running: runningAfterSpawn });
        expect(sourceUp).toBe(true);

        // 2) Gate: changing cmd while live must refuse
        const gate = gateCmdRuntimeChange({
          agent: "source",
          prevCmd: "grok",
          nextCmd: "codex",
          running: ws.manager.isKnownAliveSync("source"),
        });
        evidence.push({
          step: "cmd-gate-while-live",
          ok: !gate.ok && gate.code === "agent_running",
          gate,
        });
        expect(gate.ok).toBe(false);

        // 3) continue_task source → dest (dest stopped, both grok)
        const result = await ws.continueTaskAcrossRuntime({
          fromAgent: "source",
          toAgent: "dest",
          reason: "dogfood usage-limit simulation",
          taskSummary: "Continue landing SDD 443 with real Grok agents",
        });
        evidence.push({ step: "continue-task", ok: result.ok === true, result });

        expect(result.ok).toBe(true);
        expect(result.fromRuntime).toBe("grok");
        expect(result.toRuntime).toBe("grok");
        const handoffAbs = path.join(workspace, result.handoffPath);
        expect(fs.existsSync(handoffAbs)).toBe(true);
        const body = fs.readFileSync(handoffAbs, "utf8");
        expect(body).toMatch(/new session/i);
        expect(body).toContain("dogfood usage-limit simulation");

        await ws.manager.agentStates();
        const runningAfter = await ws.manager.runningAgents();
        const destUp = runningAfter.includes("dest");
        const sourceStill = runningAfter.includes("source");
        evidence.push({
          step: "both-running",
          ok: destUp && sourceStill,
          running: runningAfter,
          handoffPath: result.handoffPath,
        });
        expect(destUp).toBe(true);
        expect(sourceStill).toBe(true); // source left intact
      },
      180_000,
    );
  },
);
