import type { PipelineDef, NodeDef } from "./loadPipeline.js";
import { type PipelineRun, initRun, startNode, approveNode, rejectNode, failNode, runStatus, type NodeState } from "./runState.js";
import type { NodeSignals } from "./doneContract.js";
import { advance } from "./pipelineDriver.js";
import { validateCompleteNode, type CompleteNodeInput, type CompleteNodeVerdict, type NodeAuthState } from "./completeNode.js";

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
}

export interface PipelineDeps {
  allocateWorktree(runId: string): Promise<{ cwd: string; key: string }>;
  releaseWorktree(key: string): Promise<void>;
  spawnNode(args: SpawnNodeArgs): Promise<void>;
  runVerify(args: { runId: string; nodeId: string; cwd: string }): Promise<{ passed: boolean; stale: boolean }>;
  mintNonce(): string;
  genRunId(): string;
  /** dismiss a node's agent once the node reaches a terminal state: kill its session + drop its ledger row. */
  dismissNode?(runId: string, nodeId: string): void;
  persist(run: PipelineRun): void;
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

  constructor(private readonly deps: PipelineDeps) {}

  /** Start a new run of `pipeline`. Returns the run id. */
  async start(pipeline: PipelineDef): Promise<string> {
    const runId = this.deps.genRunId();
    const { cwd, key: wtKey } = await this.deps.allocateWorktree(runId);
    this.cwd.set(runId, cwd);
    this.wtKey.set(runId, wtKey);
    this.signals.set(runId, {});
    this.verifyRequested.set(runId, new Set());
    this.runs.set(runId, initRun(runId, pipeline, wtKey));
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
      this.tick(input.runId);
    }
    return verdict;
  };

  onProcessExit(runId: string, nodeId: string, code: number): void {
    this.setSignal(runId, nodeId, (s) => (s.exitCode = code));
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

  /** All in-memory runs (for the sidebar). */
  allRuns(): PipelineRun[] {
    return [...this.runs.values()];
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
    this.tick(runId); // dismisses terminal spawned nodes + finishes (releases the worktree)
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
        this.spawned.add(key(runId, a.nodeId));
        cur = startNode(cur, a.nodeId);
        this.runs.set(runId, cur);
        void this.doSpawn(runId, a.nodeId, nonce);
      } else {
        this.verifyRequested.get(runId)?.add(a.nodeId);
        void this.doVerify(runId, a.nodeId);
      }
    }

    // a node that reached a terminal state: cancel its timer + dismiss its agent (kill session + drop
    // ledger row), once. A node that was never spawned (e.g. `blocked`) has no agent to dismiss.
    for (const nodeId of Object.keys(cur.nodes)) {
      const k = key(runId, nodeId);
      if (!isTerminal(cur.nodes[nodeId].status) || !this.spawned.has(k) || this.dismissed.has(k)) continue;
      this.dismissed.add(k);
      const cancel = this.timers.get(k);
      if (cancel) {
        cancel();
        this.timers.delete(k);
      }
      this.deps.dismissNode?.(runId, nodeId);
    }

    this.runs.set(runId, cur);
    this.deps.persist(cur);
    this.deps.onChange?.(cur);

    const st = runStatus(cur);
    if (st === "completed" || st === "failed") void this.finish(runId);
  }

  private async doSpawn(runId: string, nodeId: string, nonce: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    const def = run.pipeline.nodes[nodeId];
    const cwd = this.cwd.get(runId) ?? "";
    const cancel = this.deps.setTimer(def.timeoutMs, () => this.onTimeout(runId, nodeId));
    this.timers.set(key(runId, nodeId), cancel);
    try {
      await this.deps.spawnNode({
        runId,
        nodeId,
        def,
        cwd,
        env: { TACHYON_RUN_ID: runId, TACHYON_NODE_ID: nodeId, TACHYON_NODE_NONCE: nonce },
      });
    } catch (err) {
      this.setSignal(runId, nodeId, (s) => (s.exited = true)); // a failed spawn = the node never ran
      this.setSignal(runId, nodeId, (s) => (s.exitCode = s.exitCode ?? 1));
      this.tick(runId);
    }
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

  private async finish(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    // never release the worktree while a node is still running (defensive; linear MVP shouldn't hit it)
    if (run && Object.values(run.nodes).some((n) => n.status === "running")) return;
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
    }
    this.signals.delete(runId);
    this.verifyRequested.delete(runId);
    this.cwd.delete(runId);
    const wtKey = this.wtKey.get(runId);
    this.wtKey.delete(runId);
    if (wtKey) await this.deps.releaseWorktree(wtKey);
  }
}
