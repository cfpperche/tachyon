import type { PipelineDef, NodeDef } from "./loadPipeline.js";
import { type PipelineRun, initRun, startNode, approveNode, rejectNode, failNode, resetNode, downstreamOf, runStatus, recordHandoff, pruneHandoffs, upstreamHandoffs, type NodeState } from "./runState.js";
import type { NodeSignals } from "./doneContract.js";
import { advance } from "./pipelineDriver.js";
import { sanitizeSummary, type UpstreamHandoff } from "./nodePrompt.js";
import { validateCompleteNode, type CompleteNodeInput, type CompleteNodeVerdict, type NodeAuthState } from "./completeNode.js";
import type { WorktreeRecord } from "../worktree/WorktreeManager.js";

/**
 * spec 230 — the executor. Owns run state + side effects; all the DECISION logic lives in the pure
 * `advance()` driver, so this class is the thin glue + lifecycle (worktree, nonce, timers, persistence).
 * Deps are injected so the orchestration is testable with fakes (no real tmux/git). The real Workspace
 * wiring (AgentManager spawn, runVerify, resolveSpawnCwd override, .tachyon/runs persistence) supplies
 * these deps — that integration + a codex review come next.
 */

export interface SpawnNodeArgs {
  runId: string;
  nodeId: string;
  def: NodeDef;
  cwd: string;
  /** includes TACHYON_RUN_ID / TACHYON_NODE_ID / TACHYON_NODE_NONCE */
  env: Record<string, string>;
  /** spec 231 — the run input snapshot (the issue), if any; the impl composes it into the node prompt. */
  input?: string;
  /** spec 231 — upstream handoff summaries (dependency order, sanitized), for the node prompt. */
  upstream?: UpstreamHandoff[];
}

export interface PipelineDeps {
  /** Allocate a quarantined checkout. `finalizeOwnership` may run only after the initial run record
   * has been persisted; it releases the durable Git preparation receipt. */
  allocateWorktree(runId: string): Promise<{ cwd: string; key: string; worktree: WorktreeRecord; finalizeOwnership: () => Promise<void> }>;
  releaseWorktree(key: string): Promise<void>;
  spawnNode(args: SpawnNodeArgs): Promise<void>;
  runVerify(args: { runId: string; nodeId: string; cwd: string }): Promise<{ passed: boolean; stale: boolean }>;
  mintNonce(): string;
  genRunId(): string;
  /** dismiss a node's agent: kill its session + drop its ledger row. Awaitable so re-run can ensure the
   *  old session is gone before re-spawning under the same name. */
  dismissNode?(runId: string, nodeId: string): void | Promise<void>;
  persist(run: PipelineRun): void;
  /** Required/throwing persistence used by the allocation transaction before any node may spawn. */
  persistInitial(run: PipelineRun): void;
  onChange?(run: PipelineRun): void;
  /** schedule fn after ms; returns a canceller. */
  setTimer(ms: number, fn: () => void): () => void;
}

const key = (runId: string, nodeId: string) => `${runId}/${nodeId}`;
const isTerminal = (s: NodeState["status"]) => s === "done" || s === "failed" || s === "blocked" || s === "awaiting-approval";

export class PipelineManager {
  private runs = new Map<string, PipelineRun>();
  private signals = new Map<string, Record<string, NodeSignals>>();
  private verifyRequested = new Map<string, Set<string>>();
  private nonces = new Map<string, string>(); // runId/nodeId -> nonce
  private timers = new Map<string, () => void>(); // runId/nodeId -> cancel
  private cwd = new Map<string, string>(); // runId -> run worktree cwd
  private wtKey = new Map<string, string>(); // runId -> worktree key
  private spawned = new Set<string>(); // runId/nodeId — a node whose agent was spawned
  private dismissed = new Set<string>(); // runId/nodeId — a node whose agent was already dismissed
  private dismissing = new Map<string, Promise<boolean>>(); // runId/nodeId -> proven runtime teardown

  constructor(private readonly deps: PipelineDeps) {}

  /** Start a new run of `pipeline`. `input` is the run snapshot (spec 231; required pipelines pass it,
   *  ledger-canonical from here on). Returns the run id. */
  async start(pipeline: PipelineDef, input?: string): Promise<string> {
    const runId = this.deps.genRunId();
    const { cwd, key: wtKey, worktree, finalizeOwnership } = await this.deps.allocateWorktree(runId);
    const allocatedRun = initRun(runId, pipeline, wtKey, input, worktree, false);
    try {
      // The run ledger is the crash-durable owner. Never release the allocation receipt merely
      // because an in-memory map exists; a process crash would erase that claim.
      this.deps.persistInitial(allocatedRun);
    } catch (error) {
      const primary = error instanceof Error ? error : new Error(String(error));
      throw new AggregateError(
        [primary, new Error(`pipeline worktree recovery state was preserved at ${cwd}`)],
        `pipeline '${runId}' could not persist ownership; locked recovery checkout: ${cwd}`,
        { cause: primary },
      );
    }
    try {
      await finalizeOwnership();
    } catch (error) {
      const primary = error instanceof Error ? error : new Error(String(error));
      throw new AggregateError(
        [primary, new Error(`pipeline ownership is durable, but its worktree remains locked at ${cwd}`)],
        `pipeline '${runId}' could not finalize its worktree quarantine; locked recovery checkout: ${cwd}`,
        { cause: primary },
      );
    }
    const run: PipelineRun = { ...allocatedRun, worktreeReady: true };
    try {
      // A crash after unlock but before this write reloads the explicit false phase and reconciles
      // it before tick; it can never mistake an unfinalized receipt for an executable run.
      this.deps.persistInitial(run);
    } catch (error) {
      const primary = error instanceof Error ? error : new Error(String(error));
      throw new AggregateError(
        [primary, new Error(`pipeline worktree readiness could not be recorded for ${cwd}`)],
        `pipeline '${runId}' could not persist finalized worktree ownership; recovery checkout: ${cwd}`,
        { cause: primary },
      );
    }
    this.cwd.set(runId, cwd);
    this.wtKey.set(runId, wtKey);
    this.signals.set(runId, {});
    this.verifyRequested.set(runId, new Set());
    this.runs.set(runId, run);
    this.tick(runId);
    return runId;
  }

  /**
   * spec 230 — restore in-memory run state after a VS Code reload, so a node agent that SURVIVED the
   * reload (tmux persists) can still complete_node. Without this, `authLookup` returns null and a
   * legitimate signal is rejected "unknown or closed pipeline run/node" (the dogfood finding). The run
   * graph comes from the run ledger; each running node's nonce/cwd come from the session ledger
   * (persisted in def.env). Re-arms a timeout per running node so a node whose agent did NOT survive
   * still fails closed. Then drives one tick (resumes the chain if the reload landed between nodes).
   */
  rehydrate(restored: Array<{ run: PipelineRun; cwd: string; nonces: Record<string, string> }>): void {
    for (const { run, cwd, nonces } of restored) {
      if (this.runs.has(run.id)) continue; // never clobber a live run
      this.runs.set(run.id, run);
      this.cwd.set(run.id, cwd);
      this.wtKey.set(run.id, run.worktreeKey);
      this.signals.set(run.id, {});
      this.verifyRequested.set(run.id, new Set());
      for (const [nodeId, nonce] of Object.entries(nonces)) {
        const k = key(run.id, nodeId);
        this.nonces.set(k, nonce);
        this.spawned.add(k);
        const def = run.pipeline.nodes[nodeId];
        if (run.nodes[nodeId]?.status === "running" && def) {
          this.timers.set(k, this.deps.setTimer(def.timeoutMs, () => this.onTimeout(run.id, nodeId)));
        }
      }
      this.tick(run.id);
    }
  }

  /** The lookup the Bridge `complete_node` tool authenticates against (codex M1). */
  authLookup = (runId: string, nodeId: string): NodeAuthState | null => {
    const run = this.runs.get(runId);
    if (!run || !run.nodes[nodeId]) return null;
    const nonce = this.nonces.get(key(runId, nodeId));
    if (!nonce) return null;
    return { nonce, status: run.nodes[nodeId].status, alreadySignalled: !!this.signals.get(runId)?.[nodeId]?.signalled };
  };

  /** Wire this as BridgeDeps.completeNode. */
  completeSignal = async (input: CompleteNodeInput): Promise<CompleteNodeVerdict> => {
    const verdict = validateCompleteNode(input, this.authLookup);
    if (verdict.ok) {
      this.setSignal(input.runId, input.nodeId, (s) => (s.signalled = true));
      // spec 231 — record the (untrusted) handoff summary for the next node, sanitized + capped.
      if (typeof input.summary === "string") {
        const clean = sanitizeSummary(input.summary);
        const run = this.runs.get(input.runId);
        if (run && clean) this.runs.set(input.runId, recordHandoff(run, input.nodeId, clean));
      }
      this.tick(input.runId);
    }
    return verdict;
  };

  onProcessExit(runId: string, nodeId: string, code: number): void {
    this.setSignal(runId, nodeId, (s) => {
      s.exitCode = code; // exit-based nodes complete on this
      s.exited = true; // signal-based nodes fail closed if the process died before signalling
    });
    this.tick(runId);
  }
  onSessionEnd(runId: string, nodeId: string): void {
    this.setSignal(runId, nodeId, (s) => (s.exited = true));
    this.tick(runId);
  }
  approve(runId: string, nodeId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.nodes[nodeId]?.status !== "awaiting-approval") return;
    this.runs.set(runId, approveNode(run, nodeId));
    this.tick(runId);
  }
  reject(runId: string, nodeId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.nodes[nodeId]?.status !== "awaiting-approval") return;
    this.runs.set(runId, rejectNode(run, nodeId));
    this.tick(runId);
  }

  getRun(runId: string): PipelineRun | undefined {
    return this.runs.get(runId);
  }

  /** spec 231 — update a live run's input snapshot (the "Edit input" action). Only not-yet-started nodes
   *  read it at spawn; already-spawned nodes are unaffected. Persisted; no-op for an unknown run. */
  setInput(runId: string, input: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const next = { ...run, input };
    this.runs.set(runId, next);
    this.deps.persist(next);
    this.deps.onChange?.(next);
  }

  /** All in-memory runs (for the sidebar). */
  allRuns(): PipelineRun[] {
    return [...this.runs.values()];
  }

  /** Rig/demo hook (the screenshot scene): register a pre-built run so the sidebar renders it, WITHOUT
   *  spawning any agents or worktree. Not used in normal operation. */
  seedRun(run: PipelineRun): void {
    this.runs.set(run.id, run);
    this.deps.onChange?.(run);
  }

  /** Cancel a run: fail every not-yet-finished node (→ downstream blocked), dismiss agents, release. */
  cancel(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    let cur = run;
    for (const nodeId of Object.keys(cur.nodes)) {
      const s = cur.nodes[nodeId].status;
      if (s !== "done" && s !== "failed") cur = failNode(cur, nodeId, "cancelled");
    }
    this.runs.set(runId, cur);
    this.tick(runId); // dismisses terminal spawned nodes (failed → no auto-release)
    void this.finalize(runId); // cancel is an explicit teardown → release the worktree
  }

  // --- internals ---

  private setSignal(runId: string, nodeId: string, mut: (s: NodeSignals) => void): void {
    const map = this.signals.get(runId);
    if (!map) return;
    const s = map[nodeId] ?? (map[nodeId] = {});
    mut(s);
  }

  private onTimeout(runId: string, nodeId: string): void {
    this.setSignal(runId, nodeId, (s) => (s.timedOut = true));
    this.tick(runId);
  }

  /** Synchronous state advance + dispatch of side-effect actions. Marks running/verify-requested
   *  synchronously so a re-entrant tick can't double-spawn or double-verify. */
  private tick(runId: string): void {
    const run0 = this.runs.get(runId);
    if (!run0) return;
    const { run, actions } = advance(run0, this.signals.get(runId) ?? {}, this.verifyRequested.get(runId) ?? new Set());
    let cur = run;

    for (const a of actions) {
      if (a.type === "spawn") {
        const nonce = this.deps.mintNonce();
        this.nonces.set(key(runId, a.nodeId), nonce);
        cur = startNode(cur, a.nodeId); // status=running prevents re-dispatch; `spawned` is set on success
        this.runs.set(runId, cur);
        void this.doSpawn(runId, a.nodeId, nonce);
      } else {
        this.verifyRequested.get(runId)?.add(a.nodeId);
        void this.doVerify(runId, a.nodeId);
      }
    }

    // a node that finished its work: cancel its timeout (incl. at a human gate — never time out a
    // paused approval). DISMISS the agent only once truly done/failed/blocked — keep it ALIVE at
    // `awaiting-approval` so the human can open its terminal and see what they're approving.
    for (const nodeId of Object.keys(cur.nodes)) {
      const k = key(runId, nodeId);
      const status = cur.nodes[nodeId].status;
      if (!isTerminal(status) || !this.spawned.has(k)) continue;
      const cancel = this.timers.get(k);
      if (cancel) {
        cancel();
        this.timers.delete(k);
      }
      if (status !== "awaiting-approval" && !this.dismissed.has(k)) {
        this.beginDismissal(runId, nodeId);
      }
    }

    this.runs.set(runId, cur);
    this.deps.persist(cur);
    this.deps.onChange?.(cur);

    // completed → tear down (release the worktree). FAILED → keep the worktree + run so the human can
    // re-run from a step or dismiss it (Tier A); cancel()/dismiss() release explicitly.
    if (runStatus(cur) === "completed") void this.finalize(runId);
  }

  private async doSpawn(runId: string, nodeId: string, nonce: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    const def = run.pipeline.nodes[nodeId];
    const cwd = this.cwd.get(runId) ?? "";
    try {
      await this.deps.spawnNode({
        runId,
        nodeId,
        def,
        cwd,
        env: { TACHYON_RUN_ID: runId, TACHYON_NODE_ID: nodeId, TACHYON_NODE_NONCE: nonce },
        input: run.input,
        upstream: upstreamHandoffs(run, nodeId),
      });
    } catch (err) {
      // spawn failed (e.g. a declared agent is already running) — fail the node WITHOUT taking
      // ownership, so terminal cleanup never dismisses/kills a contended or human-started session
      // (codex B2). `spawned`/the timeout are armed only on success below.
      this.setSignal(runId, nodeId, (s) => {
        s.exited = true;
        s.exitCode = s.exitCode ?? 1;
      });
      this.tick(runId);
      return;
    }
    // own the session only now that it actually started: eligible for dismissal + timeout.
    this.spawned.add(key(runId, nodeId));
    this.timers.set(
      key(runId, nodeId),
      this.deps.setTimer(def.timeoutMs, () => this.onTimeout(runId, nodeId)),
    );
  }

  private async doVerify(runId: string, nodeId: string): Promise<void> {
    const cwd = this.cwd.get(runId) ?? "";
    try {
      const v = await this.deps.runVerify({ runId, nodeId, cwd });
      this.setSignal(runId, nodeId, (s) => (s.verify = v));
    } catch {
      this.setSignal(runId, nodeId, (s) => (s.verify = { passed: false, stale: false })); // verify error → treat as red
    }
    this.tick(runId);
  }

  /** Start one idempotent terminal-node teardown. A rejected kill never becomes a completed
   * dismissal: finalize keeps the run/worktree receipt and a later explicit retry can try again. */
  private beginDismissal(runId: string, nodeId: string): Promise<boolean> {
    const k = key(runId, nodeId);
    if (this.dismissed.has(k)) return Promise.resolve(true);
    const active = this.dismissing.get(k);
    if (active) return active;
    const attempt = Promise.resolve().then(() => this.deps.dismissNode?.(runId, nodeId)).then(
      () => {
        this.dismissed.add(k);
        this.dismissing.delete(k);
        return true;
      },
      () => {
        this.dismissing.delete(k);
        return false;
      },
    );
    this.dismissing.set(k, attempt);
    return attempt;
  }

  /** Tear down a run: release the run worktree + clear all registries + drop the run from memory.
   *  Called on completion, and explicitly by cancel()/dismiss(). NOT called on a natural failure (the
   *  worktree + run are kept so the human can re-run from a step or dismiss). */
  private async finalize(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    // never release the worktree while a node is still running (defensive; linear MVP shouldn't hit it)
    if (run && Object.values(run.nodes).some((n) => n.status === "running")) return;
    const terminalDismissals = run
      ? Object.keys(run.nodes)
          .filter((nodeId) => this.spawned.has(key(runId, nodeId)) && run.nodes[nodeId].status !== "awaiting-approval")
          .map((nodeId) => this.beginDismissal(runId, nodeId))
      : [];
    if ((await Promise.all(terminalDismissals)).some((dismissed) => !dismissed)) {
      // The durable completed/failed run remains the recovery handle; never release a checkout while
      // a node runtime may still have it as cwd.
      if (run) {
        this.deps.persist(run);
        this.deps.onChange?.(run);
      }
      return;
    }
    const wtKey = this.wtKey.get(runId);
    if (wtKey) {
      try {
        await this.deps.releaseWorktree(wtKey);
      } catch {
        // Removal refusal/failure preserves every map and the durable run for an explicit retry.
        if (run) {
          this.deps.persist(run);
          this.deps.onChange?.(run);
        }
        return;
      }
    }
    for (const [k, cancel] of this.timers) {
      if (k.startsWith(`${runId}/`)) {
        cancel();
        this.timers.delete(k);
      }
    }
    // close the auth + runtime registries (codex S4 M3): a finished run is "unknown/closed" to
    // complete_node, and the maps must not leak across runs. `runs` is kept for getRun() inspection.
    for (const nodeId of run ? Object.keys(run.nodes) : []) {
      const k = key(runId, nodeId);
      this.nonces.delete(k);
      this.spawned.delete(k);
      this.dismissed.delete(k);
      this.dismissing.delete(k);
    }
    this.signals.delete(runId);
    this.verifyRequested.delete(runId);
    this.cwd.delete(runId);
    this.runs.delete(runId); // terminal teardown — the run leaves memory (the def tree shows it idle)
    this.wtKey.delete(runId);
  }

  /** Explicitly tear down a run (the human dismissed a failed/completed run) — releases the worktree. */
  dismiss(runId: string): void {
    void this.finalize(runId);
  }

  /** Tier A — re-run a run from `nodeId`: reset that node + its transitive downstream to pending (kill
   *  their live agents first so a re-spawn doesn't contend), keeping the upstream output in the run
   *  worktree, then re-tick. Only works while the run is alive (paused/failed) — the worktree must exist. */
  async rerunFrom(runId: string, nodeId: string): Promise<void> {
    const run0 = this.runs.get(runId);
    if (!run0 || !run0.nodes[nodeId]) return;
    const reset = [nodeId, ...downstreamOf(run0, nodeId)];
    // kill any live agent among the reset nodes BEFORE re-spawning under the same name (await).
    await Promise.all(reset.map((id) => Promise.resolve(this.deps.dismissNode?.(runId, id))));
    let cur = this.runs.get(runId) ?? run0;
    const sig = this.signals.get(runId) ?? {};
    for (const id of reset) {
      const k = key(runId, id);
      this.nonces.delete(k);
      this.spawned.delete(k);
      this.dismissed.delete(k);
      this.dismissing.delete(k);
      const cancel = this.timers.get(k);
      if (cancel) {
        cancel();
        this.timers.delete(k);
      }
      delete sig[id];
      this.verifyRequested.get(runId)?.delete(id);
      cur = resetNode(cur, id);
    }
    cur = pruneHandoffs(cur, reset); // spec 231 — drop stale handoffs for the reset node + downstream
    this.runs.set(runId, cur);
    this.tick(runId);
  }
}
