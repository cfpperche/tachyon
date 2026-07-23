import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionLedger,
  hasDeliveryMarker,
  isInvalidDeliveryMarker,
  isValidDeliveryBinding,
} from "../../src/resume/SessionLedger.js";
import { planResume, autoResumes, offers } from "../../src/resume/planResume.js";
import {
  reconcileDeliveryReload,
  type ObservedProcess,
} from "../../src/delivery/reloadReconciliation.js";
import { DeliveryStore } from "../../src/delivery/store.js";
import { deterministicGitDeliveryId, GitDeliveryStore } from "../../src/git-delivery/store.js";
import type { Delivery } from "../../src/delivery/types.js";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "../../src/workspace/EngineHost.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";

/**
 * Canonical gated behavior for SDD 368 T14 R2.
 * Exercises real SessionLedger bind/parse, DeliveryStore + GitDeliveryStore-backed
 * reconciliation, planResume deny set, and AgentManager lifecycle refusal — not a
 * copy of production decision tables.
 */
describe("container-generated delegation behavior", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("reload reconstructs an exact lease holder and fails closed on ambiguous occupancy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t14-r2-behavior-"));
    dirs.push(root);
    const wt = path.join(root, "wt-held");
    fs.mkdirSync(wt, { recursive: true });

    // --- Durable reverse binding: round-trip + invalid sentinel + conflict refuse ---
    const ledger = new SessionLedger(root);
    ledger.record("holder", {
      def: { cmd: "claude", kind: "agent" },
      resume: { runtime: "claude", sessionId: "sess" },
      cwd: wt,
      worktree: { path: wt, branch: "tachyon/d", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "t0" },
      declared: false,
    });
    const binding = { deliveryId: "d-exact", segmentId: "seg-exact", executionNonce: "nonce-exact" };
    ledger.bindDelivery("holder", binding);
    ledger.bindDelivery("holder", binding); // idempotent
    expect(isValidDeliveryBinding(new SessionLedger(root).get("holder")?.delivery)).toBe(true);
    expect(() => ledger.bindDelivery("holder", { ...binding, segmentId: "seg-OTHER" })).toThrow(/differs/);

    // Malformed on-disk marker must survive as invalid (not dropped into ordinary resume).
    const sessionsPath = path.join(root, ".tachyon", "sessions.json");
    const raw = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    raw.sessions.ghost = {
      def: { cmd: "claude", kind: "agent" },
      resume: { runtime: "claude", sessionId: "g" },
      cwd: wt,
      declared: true,
      delivery: { deliveryId: "" },
      updatedAt: "t",
    };
    fs.writeFileSync(sessionsPath, JSON.stringify(raw), "utf8");
    const ghost = new SessionLedger(root).get("ghost");
    expect(isInvalidDeliveryMarker(ghost?.delivery)).toBe(true);
    expect(hasDeliveryMarker(ghost)).toBe(true);

    // --- Real DeliveryStore + GitDeliveryStore seams (not pure table-only) ---
    const now = "2026-07-12T12:00:00.000Z";
    const exactProjectionId = deterministicGitDeliveryId("d-exact");
    const crashProjectionId = deterministicGitDeliveryId("d-crash");
    const deliveries = new DeliveryStore(root, { now: () => now, id: () => "d-exact" });
    const held = await deliveries.create({
      id: "d-exact",
      workspaceId: "ws",
      createdBy: { kind: "system", name: "tachyon" },
      contract: { baseSha: "abc", behaviorTest: "gate", owns: ["src"], taskRef: "tachyon/d" },
      lease: {
        state: "held",
        holder: {
          segmentId: "seg-exact",
          executionAgent: "holder",
          principal: "holder",
          process: { pid: 4242, processStart: "777", bootId: "boot-exact" },
          executionNonce: "nonce-exact",
        },
        expectedHeadSha: "abc",
        changedAt: now,
      },
      segments: [{
        id: "seg-exact",
        index: 0,
        role: "implementer",
        executionAgent: "holder",
        principal: "holder",
        grantedBy: { kind: "system", name: "tachyon" },
        ownsSubset: ["src"],
        grantedHeadSha: "abc",
        grantedAt: now,
      }],
      events: [],
      gitDeliveryId: exactProjectionId,
    });
    expect(held.id).toBe("d-exact");

    const git = new GitDeliveryStore(root, { now: () => now });
    const projection = await git.open({
      id: exactProjectionId,
      workspaceId: "ws",
      createdBy: { kind: "system", name: "tachyon" },
      deliveryId: "d-exact",
      agent: "holder",
      branchRef: "tachyon/d",
      worktreePath: wt,
      tachyonCreatedBranch: true,
      baseRef: "abc",
      currentHeadSha: "abc",
      reason: "t14-r2-behavior",
    });
    expect(projection.id).toBe(exactProjectionId);
    expect(projection.deliveryId).toBe("d-exact");

    // Also seed a quarantined delivery for classification coverage.
    await deliveries.create({
      id: "d-q",
      workspaceId: "ws",
      createdBy: { kind: "system", name: "tachyon" },
      contract: { baseSha: "abc", behaviorTest: "gate", owns: ["src"], taskRef: "tachyon/q" },
      lease: { state: "quarantined", reason: "dirty crash", changedAt: now },
      segments: [],
      events: [],
    });

    // Crash-window Delivery: held + projection, no ledger binding.
    await deliveries.create({
      id: "d-crash",
      workspaceId: "ws",
      createdBy: { kind: "system", name: "tachyon" },
      contract: { baseSha: "abc", behaviorTest: "gate", owns: ["src"], taskRef: "tachyon/crash" },
      lease: {
        state: "held",
        holder: {
          segmentId: "seg-crash",
          executionAgent: "crash-holder",
          process: { pid: 99, processStart: "1", bootId: "boot" },
          executionNonce: "nonce-crash",
        },
        expectedHeadSha: "abc",
        changedAt: now,
      },
      segments: [{
        id: "seg-crash",
        index: 0,
        role: "implementer",
        executionAgent: "crash-holder",
        grantedBy: { kind: "system", name: "tachyon" },
        ownsSubset: ["src"],
        grantedHeadSha: "abc",
        grantedAt: now,
      }],
      events: [],
      gitDeliveryId: crashProjectionId,
    });
    await new GitDeliveryStore(root, { now: () => now }).open({
      id: crashProjectionId,
      workspaceId: "ws",
      createdBy: { kind: "system", name: "tachyon" },
      deliveryId: "d-crash",
      agent: "crash-holder",
      branchRef: "tachyon/crash",
      worktreePath: path.join(root, "wt-crash"),
      tachyonCreatedBranch: true,
      baseRef: "abc",
      currentHeadSha: "abc",
      reason: "t14-r2-crash-window",
    });
    // Ordinary marker-less resumable row for the crash holder.
    ledger.record("crash-holder", {
      def: { cmd: "claude", kind: "agent" },
      resume: { runtime: "claude", sessionId: "crash-sess" },
      cwd: path.join(root, "wt-crash"),
      worktree: {
        path: path.join(root, "wt-crash"),
        branch: "tachyon/crash",
        tachyonCreatedBranch: true,
        baseRef: "abc",
        createdAt: "t0",
      },
      declared: true,
    });

    const listed = await deliveries.list();
    // GitDeliveryStore with fixed id only returns that store's rows; re-list via fresh store.
    const allGit = await new GitDeliveryStore(root).list();
    void git; // projection was opened through this store instance above
    const linkedProjections = allGit
      .filter((g) => g.deliveryId && g.worktreePath)
      .map((g) => ({
        gitDeliveryId: g.id,
        deliveryId: g.deliveryId!,
        worktreePath: g.worktreePath,
      }));
    expect(linkedProjections.some((p) => p.deliveryId === "d-exact")).toBe(true);
    expect(linkedProjections.some((p) => p.deliveryId === "d-crash")).toBe(true);
    expect(listed.map((d) => d.id).sort()).toEqual(["d-crash", "d-exact", "d-q"]);

    const exactObs: ObservedProcess = {
      state: "exact",
      pid: 4242,
      processStart: "777",
      bootId: "boot-exact",
    };
    const sessionsMap = new SessionLedger(root).all();
    const exactSnap = reconcileDeliveryReload({
      deliveries: listed,
      linkedProjections,
      sessions: sessionsMap,
      processByAgent: new Map([["holder", exactObs]]),
    });
    expect(exactSnap.byId.get("d-exact")).toMatchObject({ class: "held", holderAgent: "holder" });
    expect(exactSnap.byId.get("d-q")).toMatchObject({ class: "quarantined" });
    // Crash window: no binding → unavailable, holder in deny set even without marker.
    expect(exactSnap.byId.get("d-crash")?.class).toBe("unavailable");
    expect(exactSnap.unavailableAgents.has("crash-holder")).toBe(true);
    expect(hasDeliveryMarker(sessionsMap.get("crash-holder"))).toBe(false);

    // --- Generic lifecycle exclusion (planResume marker + deny set + AgentManager) ---
    const plan = planResume({
      ledger: new SessionLedger(root).all(),
      declaredAutostart: new Set(["ghost", "holder", "crash-holder"]),
      liveSessions: new Set(),
      deliveryUnavailableAgents: exactSnap.unavailableAgents,
    });
    expect(autoResumes(plan).map((p) => p.name)).not.toContain("holder");
    expect(autoResumes(plan).map((p) => p.name)).not.toContain("ghost");
    expect(autoResumes(plan).map((p) => p.name)).not.toContain("crash-holder");
    expect(offers(plan).map((p) => p.name)).not.toContain("holder");
    expect(offers(plan).map((p) => p.name)).not.toContain("crash-holder");

    const sessions = new Set<string>();
    const exec = async (args: string[]): Promise<ExecResult> => {
      if (args.includes("new-session")) {
        sessions.add(args[args.indexOf("-s") + 1]);
        return { stdout: "", stderr: "" };
      }
      if (args[2] === "has-session") {
        const t = args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
        if (!sessions.has(t)) throw new Error("no session");
        return { stdout: "", stderr: "" };
      }
      if (args[2] === "list-panes") {
        return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
      }
      if (args[2] === "list-sessions") {
        return { stdout: [...sessions].join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
      }
      if (args[2] === "kill-session") {
        const t = args[args.indexOf("-t") + 1].replace(/^=/, "");
        sessions.delete(t);
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const config = parseConfig("agents:\n  holder:\n    cmd: claude\n  crash-holder:\n    cmd: claude\n    autostart: true\n").config!;
    const denySet = exactSnap.unavailableAgents;
    const manager = new AgentManager({
      tmux: new TmuxService(exec),
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => config,
      getMaxAgents: () => 8,
      ledger: new SessionLedger(root),
      fileExists: () => true,
      isDeliveryLifecycleDenied: (name) => denySet.has(name),
    });
    await expect(manager.resume("holder", new SessionLedger(root).get("holder")!)).rejects.toThrow(/Delivery-bound/);
    await expect(manager.restart("holder", { stop: "force", session: "new" })).rejects.toThrow(/Delivery-bound/);
    // Marker-less crash-window agent: denied by snapshot, not by marker.
    await expect(manager.resume("crash-holder", new SessionLedger(root).get("crash-holder")!)).rejects.toThrow(/Delivery/);
    await expect(manager.restart("crash-holder", { stop: "force", session: "new" })).rejects.toThrow(/Delivery/);
    await expect(manager.spawn("crash-holder")).rejects.toThrow(/Delivery/);
    expect(await manager.resumeReadiness("holder", new SessionLedger(root).get("holder")!)).toBe(false);
    expect(await manager.resumeReadiness("crash-holder", new SessionLedger(root).get("crash-holder")!)).toBe(false);
    const pending = await manager.autostartPending();
    expect(pending).not.toContain("crash-holder");

    // Ambiguous: process identity mismatch (PID reuse) → unavailable, never free/held.
    const reuseSnap = reconcileDeliveryReload({
      deliveries: listed.filter((d) => d.id === "d-exact"),
      linkedProjections: linkedProjections.filter((p) => p.deliveryId === "d-exact"),
      sessions: sessionsMap,
      processByAgent: new Map([["holder", { ...exactObs, processStart: "000" }]]),
    });
    expect(reuseSnap.byId.get("d-exact")?.class).toBe("unavailable");

    // Ambiguous: two session rows for same Delivery → occupancy fails closed.
    ledger.record("intruder", {
      def: { cmd: "claude", kind: "agent" },
      cwd: wt,
      worktree: { path: wt, branch: "tachyon/d", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "t0" },
      declared: false,
      delivery: { deliveryId: "d-exact", segmentId: "seg-intruder", executionNonce: "other" },
    });
    const dupSnap = reconcileDeliveryReload({
      deliveries: listed.filter((d) => d.id === "d-exact"),
      linkedProjections: linkedProjections.filter((p) => p.deliveryId === "d-exact"),
      sessions: new SessionLedger(root).all(),
      processByAgent: new Map([["holder", exactObs]]),
    });
    expect(dupSnap.byId.get("d-exact")?.class).toBe("unavailable");
    expect(dupSnap.byId.get("d-exact")?.reason).toMatch(/duplicate session bindings/);

    const occ = await (manager as unknown as {
      findLedgerWorktreeOccupant: (p: string) => Promise<{ agent: string; state: "live" | "dead" } | undefined>;
    }).findLedgerWorktreeOccupant(wt);
    expect(occ?.state).toBe("dead"); // dirty/unavailable, never free

    // Gone process → unavailable (not free).
    const goneSnap = reconcileDeliveryReload({
      deliveries: listed.filter((d) => d.id === "d-exact"),
      linkedProjections: linkedProjections.filter((p) => p.deliveryId === "d-exact"),
      sessions: new SessionLedger(root).all(),
      processByAgent: new Map([["holder", { state: "gone" }]]),
    });
    expect(goneSnap.byId.get("d-exact")?.class).toBe("unavailable");

    // Duplicate linked projections fail closed (no last-wins).
    const dualProjSnap = reconcileDeliveryReload({
      deliveries: listed.filter((d) => d.id === "d-exact"),
      linkedProjections: [
        { gitDeliveryId: "gd-exact", deliveryId: "d-exact", worktreePath: wt },
        { gitDeliveryId: "gd-exact-dup", deliveryId: "d-exact", worktreePath: path.join(root, "wt-other") },
      ],
      sessions: new Map([["holder", new SessionLedger(root).get("holder")!]]),
      processByAgent: new Map([["holder", exactObs]]),
    });
    expect(dualProjSnap.byId.get("d-exact")?.class).toBe("unavailable");

    // Free without stale binding is terminal (distinguishable from unavailable).
    const freeDelivery: Delivery = {
      schemaVersion: 1,
      id: "d-free",
      version: 1,
      workspaceId: "ws",
      createdBy: { kind: "system", name: "tachyon" },
      contract: { baseSha: "abc", behaviorTest: "gate", owns: ["src"], taskRef: "tachyon/free" },
      lease: { state: "free", changedAt: now },
      segments: [],
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    const freeSnap = reconcileDeliveryReload({
      deliveries: [freeDelivery],
      linkedProjections: [],
      sessions: new Map(),
      processByAgent: new Map(),
    });
    expect(freeSnap.byId.get("d-free")?.class).toBe("terminal");

    // --- T14 R3 closures (production-backed on real store/ledger/occupancy seams) ---

    // R3-2: deleted canonical worktree cannot reconstruct as held (no path.resolve fallback).
    fs.rmSync(wt, { recursive: true, force: true });
    const deletedWtSnap = reconcileDeliveryReload({
      deliveries: listed.filter((d) => d.id === "d-exact"),
      linkedProjections: linkedProjections.filter((p) => p.deliveryId === "d-exact"),
      sessions: new Map([["holder", new SessionLedger(root).get("holder")!]]),
      processByAgent: new Map([["holder", exactObs]]),
    });
    expect(deletedWtSnap.byId.get("d-exact")?.class).toBe("unavailable");
    expect(deletedWtSnap.byId.get("d-exact")?.reason).toMatch(/does not exist|not realpathable/i);

    // R3-3: grantedHeadSha / principal drift force unavailable without principal inference.
    const headDrifted: Delivery = {
      ...listed.find((d) => d.id === "d-exact")!,
      lease: {
        state: "held",
        holder: {
          segmentId: "seg-exact",
          executionAgent: "holder",
          principal: "holder",
          process: { pid: 4242, processStart: "777", bootId: "boot-exact" },
          executionNonce: "nonce-exact",
        },
        expectedHeadSha: "abc",
        changedAt: now,
      },
      segments: [{
        id: "seg-exact",
        index: 0,
        role: "implementer",
        executionAgent: "holder",
        principal: "holder",
        grantedBy: { kind: "system", name: "tachyon" },
        ownsSubset: ["src"],
        grantedHeadSha: "DIFFERENT",
        grantedAt: now,
      }],
    };
    // Recreate worktree so head-drift is the sole failure (not missing path).
    fs.mkdirSync(wt, { recursive: true });
    const headSnap = reconcileDeliveryReload({
      deliveries: [headDrifted],
      linkedProjections: [{ gitDeliveryId: "gd-exact", deliveryId: "d-exact", worktreePath: wt }],
      sessions: new Map([["holder", {
        ...new SessionLedger(root).get("holder")!,
        cwd: wt,
        worktree: { path: wt, branch: "tachyon/d", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "t0" },
      }]]),
      processByAgent: new Map([["holder", exactObs]]),
    });
    expect(headSnap.byId.get("d-exact")?.class).toBe("unavailable");
    expect(headSnap.byId.get("d-exact")?.reason).toMatch(/grantedHeadSha/i);

    const prinDrifted: Delivery = {
      ...headDrifted,
      lease: {
        state: "held",
        holder: {
          segmentId: "seg-exact",
          executionAgent: "holder",
          principal: "alice",
          process: { pid: 4242, processStart: "777", bootId: "boot-exact" },
          executionNonce: "nonce-exact",
        },
        expectedHeadSha: "abc",
        changedAt: now,
      },
      segments: [{
        id: "seg-exact",
        index: 0,
        role: "implementer",
        executionAgent: "holder",
        principal: "bob",
        grantedBy: { kind: "system", name: "tachyon" },
        ownsSubset: ["src"],
        grantedHeadSha: "abc",
        grantedAt: now,
      }],
    };
    const prinSnap = reconcileDeliveryReload({
      deliveries: [prinDrifted],
      linkedProjections: [{ gitDeliveryId: "gd-exact", deliveryId: "d-exact", worktreePath: wt }],
      sessions: new Map([["holder", {
        ...new SessionLedger(root).get("holder")!,
        cwd: wt,
        worktree: { path: wt, branch: "tachyon/d", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "t0" },
      }]]),
      processByAgent: new Map([["holder", exactObs]]),
    });
    expect(prinSnap.byId.get("d-exact")?.class).toBe("unavailable");
    expect(prinSnap.byId.get("d-exact")?.reason).toMatch(/principal/i);

    // R3-4: cwd-drifted bound row still occupies the worktree path (dirty, blocks reuse).
    const driftRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t14-r3-drift-"));
    dirs.push(driftRoot);
    const deliveryWt = path.join(driftRoot, "delivery-wt");
    const driftedCwd = path.join(driftRoot, "elsewhere");
    fs.mkdirSync(deliveryWt, { recursive: true });
    fs.mkdirSync(driftedCwd, { recursive: true });
    const driftLedger = new SessionLedger(driftRoot);
    driftLedger.record("drifter", {
      def: { cmd: "claude", kind: "agent" },
      cwd: driftedCwd,
      worktree: { path: deliveryWt, branch: "tachyon/d", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "t0" },
      declared: false,
      delivery: { deliveryId: "d-drift", segmentId: "seg-d", executionNonce: "n-d" },
    });
    const driftManager = new AgentManager({
      tmux: new TmuxService(exec),
      wsHash: workspaceHash(driftRoot),
      workspaceRoot: driftRoot,
      getConfig: () => parseConfig("agents: {}\n").config!,
      getMaxAgents: () => 8,
      ledger: driftLedger,
      fileExists: () => true,
    });
    // Public occupancy path (not private helper alone).
    const publicOcc = await driftManager.worktreeOccupant(deliveryWt);
    expect(publicOcc?.state).toBe("dirty");
    expect(publicOcc?.agent).toBe("drifter");

    // R3-1: planResume fail-closed when snapshot is not ready.
    const notReadyPlan = planResume({
      ledger: new SessionLedger(root).all(),
      declaredAutostart: new Set(["crash-holder", "ghost", "holder"]),
      liveSessions: new Set(),
      deliveryReloadSnapshotReady: false,
    });
    expect(notReadyPlan).toEqual([]);
  });

  it("T14 R4 factory completes bounded reload so healthy pre-start generic spawn works", async () => {
    // Production ensureWorkspaceFor path: create without start must not leave uninitialized.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t14-r4-prestart-"));
    dirs.push(root);
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "t14-r4-storage-"));
    dirs.push(storage);
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      "agents:\n  prestart:\n    cmd: claude\n  ordinary:\n    cmd: sh\n",
      "utf8",
    );

    class FakeHost implements EngineHost {
      readonly notices: { message: string; level: NotifyLevel }[] = [];
      t = (message: string, ...args: (string | number | boolean)[]): string =>
        message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
      notify(message: string, level: NotifyLevel = "info", _actions?: NoticeAction[]): void {
        this.notices.push({ message, level });
      }
      focusPrimaryView(): void {}
      openTask(): void {}
      executeCommand(): Promise<unknown> {
        return Promise.reject(new Error("unexpected host command"));
      }
      watch(_root: string, _glob: string, _events: WatchEvents, _onEvent: () => void): { dispose(): void } {
        return { dispose() {} };
      }
      getSetting<T>(_section: string, _key: string, dflt: T): T {
        return dflt;
      }
      globalStoragePath(): string {
        return storage;
      }
      getState<T>(): T | undefined {
        return undefined;
      }
      setState(): void {}
      getSecret(): Promise<string | undefined> {
        return Promise.resolve(undefined);
      }
      setSecret(): Promise<void> {
        return Promise.resolve();
      }
      appVersion(): string {
        return "0.0.0-test";
      }
      mediaPath(...segments: string[]): string {
        return path.join(storage, ...segments);
      }
      webviewRoot(): unknown {
        return undefined;
      }
      onViewsChanged(_view: ViewKind): void {}
    }

    const sessions = new Set<string>();
    const exec = async (args: string[]): Promise<ExecResult> => {
      if (args.includes("new-session")) {
        sessions.add(args[args.indexOf("-s") + 1]);
        return { stdout: "", stderr: "" };
      }
      if (args[2] === "has-session") {
        const t = args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
        if (!sessions.has(t)) throw new Error("no session");
        return { stdout: "", stderr: "" };
      }
      if (args[2] === "list-panes") {
        return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
      }
      if (args[2] === "list-sessions") {
        return { stdout: [...sessions].join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
      }
      if (args[2] === "kill-session") {
        const t = args[args.indexOf("-t") + 1].replace(/^=/, "");
        sessions.delete(t);
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };

    const ws = await Workspace.createForTest(
      root,
      { host: new FakeHost(), onViewsChanged: () => {} },
      { tmux: new TmuxService(exec), startBridge: false },
    );
    // No start() — factory must already be ready (empty healthy stores).
    expect(ws.deliveryReloadPhase()).toBe("ready");
    expect(ws.deliveryReloadPhase()).not.toBe("uninitialized");
    expect(ws.deliveryReloadState()).toBeDefined();
    await expect(ws.manager.spawn("prestart")).resolves.toBeUndefined();
    expect(await ws.manager.runningAgents()).toContain("prestart");
    ws.dispose();
  });
});
