import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { planResume, type ResumeWorld } from "../../src/resume/planResume.js";
import { RunLedger } from "../../src/pipeline/RunLedger.js";
import { loadPipeline } from "../../src/pipeline/loadPipeline.js";
import { initRun, startNode } from "../../src/pipeline/runState.js";

const dirs: string[] = [];
const mkws = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pl-dur-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("SessionDef.pipeline survives a ledger round-trip (codex S4 M4)", () => {
  it("persists and reloads the typed pipeline owner ref", () => {
    const led = new SessionLedger(mkws());
    led.record("feature-r1-implement", {
      def: { cmd: "claude", kind: "agent", pipeline: { runId: "r1", nodeId: "implement" } },
      cwd: "/wt/r1",
      declared: false,
    });
    expect(led.get("feature-r1-implement")?.def?.pipeline).toEqual({ runId: "r1", nodeId: "implement" });
  });
});

describe("planResume skips pipeline-owned node sessions (codex S4 M4)", () => {
  const world = (): ResumeWorld => ({
    ledger: new Map([
      // a normal resumable ad-hoc claude → should be offered
      ["plain", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "x" }, cwd: "/w", declared: false, updatedAt: "" }],
      // a pipeline node (even with a resume block) → skipped entirely
      ["feature-r1-implement", { def: { cmd: "claude", kind: "agent", pipeline: { runId: "r1", nodeId: "implement" } }, resume: { runtime: "claude", sessionId: "y" }, cwd: "/wt/r1", declared: false, updatedAt: "" }],
    ]),
    declaredAutostart: new Set(),
    liveSessions: new Set(),
  });

  it("offers the plain agent but never the pipeline node", () => {
    const plan = planResume(world());
    expect(plan.map((p) => p.name)).toEqual(["plain"]);
    expect(plan.find((p) => p.name === "feature-r1-implement")).toBeUndefined();
  });

  it("skips a pipeline node even when its session is live (the run reconciles it)", () => {
    const w = world();
    w.liveSessions = new Set(["feature-r1-implement"]);
    const plan = planResume(w);
    expect(plan.find((p) => p.name === "feature-r1-implement")).toBeUndefined();
  });
});

describe("RunLedger persists/loads/lists/removes a run", () => {
  const PIPE = loadPipeline(
    `name: feature\nnodes:\n  a: {cmd: x, task: t, done: exit, timeout: 1s}\n  b: {cmd: y, task: t, needs: [a], done: exit, timeout: 1s}\n`,
    new Set(),
  ).pipeline!;

  it("round-trips a run with its node states", () => {
    const led = new RunLedger(mkws());
    let run = initRun("r1", PIPE, "run-r1");
    run = startNode(run, "a");
    led.save(run);

    const loaded = led.load("r1");
    expect(loaded?.id).toBe("r1");
    expect(loaded?.worktreeKey).toBe("run-r1");
    expect(loaded?.nodes.a.status).toBe("running");
    expect(loaded?.pipeline.name).toBe("feature");

    expect(led.list().map((r) => r.id)).toEqual(["r1"]);
    led.remove("r1");
    expect(led.load("r1")).toBeNull();
    expect(led.list()).toEqual([]);
  });

  it("returns null/empty on a missing or corrupt file (never throws)", () => {
    const ws = mkws();
    const led = new RunLedger(ws);
    expect(led.load("nope")).toBeNull();
    expect(led.list()).toEqual([]);
    fs.mkdirSync(led.dir, { recursive: true });
    fs.writeFileSync(path.join(led.dir, "bad.json"), "{ not json");
    expect(led.load("bad")).toBeNull();
    expect(led.list()).toEqual([]);
  });

  // spec 231 — input + summaries persistence + back-compat with pre-231 rows.
  it("round-trips the run input + handoff summaries", () => {
    const led = new RunLedger(mkws());
    let run = initRun("r2", PIPE, "run-r2", "Add a dark-mode toggle.");
    run = { ...run, summaries: [{ nodeId: "a", summary: "plan in docs/plan.md" }] };
    led.save(run);
    const loaded = led.load("r2");
    expect(loaded?.input).toBe("Add a dark-mode toggle.");
    expect(loaded?.summaries).toEqual([{ nodeId: "a", summary: "plan in docs/plan.md" }]);
  });

  it("normalizes a pre-231 row (no input/summaries) → summaries:[], input undefined", () => {
    const led = new RunLedger(mkws());
    fs.mkdirSync(led.dir, { recursive: true });
    // a hand-written old row WITHOUT input/summaries
    const old = { id: "r3", worktreeKey: "run-r3", pipeline: PIPE, nodes: { a: { status: "done" }, b: { status: "pending" } } };
    fs.writeFileSync(path.join(led.dir, "r3.json"), JSON.stringify(old));
    const loaded = led.load("r3");
    expect(loaded?.id).toBe("r3");
    expect(loaded?.input).toBeUndefined();
    expect(loaded?.summaries).toEqual([]);
  });
});
