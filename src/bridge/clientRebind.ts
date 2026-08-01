/**
 * spec 364 — Bridge-client rebind coordinator (Phase 1).
 *
 * After a real persistent-engine incarnation change, surviving tmux agents keep valid 351 tokens
 * but their in-process MCP clients are half-open. This module owns the durable bridge generation,
 * reconstructs suspects from the session ledger, and under default `auto` runs a governed
 * stop → wait-dead → hard-kill-if-needed → resume rebind (reconnect only; resume default is
 * injectPrimer:false for all callers — t-762940 / 2026-07-14). No peer tool; no cold spawn.
 *
 * Host-agnostic: all side effects go through injected ports (no vscode imports).
 */

import fs from "node:fs";
import path from "node:path";
import { durableBoundGeneration, type SessionRecord } from "../resume/SessionLedger.js";

export type BridgeClientRebindPolicy = "auto" | "notify" | "off";

export type ClientRebindState = "ok" | "suspect" | "rebinding" | "failed" | "cancelled";

export interface BridgeClientRebindSettings {
  onHostGenerationBump: BridgeClientRebindPolicy;
  graceMs: number;
  stopTimeoutMs: number;
  maxConcurrentRebinds: number;
  circuitFailCount: number;
}

export const DEFAULT_BRIDGE_CLIENT_REBIND: BridgeClientRebindSettings = {
  onHostGenerationBump: "auto",
  graceMs: 0,
  stopTimeoutMs: 15_000,
  maxConcurrentRebinds: 1,
  circuitFailCount: 3,
};

/** A replacement that exits during startup is not a successful rebind.  This is intentionally
 * process-liveness only: it catches immediate CLI/config/auth exits without inventing a runtime UI
 * classifier. */
const POST_RESUME_STABILITY_MS = 1_500;

/** A new engine incarnation can become Bridge-ready a fraction before tmux's restored-session
 * inventory is complete.  This is not a client self-heal grace period: it is one bounded
 * inventory settle before the authoritative second scan. */
const HOST_INVENTORY_SETTLE_MS = 100;

/** t-016e8b: a cold-boot tmux read can fail ambiguously (null) while the server is still
 * settling after an engine upgrade — and a single 100ms rescan lost that race, leaving
 * survivors with half-open MCP clients until the NEXT generation bump. Rescan with backoff
 * while the read stays ambiguous; the first confirmed inventory (empty or not) ends the loop. */
const INVENTORY_RESCAN_DELAYS_MS = [HOST_INVENTORY_SETTLE_MS, 1_000, 5_000, 15_000];

/** A young capture-runtime survivor may publish its resumable session shortly after the new engine
 * starts.  Wait only at the non-destructive preflight boundary; never extend teardown timeouts. */
const RESUME_READINESS_WAIT_MS = 5_000;
const RESUME_READINESS_POLL_MS = 100;
const RESUME_READINESS_MAX_ATTEMPTS = Math.ceil(RESUME_READINESS_WAIT_MS / RESUME_READINESS_POLL_MS) + 1;

export type RebindReason = "host_generation_bump" | "peer_request";

export type RebindResumeReadiness =
  | { kind: "ready" }
  | { kind: "retry"; reason: string }
  | { kind: "denied"; reason: string };

export interface RebindAuditEvent {
  at: string;
  /** Agent name, or "*" for a whole-inventory scan event. */
  agent: string;
  reason: RebindReason;
  fromGeneration: number;
  toGeneration?: number;
  phase: string;
  finalState?: ClientRebindState;
  error?: string;
  hardKill?: boolean;
  attempts?: number;
  waitedMs?: number;
  /** phase "scan": running inventory size, or null when the tmux read was ambiguous. */
  running?: number | null;
  /** phase "scan": how many agents this scan newly marked suspect. */
  marked?: number;
}

export interface BridgeClientRebindDeps {
  workspaceHash: string;
  bridgeInstanceId: string;
  getState: <T>(key: string) => T | undefined;
  setState: (key: string, value: unknown) => void;
  /** Durable session row (ledger); may be undefined for unknown names. */
  getLedger: (name: string) => SessionRecord | undefined;
  /** Currently running managed names (alive process, not dead pane). */
  listRunning: () => Promise<string[]>;
  /** t-016e8b: like listRunning, but reports an ambiguous tmux read as null instead of a
   * (possibly cold-empty) cached snapshot, so boot-time scans can retry rather than trust it.
   * Optional — when absent, scans fall back to listRunning and treat its result as authoritative. */
  listRunningStrict?: () => Promise<string[] | null>;
  /** Entry kind — terminal-kind is never a rebind candidate. */
  kindOf: (name: string) => "agent" | "terminal";
  /** Still RUNNING? (preflight + wait loops). */
  isRunning: (name: string) => Promise<boolean>;
  /** Fresh, read-only proof that the generic resume path is available, retryable, or permanently
   * denied. This must run before any expected-death marker or stop. */
  canResume: (name: string, record: SessionRecord) => Promise<RebindResumeReadiness>;
  stopGracefully: (name: string) => Promise<void>;
  /** Hard kill the tmux session WITHOUT wiping ledger/Temporary state (unlike AgentManager.kill). */
  hardKillSession: (name: string) => Promise<void>;
  /**
   * Resume via existing sidebar rules. MUST call resume (not cold spawn).
   * Receives the pre-stop ledger snapshot so a race cannot drop the row.
   * Resume defaults to injectPrimer:false for all callers; rebind still passes false explicitly.
   */
  resume: (name: string, record: SessionRecord, opts?: { injectPrimer?: boolean; deferBridgeStamp?: boolean }) => Promise<void>;
  /**
   * Stamp durable bridgeClient on the ledger at resume-time generation.
   * Called after a successful resume (AgentManager also stamps on ordinary spawn/resume).
   */
  stampBridgeClient: (name: string, generation: number) => void;
  /** Suppress parent death-poke / crash UX for intentional rebind teardown. */
  markExpectedDeath: (name: string) => void;
  notify: (message: string, level: "info" | "warn" | "error") => void;
  deliverNotice?: (name: string, line: string) => Promise<unknown>;
  getSettings: () => BridgeClientRebindSettings;
  /** Absolute path for append-only JSONL audit log. */
  auditPath: string;
  /** Best-effort name of the agent that triggered reloadWindow (359 initiator), if known. */
  getReloadInitiator?: () => string | undefined;
  /** Clear initiator after notice (optional). */
  clearReloadInitiator?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface AgentRuntime {
  clientState: ClientRebindState;
  suspectGeneration?: number;
  pendingRecheck: boolean;
  queued: boolean;
}

interface QueueItem {
  name: string;
  generation: number;
  reason: RebindReason;
  enqueuedAt: number;
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Host-state key for the durable monotonic generation (single owner per workspace+instance). */
export function bridgeGenerationStateKey(workspaceHash: string, bridgeInstanceId: string): string {
  return `tachyon.bridgeClient.generation.${workspaceHash}.${bridgeInstanceId}`;
}

export function reloadInitiatorStateKey(workspaceHash: string): string {
  return `tachyon.bridgeClient.reloadInitiator.${workspaceHash}`;
}

export function parseBridgeClientRebindSettings(raw: unknown): BridgeClientRebindSettings {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_BRIDGE_CLIENT_REBIND };
  const o = raw as Record<string, unknown>;
  const out: BridgeClientRebindSettings = { ...DEFAULT_BRIDGE_CLIENT_REBIND };
  if (o.onHostGenerationBump === "auto" || o.onHostGenerationBump === "notify" || o.onHostGenerationBump === "off") {
    out.onHostGenerationBump = o.onHostGenerationBump;
  }
  if (typeof o.graceMs === "number" && Number.isFinite(o.graceMs) && o.graceMs >= 0) {
    out.graceMs = Math.floor(o.graceMs);
  }
  if (typeof o.stopTimeoutMs === "number" && Number.isFinite(o.stopTimeoutMs) && o.stopTimeoutMs >= 0) {
    out.stopTimeoutMs = Math.floor(o.stopTimeoutMs);
  }
  if (typeof o.maxConcurrentRebinds === "number" && Number.isInteger(o.maxConcurrentRebinds) && o.maxConcurrentRebinds >= 1) {
    out.maxConcurrentRebinds = o.maxConcurrentRebinds;
  }
  if (typeof o.circuitFailCount === "number" && Number.isInteger(o.circuitFailCount) && o.circuitFailCount >= 1) {
    out.circuitFailCount = o.circuitFailCount;
  }
  return out;
}

/**
 * Runtimes for which Tachyon's spawn path materializes the Bridge (withRuntimeBridge /
 * harness fold). Used to infer wiring for pre-364 / never-stamped survivors.
 */
const TACHYON_BRIDGE_RUNTIMES = new Set(["claude", "grok", "opencode", "codex", "hermes"]);

/**
 * Durable stamp preferred; if absent (agents spawned before 364 stamps), infer from
 * resume.runtime / harness / cmd binary. Explicit `wired: false` opts out.
 * (Running/kind checks stay on the coordinator at mark + preflight.)
 */
export function isTachyonBridgeWiredRecord(rec: SessionRecord | undefined): boolean {
  if (!rec) return false;
  if (rec.bridgeClient?.wired === true) return true;
  if (rec.bridgeClient?.wired === false) return false;
  const runtime = rec.resume?.runtime;
  if (runtime && TACHYON_BRIDGE_RUNTIMES.has(runtime)) return true;
  if (rec.def?.harness !== undefined) return true;
  const cmd = rec.def?.cmd?.trim() ?? "";
  if (!cmd) return false;
  const bin = cmd.split(/\s+/)[0]?.replace(/^.*[/\\]/, "") ?? "";
  return TACHYON_BRIDGE_RUNTIMES.has(bin);
}

/**
 * Pure predicate: is this ledger row a Bridge-wired rebind candidate at generation G?
 */
export function isWiredSuspect(rec: SessionRecord | undefined, generation: number): boolean {
  if (!isTachyonBridgeWiredRecord(rec)) return false;
  return durableBoundGeneration(rec) < generation;
}

export class BridgeClientRebindCoordinator {
  private readonly agents = new Map<string, AgentRuntime>();
  private readonly queue: QueueItem[] = [];
  private inFlight = 0;
  private draining = false;
  private circuitOpenForGeneration: number | undefined;
  private failuresThisGeneration = new Map<number, number>();
  private generationBumpGraceTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly deps: BridgeClientRebindDeps) {}

  dispose(): void {
    this.disposed = true;
    if (this.generationBumpGraceTimer) clearTimeout(this.generationBumpGraceTimer);
    this.queue.length = 0;
  }

  /** Current durable generation (0 if never bumped — first ready transition will set 1). */
  getGeneration(): number {
    const v = this.deps.getState<number>(this.generationKey());
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  }

  /**
   * At most one increment per listener-ready transition. Starts at 1 if absent.
   * Returns the new generation G.
   */
  bumpGeneration(): number {
    const prev = this.getGeneration();
    const next = prev < 1 ? 1 : prev + 1;
    this.deps.setState(this.generationKey(), next);
    this.failuresThisGeneration.set(next, 0);
    this.circuitOpenForGeneration = undefined;
    return next;
  }

  /**
   * Called once after Bridge is ready AND recoverPendingHostActionReload has finished.
   * Bumps generation, reconstructs suspects from durable ledger + running set, applies policy.
   */
  async onListenerReady(): Promise<void> {
    if (this.disposed) return;
    const settings = this.deps.getSettings();
    if (settings.onHostGenerationBump === "off") {
      // Still bump so stamps advance and future enable sees a coherent generation? Spec: policy off
      // → no mark/act on generation bumps. Do not bump under off so re-enabling later does one intentional bump.
      return;
    }
    const G = this.bumpGeneration();
    const inventory = await this.readInventory();
    const suspects = await this.markSuspects(G, inventory ?? undefined);
    this.auditScan(G, "host_generation_bump", inventory, suspects.length);

    if (settings.onHostGenerationBump === "notify") {
      if (suspects.length > 0) {
        this.deps.notify(
          `Bridge client rebind: ${suspects.length} wired survivor(s) marked suspect after host generation ${G} (policy: notify)`,
          "info",
        );
      }
      return;
    }

    // auto — await drain so callers (and unit tests) observe completion; Workspace fire-and-forgets this.
    await this.scheduleEnqueue(suspects, G, "host_generation_bump", settings.graceMs);
  }

  /**
   * Reconstruct `suspect` from durable ledger + currently running agents.
   * Skips terminal-kind, non-wired, already at/above G, and agents already rebinding
   * (those get pending_recheck only).
   * @param runningArg pre-read inventory (backoff scans read once and share); falls back to listRunning.
   */
  async markSuspects(G: number, runningArg?: string[]): Promise<string[]> {
    const running = runningArg ?? (await this.deps.listRunning());
    const marked: string[] = [];
    for (const name of running) {
      if (this.deps.kindOf(name) !== "agent") continue;
      const rec = this.deps.getLedger(name);
      if (!isWiredSuspect(rec, G)) continue;

      const rt = this.ensure(name);
      // A second scan must discover survivors omitted by the first tmux snapshot without
      // undoing an explicit stop/manual-heal decision already made for this generation.
      if (rt.suspectGeneration === G) continue;
      if (rt.clientState === "rebinding") {
        rt.pendingRecheck = true;
        continue;
      }
      rt.clientState = "suspect";
      rt.suspectGeneration = G;
      rt.pendingRecheck = false;
      marked.push(name);
    }
    return marked;
  }

  /**
   * User (or kill_agent) stopped an agent while it was suspect/queued — never resurrect.
   * No-op when the stop is our own rebind teardown (state already `rebinding`).
   */
  onAgentStopped(name: string): void {
    const rt = this.agents.get(name);
    if (!rt) return;
    if (rt.clientState === "rebinding") return; // our own stop path
    if (rt.clientState === "suspect" || rt.queued) {
      rt.clientState = "cancelled";
      rt.queued = false;
      this.removeFromQueue(name);
    }
  }

  /**
   * A successful ordinary spawn/restart/resume created a new process incarnation. Only a cancellation belongs
   * exclusively to the prior incarnation; `rebinding` must survive because the coordinator's own resume invokes
   * the same onSpawned hook before runOne finalizes the transition to ok/failed.
   */
  onNewIncarnation(name: string): void {
    const rt = this.agents.get(name);
    if (!rt || rt.clientState !== "cancelled") return;
    this.removeFromQueue(name);
    rt.clientState = "ok";
    rt.suspectGeneration = undefined;
    rt.pendingRecheck = false;
  }

  /**
   * Grace-clear: authenticated self Bridge call against current generation while suspect.
   * Only agent-token identity matching `name` should call this (Workspace/Bridge resolve).
   */
  onAuthenticatedSelfCall(name: string): void {
    const G = this.getGeneration();
    const rt = this.agents.get(name);
    if (!rt || rt.clientState !== "suspect" || rt.suspectGeneration !== G) return;
    rt.clientState = "ok";
    rt.queued = false;
    this.removeFromQueue(name);
  }

  /** Test/debug: runtime state for an agent. */
  getClientState(name: string): ClientRebindState | undefined {
    return this.agents.get(name)?.clientState;
  }

  /** Test/debug: queue names in order. */
  queueSnapshot(): string[] {
    return this.queue.map((q) => q.name);
  }

  /** Test/debug: circuit open for generation? */
  isCircuitOpen(generation?: number): boolean {
    const G = generation ?? this.getGeneration();
    return this.circuitOpenForGeneration === G;
  }

  private generationKey(): string {
    return bridgeGenerationStateKey(this.deps.workspaceHash, this.deps.bridgeInstanceId);
  }

  /** Strict inventory when wired (null = ambiguous read, retry-worthy); listRunning otherwise. */
  private async readInventory(): Promise<string[] | null> {
    if (this.deps.listRunningStrict) return this.deps.listRunningStrict();
    return this.deps.listRunning();
  }

  /** t-016e8b: every suspect scan leaves an audit line — an empty or ambiguous inventory at a
   * generation bump must be diagnosable after the fact, never silent. */
  private auditScan(G: number, reason: RebindReason, inventory: string[] | null, marked: number): void {
    this.audit({
      at: new Date((this.deps.now ?? Date.now)()).toISOString(),
      agent: "*",
      reason,
      fromGeneration: G,
      phase: "scan",
      running: inventory === null ? null : inventory.length,
      marked,
    });
  }

  private ensure(name: string): AgentRuntime {
    let rt = this.agents.get(name);
    if (!rt) {
      rt = { clientState: "ok", pendingRecheck: false, queued: false };
      this.agents.set(name, rt);
    }
    return rt;
  }

  private scheduleEnqueue(names: string[], G: number, reason: RebindReason, graceMs: number): Promise<void> {
    if (this.generationBumpGraceTimer) {
      clearTimeout(this.generationBumpGraceTimer);
      this.generationBumpGraceTimer = undefined;
    }
    const run = async (): Promise<void> => {
      this.generationBumpGraceTimer = undefined;
      if (this.disposed) return;
      // Default grace remains zero.  An alive session missed by the activation-time snapshot
      // must not keep its half-open MCP client forever — and a cold-boot tmux read can be
      // ambiguous (null), so one fixed settle is not enough (t-016e8b).  Rescan on the bounded
      // backoff schedule while the read stays ambiguous; the first CONFIRMED inventory — empty
      // or not — ends the loop (a confirmed zero-agent boot must not burn the whole schedule).
      // Each scan is audited, so an all-empty or all-ambiguous bump is never silent.
      const all = new Set(names);
      for (let i = 0; i < INVENTORY_RESCAN_DELAYS_MS.length; i++) {
        // A configured positive grace already provided the first settle window.
        const delay = i === 0 && graceMs > 0 ? 0 : INVENTORY_RESCAN_DELAYS_MS[i]!;
        if (delay > 0) await (this.deps.sleep ?? sleepDefault)(delay);
        if (this.disposed) return;
        const inventory = await this.readInventory();
        const lateSuspects = await this.markSuspects(G, inventory ?? undefined);
        for (const name of lateSuspects) all.add(name);
        this.auditScan(G, reason, inventory, lateSuspects.length);
        if (all.size > 0) {
          await this.enqueueStillSuspect([...all], G, reason);
          await this.drain();
        }
        if (inventory !== null) return;
      }
    };
    if (graceMs <= 0) return run();
    return new Promise((resolve) => {
      this.generationBumpGraceTimer = setTimeout(() => {
        void run().then(resolve, resolve);
      }, graceMs);
    });
  }

  private async enqueueStillSuspect(names: string[], G: number, reason: RebindReason): Promise<void> {
    const initiator = this.deps.getReloadInitiator?.();
    const still: string[] = [];
    for (const name of names) {
      const rt = this.agents.get(name);
      if (!rt || rt.clientState !== "suspect" || rt.suspectGeneration !== G) continue;
      if (!(await this.deps.isRunning(name))) {
        rt.clientState = "cancelled";
        this.audit({
          at: new Date((this.deps.now ?? Date.now)()).toISOString(),
          agent: name,
          reason,
          fromGeneration: G,
          phase: "enqueue_skip",
          finalState: "cancelled",
          error: "not running (exited before rebind)",
        });
        continue;
      }
      // Re-check durable stamp — manual resume may have healed.
      if (!isWiredSuspect(this.deps.getLedger(name), G)) {
        rt.clientState = "ok";
        this.audit({
          at: new Date((this.deps.now ?? Date.now)()).toISOString(),
          agent: name,
          reason,
          fromGeneration: G,
          phase: "enqueue_skip",
          finalState: "ok",
          error: "already bound to current generation",
        });
        continue;
      }
      still.push(name);
    }
    // Order: non-initiators first (stable name sort), initiator last if known.
    still.sort((a, b) => {
      if (initiator) {
        if (a === initiator && b !== initiator) return 1;
        if (b === initiator && a !== initiator) return -1;
      }
      return a.localeCompare(b);
    });
    const now = (this.deps.now ?? Date.now)();
    for (const name of still) {
      if (this.queue.some((q) => q.name === name)) continue;
      const rt = this.ensure(name);
      rt.queued = true;
      this.queue.push({ name, generation: G, reason, enqueuedAt: now });
    }
  }

  private removeFromQueue(name: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.name === name) this.queue.splice(i, 1);
    }
    const rt = this.agents.get(name);
    if (rt) rt.queued = false;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) return;
    this.draining = true;
    try {
      const settings = this.deps.getSettings();
      while (!this.disposed && this.queue.length > 0) {
        const G = this.getGeneration();
        if (this.circuitOpenForGeneration === G) break;
        while (this.inFlight >= settings.maxConcurrentRebinds) {
          await (this.deps.sleep ?? sleepDefault)(25);
          if (this.disposed) return;
        }
        const item = this.queue.shift();
        if (!item) break;
        const rt = this.agents.get(item.name);
        if (rt) rt.queued = false;
        this.inFlight++;
        try {
          await this.runOne(item);
        } finally {
          this.inFlight--;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async runOne(item: QueueItem): Promise<void> {
    const { name, generation: suspectG, reason } = item;
    const settings = this.deps.getSettings();
    const sleep = this.deps.sleep ?? sleepDefault;
    const now = this.deps.now ?? Date.now;

    // ── Preflight ──────────────────────────────────────────────────────────
    const pre = await this.preflight(name, suspectG, reason);
    if (!pre.ok) {
      this.audit({
        at: new Date(now()).toISOString(),
        agent: name,
        reason,
        fromGeneration: suspectG,
        phase: "preflight_skip",
        finalState: pre.state,
        error: pre.reason,
      });
      if (pre.state === "failed") {
        this.deps.notify(`Bridge client rebind of '${name}' skipped before stop: ${pre.reason} (agent left running)`, "error");
      }
      return;
    }
    if (this.disposed) return;

    const rt = this.ensure(name);
    const ledgerSnapshot = this.deps.getLedger(name);
    if (!ledgerSnapshot) {
      rt.clientState = "failed";
      this.audit({
        at: new Date(now()).toISOString(),
        agent: name,
        reason,
        fromGeneration: suspectG,
        phase: "preflight_skip",
        finalState: "failed",
        error: "no ledger record for resume",
      });
      this.deps.notify(`Bridge client rebind of '${name}' failed: no ledger record (left stopped; no cold spawn)`, "error");
      this.noteFailure(suspectG);
      return;
    }
    rt.clientState = "rebinding";

    this.audit({
      at: new Date(now()).toISOString(),
      agent: name,
      reason,
      fromGeneration: suspectG,
      phase: "preflight_ok",
    });

    let hardKill = false;
    try {
      // ── Expected death + graceful stop ───────────────────────────────────
      this.deps.markExpectedDeath(name);
      try {
        await this.deps.stopGracefully(name);
        this.audit({
          at: new Date(now()).toISOString(),
          agent: name,
          reason,
          fromGeneration: suspectG,
          phase: "stop",
        });
      } catch (err) {
        // Process may already be half-dead; continue to wait/hard-kill.
        this.audit({
          at: new Date(now()).toISOString(),
          agent: name,
          reason,
          fromGeneration: suspectG,
          phase: "stop",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // ── Wait until dead ──────────────────────────────────────────────────
      // Poll with a real delay budget; also cap iterations so a no-op sleep in tests cannot spin forever.
      const deadline = now() + settings.stopTimeoutMs;
      for (let i = 0; i < 10_000 && (await this.deps.isRunning(name)); i++) {
        if (now() >= deadline) break;
        await sleep(Math.min(100, Math.max(1, deadline - now())));
      }

      if (await this.deps.isRunning(name)) {
        hardKill = true;
        this.deps.markExpectedDeath(name);
        await this.deps.hardKillSession(name);
        this.audit({
          at: new Date(now()).toISOString(),
          agent: name,
          reason,
          fromGeneration: suspectG,
          phase: "hard_kill",
          hardKill: true,
        });
        // Brief wait after hard kill
        const hardDeadline = now() + 5_000;
        for (let i = 0; i < 1_000 && (await this.deps.isRunning(name)); i++) {
          if (now() >= hardDeadline) break;
          await sleep(50);
        }
        if (await this.deps.isRunning(name)) {
          throw new Error("session still alive after hard kill");
        }
      } else {
        this.audit({
          at: new Date(now()).toISOString(),
          agent: name,
          reason,
          fromGeneration: suspectG,
          phase: "dead",
        });
      }

      // ── Resume (never cold spawn) ────────────────────────────────────────
      // Re-read ledger in case stop refreshed ownership; fall back to snapshot.
      const record = this.deps.getLedger(name) ?? ledgerSnapshot;
      // AgentManager must not stamp the replacement healthy yet.  Rebind owns that proof and only
      // commits it after the bounded liveness window below.
      await this.deps.resume(name, record, { injectPrimer: false, deferBridgeStamp: true });

      const stableUntil = now() + POST_RESUME_STABILITY_MS;
      for (let i = 0; i < 10_000; i++) {
        if (!(await this.deps.isRunning(name))) throw new Error("replacement exited during post-resume stability window");
        const remaining = stableUntil - now();
        if (remaining <= 0) break;
        await sleep(Math.min(100, remaining));
      }
      if (!(await this.deps.isRunning(name))) throw new Error("replacement exited during post-resume stability window");

      // Stamp at CURRENT generation (may have advanced during rebind).
      const stampG = this.getGeneration();
      this.deps.stampBridgeClient(name, stampG);

      rt.clientState = "ok";
      rt.suspectGeneration = undefined;
      this.audit({
        at: new Date(now()).toISOString(),
        agent: name,
        reason,
        fromGeneration: suspectG,
        toGeneration: stampG,
        phase: "resume_ok",
        finalState: "ok",
        hardKill,
      });

      // 359 initiator notice (best-effort; never forge MCP tool results)
      const initiator = this.deps.getReloadInitiator?.();
      if (initiator && initiator === name && this.deps.deliverNotice) {
        try {
          await this.deps.deliverNotice(
            name,
            "[tachyon] host reload completed and your Bridge client was rebound (the in-flight run_host_action result was lost with the old process)",
          );
        } catch {
          /* best-effort */
        }
        this.deps.clearReloadInitiator?.();
      }

      // pending_recheck: double-bump while rebinding — at most one re-mark after success.
      if (rt.pendingRecheck) {
        rt.pendingRecheck = false;
        const cur = this.getGeneration();
        if (durableBoundGeneration(this.deps.getLedger(name)) < cur) {
          rt.clientState = "suspect";
          rt.suspectGeneration = cur;
          if (this.deps.getSettings().onHostGenerationBump === "auto") {
            // Fire-and-forget: do not nest await of a full drain inside runOne (would deadlock the serial queue).
            void this.scheduleEnqueue([name], cur, "host_generation_bump", 0);
          }
        }
      }
    } catch (err) {
      rt.clientState = "failed";
      const msg = err instanceof Error ? err.message : String(err);
      this.audit({
        at: new Date(now()).toISOString(),
        agent: name,
        reason,
        fromGeneration: suspectG,
        phase: "resume_fail",
        finalState: "failed",
        error: msg,
        hardKill,
      });
      this.deps.notify(`Bridge client rebind of '${name}' failed: ${msg} (left stopped; no cold spawn)`, "error");
      this.noteFailure(suspectG);
    }
  }

  private async preflight(
    name: string,
    suspectG: number,
    reason: RebindReason,
  ): Promise<{ ok: true } | { ok: false; reason: string; state: ClientRebindState }> {
    const sleep = this.deps.sleep ?? sleepDefault;
    const now = this.deps.now ?? Date.now;
    let checked = await this.preflightState(name, suspectG);
    if (!checked.ok) return checked;

    let attempts = 0;
    let waited = false;
    let lastRetryReason = "generic resume target is not ready";
    const startedAt = now();
    const deadline = startedAt + RESUME_READINESS_WAIT_MS;

    while (!this.disposed && attempts < RESUME_READINESS_MAX_ATTEMPTS) {
      attempts++;
      let readiness: RebindResumeReadiness;
      try {
        readiness = await this.deps.canResume(name, checked.record);
      } catch (err) {
        const rt = this.ensure(name);
        rt.clientState = "failed";
        return {
          ok: false,
          reason: `resume preflight failed: ${err instanceof Error ? err.message : String(err)}`,
          state: "failed",
        };
      }

      // Resolution can await filesystem/ownership probes.  Revalidate every destructive prerequisite
      // after it returns; a user stop, manual heal, or generation change must win the race.
      checked = await this.preflightState(name, suspectG);
      if (!checked.ok) return checked;

      if (readiness.kind === "ready") {
        if (waited) {
          this.audit({
            at: new Date(now()).toISOString(),
            agent: name,
            reason,
            fromGeneration: suspectG,
            phase: "preflight_ready",
            attempts,
            waitedMs: Math.max(0, now() - startedAt),
          });
        }
        return { ok: true };
      }

      if (readiness.kind === "denied") {
        const rt = this.ensure(name);
        rt.clientState = "failed";
        return { ok: false, reason: `generic resume denied: ${readiness.reason}`, state: "failed" };
      }

      lastRetryReason = readiness.reason;
      if (!waited) {
        waited = true;
        this.audit({
          at: new Date(now()).toISOString(),
          agent: name,
          reason,
          fromGeneration: suspectG,
          phase: "preflight_wait",
          error: readiness.reason,
          attempts,
          waitedMs: 0,
        });
      }

      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(RESUME_READINESS_POLL_MS, remaining));
      checked = await this.preflightState(name, suspectG);
      if (!checked.ok) return checked;
    }

    if (this.disposed) {
      const rt = this.ensure(name);
      rt.clientState = "cancelled";
      return { ok: false, reason: "coordinator disposed during resume readiness wait", state: "cancelled" };
    }

    const rt = this.ensure(name);
    rt.clientState = "failed";
    const waitedMs = Math.max(0, now() - startedAt);
    const timeoutReason = `generic resume target was not ready within ${RESUME_READINESS_WAIT_MS}ms: ${lastRetryReason}`;
    this.audit({
      at: new Date(now()).toISOString(),
      agent: name,
      reason,
      fromGeneration: suspectG,
      phase: "preflight_timeout",
      finalState: "failed",
      error: timeoutReason,
      attempts,
      waitedMs,
    });
    return { ok: false, reason: timeoutReason, state: "failed" };
  }

  /** Re-check every prerequisite that must hold before rebind may tear down the survivor. */
  private async preflightState(
    name: string,
    suspectG: number,
  ): Promise<
    { ok: true; record: SessionRecord }
    | { ok: false; reason: string; state: ClientRebindState }
  > {
    if (this.disposed) {
      return { ok: false, reason: "coordinator disposed during resume readiness preflight", state: "cancelled" };
    }
    const rt = this.agents.get(name);
    if (!rt) return { ok: false, reason: "not tracked", state: "cancelled" };
    if (rt.clientState === "cancelled") return { ok: false, reason: "cancelled", state: "cancelled" };
    if (rt.clientState !== "suspect") return { ok: false, reason: `state=${rt.clientState}`, state: rt.clientState };

    if (!(await this.deps.isRunning(name))) {
      rt.clientState = "cancelled";
      return { ok: false, reason: "not running (user stop or exited)", state: "cancelled" };
    }

    const G = this.getGeneration();
    // Manual resume already stamped current (or later) generation ⇒ skip.
    if (!isWiredSuspect(this.deps.getLedger(name), G)) {
      rt.clientState = "ok";
      return { ok: false, reason: "already bound to current generation", state: "ok" };
    }
    const record = this.deps.getLedger(name);
    if (!record) {
      rt.clientState = "failed";
      return { ok: false, reason: "no ledger record for resume", state: "failed" };
    }
    // Still require bound < G (durable); suspectG is informational.
    if (rt.suspectGeneration !== undefined && rt.suspectGeneration > G) {
      // Shouldn't happen; treat as skip.
      return { ok: false, reason: "suspect generation ahead of current", state: rt.clientState };
    }
    void suspectG;
    return { ok: true, record };
  }

  private noteFailure(generation: number): void {
    const n = (this.failuresThisGeneration.get(generation) ?? 0) + 1;
    this.failuresThisGeneration.set(generation, n);
    const limit = this.deps.getSettings().circuitFailCount;
    if (n >= limit) {
      this.circuitOpenForGeneration = generation;
      this.deps.notify(
        `Bridge client rebind circuit open after ${n} failures at generation ${generation}; remaining suspects left alone`,
        "error",
      );
    }
  }

  private audit(event: RebindAuditEvent): void {
    try {
      const dir = path.dirname(this.deps.auditPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.deps.auditPath, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      /* never block rebind on audit I/O */
    }
  }
}
