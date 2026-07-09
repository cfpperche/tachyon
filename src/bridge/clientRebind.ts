/**
 * spec 364 — Bridge-client rebind coordinator (Phase 1).
 *
 * After the extension host reloads, surviving tmux agents keep valid 351 tokens but their
 * in-process MCP clients are half-open. This module owns the durable bridge generation,
 * reconstructs suspects from the session ledger, and under default `auto` runs a governed
 * stop → wait-dead → hard-kill-if-needed → resume rebind. No peer tool; no cold spawn.
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

export type RebindReason = "host_generation_bump" | "peer_request";

export interface RebindAuditEvent {
  at: string;
  agent: string;
  reason: RebindReason;
  fromGeneration: number;
  toGeneration?: number;
  phase: string;
  finalState?: ClientRebindState;
  error?: string;
  hardKill?: boolean;
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
  /** Entry kind — terminal-kind is never a rebind candidate. */
  kindOf: (name: string) => "agent" | "terminal";
  /** Still RUNNING? (preflight + wait loops). */
  isRunning: (name: string) => Promise<boolean>;
  stopGracefully: (name: string) => Promise<void>;
  /** Hard kill the tmux session WITHOUT wiping ledger/adhoc (unlike AgentManager.kill). */
  hardKillSession: (name: string) => Promise<void>;
  /**
   * Resume via existing sidebar rules. MUST call resume (not cold spawn).
   * Receives the pre-stop ledger snapshot so a race cannot drop the row.
   */
  resume: (name: string, record: SessionRecord) => Promise<void>;
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
 * Pure predicate: is this ledger row a Bridge-wired rebind candidate at generation G?
 * (Running/kind checks are applied by the coordinator at mark and preflight time.)
 */
export function isWiredSuspect(rec: SessionRecord | undefined, generation: number): boolean {
  if (!rec?.bridgeClient?.wired) return false;
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
    const suspects = await this.markSuspects(G);
    if (suspects.length === 0) return;

    if (settings.onHostGenerationBump === "notify") {
      this.deps.notify(
        `Bridge client rebind: ${suspects.length} wired survivor(s) marked suspect after host generation ${G} (policy: notify)`,
        "info",
      );
      return;
    }

    // auto — await drain so callers (and unit tests) observe completion; Workspace fire-and-forgets this.
    await this.scheduleEnqueue(suspects, G, "host_generation_bump", settings.graceMs);
  }

  /**
   * Reconstruct `suspect` from durable ledger + currently running agents.
   * Skips terminal-kind, non-wired, already at/above G, and agents already rebinding
   * (those get pending_recheck only).
   */
  async markSuspects(G: number): Promise<string[]> {
    const running = await this.deps.listRunning();
    const marked: string[] = [];
    for (const name of running) {
      if (this.deps.kindOf(name) !== "agent") continue;
      const rec = this.deps.getLedger(name);
      if (!isWiredSuspect(rec, G)) continue;

      const rt = this.ensure(name);
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
      await this.enqueueStillSuspect(names, G, reason);
      await this.drain();
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
        continue;
      }
      // Re-check durable stamp — manual resume may have healed.
      if (!isWiredSuspect(this.deps.getLedger(name), G)) {
        rt.clientState = "ok";
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
    const pre = await this.preflight(name, suspectG);
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
      return;
    }

    const rt = this.ensure(name);
    rt.clientState = "rebinding";
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
      await this.deps.resume(name, record);

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
  ): Promise<{ ok: true } | { ok: false; reason: string; state: ClientRebindState }> {
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
    // Still require bound < G (durable); suspectG is informational.
    if (rt.suspectGeneration !== undefined && rt.suspectGeneration > G) {
      // Shouldn't happen; treat as skip.
      return { ok: false, reason: "suspect generation ahead of current", state: rt.clientState };
    }
    void suspectG;
    return { ok: true };
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
