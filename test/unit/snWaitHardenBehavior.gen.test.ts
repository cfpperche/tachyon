import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentManager } from "@tachyon/engine/agents/AgentManager.js";
import { SessionLedger } from "@tachyon/engine/resume/SessionLedger.js";
import { TmuxService, workspaceHash, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import { parseConfig } from "@tachyon/engine/config/loadConfig.js";
import {
  inWaitOutputScope,
  waitForOutput,
  WaitOutputConcurrencyGate,
  waitOutputConcurrencyRefusalMessage,
  type WaitOutputCaptureSource,
  type WaitForOutputResult,
} from "@tachyon/bridge/waitForOutput.js";

const WS = "/repo-wait-harden";
const HASH = workspaceHash(WS);

function fakeTmux() {
  const sessions = new Set<string>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => args[args.indexOf("-t") + 1]?.replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      return { stdout: "", stderr: "" };
    }
    switch (args[2]) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "list-sessions":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions].join("\n"), stderr: "" };
      case "list-panes":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n"), stderr: "" };
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return new TmuxService(exec);
}

/** Mirrors the exact acquire→try→release wiring tools.ts uses around wait_for_output — proves the
 *  contract, not a reimplementation of it (the gate + waitForOutput are the same exports tools.ts calls). */
async function runGated(
  gate: WaitOutputConcurrencyGate,
  source: WaitOutputCaptureSource,
  params: Parameters<typeof waitForOutput>[2],
): Promise<{ refused: true; message: string } | { refused: false; result: WaitForOutputResult }> {
  if (!gate.tryAcquire()) return { refused: true, message: waitOutputConcurrencyRefusalMessage(gate.capacity) };
  try {
    return { refused: false, result: await waitForOutput(source, "s", params) };
  } finally {
    gate.release();
  }
}

function fakeCapture(script: string[]): WaitOutputCaptureSource {
  let i = 0;
  return {
    capturePane: async () => script[Math.min(i++, script.length - 1)],
  };
}

function throwingCapture(okOnce: string): WaitOutputCaptureSource {
  let calls = 0;
  return {
    capturePane: async () => {
      calls++;
      if (calls === 1) return okOnce;
      throw new Error("tmux capture-pane failed mid-poll");
    },
  };
}

describe("container-generated delegation behavior", () => {
  it("wait_for_output survives a reload for declared children and cannot starve the shared tmux queue", async () => {
    const dirs: string[] = [];
    try {
      // --- (a) + (b): parentOf/inWaitOutputScope survive a reload for a child whose lineage lives
      // only in the ledger, without widening scope for anyone else. ---
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-waitharden-"));
      dirs.push(ws);
      const ledger = new SessionLedger(ws);
      const { config } = parseConfig("agents:\n  boss:\n    cmd: claude\n  child:\n    cmd: claude\n");
      const tmux = fakeTmux();

      // A ledger row whose OWN `declared` flag is false (e.g. persisted back when `child` was still
      // ad-hoc, or by any non-spawn() writer). Since t-5e1113 (SDD 482, decision 5) `def.parent` is
      // persisted for declared rows too, so this row's parent survives either way — the flag is no
      // longer what decides it.
      ledger.record("child", { def: { cmd: "claude", kind: "agent", parent: "boss" }, cwd: ws, instance: { lifetime: "temporary", resumePolicy: "collected", lifecycleHooks: false } });

      // Fresh AgentManager instance sharing the ledger, in-memory lineage empty — simulates the
      // state right after an extension-host reload.
      const reloaded = new AgentManager({ tmux, wsHash: HASH, workspaceRoot: ws, getConfig: () => config, ledger });
      // `child` is currently declared in config, so rehydrateFromLedger's loop skips it (declared
      // names are config's to own) — this is the exact regression: rehydrate never touches it, so
      // only the parentOf ledger-union fix (not rehydrate) can recover the link.
      await reloaded.rehydrateFromLedger();

      // (a) the exact regression: parentOf resolves via the ledger even though in-memory lineage
      // never saw it, and that resolution is what inWaitOutputScope needs to permit the parent's wait.
      expect(reloaded.parentOf("child")).toBe("boss");
      expect(inWaitOutputScope("boss", "child", reloaded)).toBe(true);

      // (b) scope did not widen: an unrelated caller/target pair is still refused.
      expect(reloaded.parentOf("stranger")).toBeUndefined();
      expect(inWaitOutputScope("mallory", "child", reloaded)).toBe(false);
      expect(inWaitOutputScope("boss", "stranger", reloaded)).toBe(false);

      // --- (c) + (d): the concurrency gate refuses beyond its cap (never hangs/queues) and never
      // leaks a slot on a timeout or a thrown capture error. ---
      const now = (() => {
        let t = 0;
        return () => (t += 10);
      })();
      const sleep = async () => {};
      const neverMatches = { match: "never-appears", timeoutSec: 1, pollMs: 1, now, sleep };

      // (c) three concurrent callers against a 2-slot gate: exactly 2 admitted, the 3rd refused
      // immediately (synchronously, via tryAcquire — never queued, never hung) naming the cap.
      const gate = new WaitOutputConcurrencyGate(2);
      const [r1, r2, r3] = await Promise.all([
        runGated(gate, fakeCapture(["x\n"]), neverMatches),
        runGated(gate, fakeCapture(["x\n"]), neverMatches),
        runGated(gate, fakeCapture(["x\n"]), neverMatches),
      ]);
      expect(r1.refused).toBe(false);
      expect(r2.refused).toBe(false);
      expect(r3.refused).toBe(true);
      if (r3.refused) {
        expect(r3.message).toContain("wait_for_output refused");
        expect(r3.message).toContain("2");
      }
      expect(gate.inFlight).toBe(0); // both admitted waiters released after resolving

      // (d) a timed-out waiter releases its slot — a subsequent call is admitted, not starved.
      const soloGate = new WaitOutputConcurrencyGate(1);
      const timedOut = await runGated(soloGate, fakeCapture(["x\n"]), neverMatches);
      expect(timedOut.refused).toBe(false);
      if (!timedOut.refused) expect(timedOut.result.met).toBe(false);
      expect(soloGate.inFlight).toBe(0);
      expect(soloGate.tryAcquire()).toBe(true); // proves the slot didn't leak
      soloGate.release();

      // (d) a waiter whose capture THROWS mid-poll also releases its slot on the throw path.
      const throwGate = new WaitOutputConcurrencyGate(1);
      await expect(runGated(throwGate, throwingCapture("x\n"), { match: "never-appears", timeoutSec: 1, pollMs: 1, now, sleep })).rejects.toThrow(
        "tmux capture-pane failed mid-poll",
      );
      expect(throwGate.inFlight).toBe(0); // release() ran in `finally` despite the throw
      expect(throwGate.tryAcquire()).toBe(true); // a subsequent call is admitted, not starved
      throwGate.release();
    } finally {
      for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
