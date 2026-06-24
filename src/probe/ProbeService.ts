/**
 * Spec 257 (D1/D2 glue, D8, OQ3/OQ4/OQ5) — the probe orchestrator. Ties the pure pieces together:
 * mint a run id → authorize the caller (D8) → enforce the concurrency cap (OQ3) → capability-gate the
 * runtime (D5) → compose the archetype brief (D7) → select read-only vs isolated cwd (OQ4) → run via
 * the {@link runProbe} subprocess runner (D6) → validate the archetype output (non-compliant →
 * `parse_error`, OQ5) → publish to the {@link ProbeStore} (D9). All collaborators are injected so the
 * service is table-testable without real CLIs, worktrees, or fs beyond the store.
 *
 * No auto-retry (ratified): a probe is a budget-spending call; the caller re-issues.
 */

import { runProbe as defaultRunProbe } from "./ProbeRunner.js";
import { envelopeFor, type ProbeEnvelope, type ProbeResult, type RunId } from "./taxonomy.js";
import { composeBrief, getArchetype, type ArchetypeBrief, type ArchetypeId } from "./archetypes.js";
import type { HeadlessCaptureAdapter, ProbeSpec } from "./adapters/types.js";
import { mintRunId, ProbeStore, type ProbeRunMeta } from "./ProbeStore.js";

/** Launch was refused before any process ran (cap / auth / unknown or unavailable runtime). */
export class ProbeRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ProbeRejectedError";
  }
}

export interface ProbeRequest {
  runtime: string;
  archetype: ArchetypeId;
  brief: ArchetypeBrief;
  model?: string;
  cwd: string;
  timeoutMs?: number;
  budgetUsd?: number;
  /** the calling agent (D8 lineage/authorization). */
  caller?: string;
  /** a write-capable probe gets an isolated worktree (OQ4); the read-only default does not. */
  write?: boolean;
}

/** Isolation seam (OQ4) — a write-capable probe runs in an isolated dir, cleaned up after. */
export type IsolateFn = (cwd: string) => Promise<{ dir: string; cleanup: () => Promise<void> }>;
/** Authorization seam (D8) — decide whether a caller may launch this probe. */
export type AuthorizeFn = (req: ProbeRequest) => { ok: boolean; reason?: string };

export interface ProbeServiceDeps {
  adapters: Map<string, HeadlessCaptureAdapter>;
  store: ProbeStore;
  runFn?: typeof defaultRunProbe;
  isolate?: IsolateFn;
  authorize?: AuthorizeFn;
  maxConcurrent?: number;
  now?: () => number;
  defaultTimeoutMs?: number;
  /** fired after a run is published (OQ1 async handoff — wired to the Bridge `notify`). */
  onComplete?: (envelope: ProbeEnvelope) => void;
}

interface InFlight {
  controller: AbortController;
  done: Promise<ProbeEnvelope>;
}

export class ProbeService {
  private readonly adapters: Map<string, HeadlessCaptureAdapter>;
  private readonly store: ProbeStore;
  private readonly runFn: typeof defaultRunProbe;
  private readonly isolate?: IsolateFn;
  private readonly authorize: AuthorizeFn;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private readonly defaultTimeoutMs: number;
  private readonly onComplete?: (envelope: ProbeEnvelope) => void;
  private readonly inflight = new Map<RunId, InFlight>();

  constructor(deps: ProbeServiceDeps) {
    this.adapters = deps.adapters;
    this.store = deps.store;
    this.runFn = deps.runFn ?? defaultRunProbe;
    this.isolate = deps.isolate;
    this.authorize = deps.authorize ?? (() => ({ ok: true }));
    this.maxConcurrent = deps.maxConcurrent ?? 4;
    this.now = deps.now ?? Date.now;
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? 120_000;
    this.onComplete = deps.onComplete;
  }

  /** Number of probes currently running. */
  active(): number {
    return this.inflight.size;
  }

  /**
   * Launch a probe. Throws {@link ProbeRejectedError} synchronously if refused (cap/auth/runtime).
   * Returns the `runId` + a `done` promise resolving to the stable envelope (D3). Both sync and async
   * Bridge paths share this — sync races `done` against a cap, async returns the `runId` immediately.
   */
  async launch(req: ProbeRequest): Promise<{ runId: RunId; done: Promise<ProbeEnvelope> }> {
    const auth = this.authorize(req);
    if (!auth.ok) throw new ProbeRejectedError(`unauthorized: ${auth.reason ?? "caller not permitted"}`);
    if (this.inflight.size >= this.maxConcurrent) {
      throw new ProbeRejectedError(`concurrency cap reached (${this.maxConcurrent}); retry when a probe finishes`);
    }
    const adapter = this.adapters.get(req.runtime);
    if (!adapter) throw new ProbeRejectedError(`unknown runtime: ${req.runtime}`);
    const cap = await adapter.detectCapability();
    if (!cap.available) throw new ProbeRejectedError(`runtime '${req.runtime}' unavailable: ${cap.reason ?? "no capability"}`);

    const runId = mintRunId();
    const controller = new AbortController();
    const done = this.execute(runId, req, adapter, cap.binaryVersion, controller.signal).finally(() => {
      this.inflight.delete(runId);
    });
    this.inflight.set(runId, { controller, done });
    return { runId, done };
  }

  /** Cancel an in-flight probe; returns true if it was running. */
  cancel(runId: RunId): boolean {
    const f = this.inflight.get(runId);
    if (!f) return false;
    f.controller.abort();
    return true;
  }

  /** Read a finished probe's envelope from the store (the async/poll path). */
  async read(runId: RunId): Promise<ProbeEnvelope | null> {
    const back = await this.store.readResult(runId);
    return back?.envelope ?? null;
  }

  /**
   * Reconcile the ledger after a Bridge restart (OQ3): any run dir with metadata but no result was
   * incomplete (its process is gone) → publish a `failed` envelope so it never reads as still-running.
   */
  async reap(): Promise<{ reaped: RunId[] }> {
    const reaped: RunId[] = [];
    const metas = await this.store.listIncomplete();
    for (const meta of metas) {
      const result: ProbeResult = {
        reason: "killed_signal",
        lastMessage: "orphaned: the probe was incomplete when the Bridge restarted",
        exitCode: null,
        signal: "SIGKILL",
        timedOut: false,
        native: { runtime: meta.runtime },
      };
      await this.store.writeResult(envelopeFor(meta.runId, result), { ...meta, finishedAt: new Date(this.now()).toISOString() });
      reaped.push(meta.runId);
    }
    return { reaped };
  }

  private async execute(
    runId: RunId,
    req: ProbeRequest,
    adapter: HeadlessCaptureAdapter,
    binaryVersion: string | undefined,
    signal: AbortSignal,
  ): Promise<ProbeEnvelope> {
    const createdAt = new Date(this.now()).toISOString();
    const meta: ProbeRunMeta = {
      runId,
      runtime: req.runtime,
      adapterVersion: adapter.adapterVersion,
      binaryVersion,
      archetype: req.archetype,
      createdAt,
    };
    await this.store.writeMeta(meta); // written at launch so reap() can see an incomplete run

    let cwd = req.cwd;
    let cleanup: (() => Promise<void>) | undefined;
    if (req.write && this.isolate) {
      const iso = await this.isolate(req.cwd);
      cwd = iso.dir;
      cleanup = iso.cleanup;
    }

    try {
      const scratchDir = await this.store.scratchDir(runId);
      const spec: ProbeSpec = {
        runtime: req.runtime,
        prompt: composeBrief(req.archetype, req.brief),
        model: req.model,
        cwd,
        timeoutMs: req.timeoutMs ?? this.defaultTimeoutMs,
        budgetUsd: req.budgetUsd,
        sandbox: req.write ? "workspace-write" : "read-only",
        archetype: req.archetype,
      };
      let result = await this.runFn(adapter, spec, { scratchDir, signal });
      result = this.validateArchetype(req.archetype, result);
      const envelope = envelopeFor(runId, result);
      await this.store.writeResult(envelope, { ...meta, finishedAt: new Date(this.now()).toISOString() });
      this.onComplete?.(envelope);
      return envelope;
    } catch (err) {
      // An orchestration error becomes a `failed` envelope — a probe must never crash the Bridge,
      // and an async caller polling read_probe_result must always get a terminal answer.
      const envelope = envelopeFor(runId, {
        reason: "process_error",
        lastMessage: `probe orchestration error: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: null,
        timedOut: false,
        native: { runtime: req.runtime },
      });
      await this.store.writeResult(envelope, { ...meta, finishedAt: new Date(this.now()).toISOString() }).catch(() => undefined);
      this.onComplete?.(envelope);
      return envelope;
    } finally {
      if (cleanup) await cleanup().catch(() => undefined);
    }
  }

  /** OQ5 — a successful run whose output doesn't match the archetype schema is a `parse_error`. */
  private validateArchetype(id: ArchetypeId, result: ProbeResult): ProbeResult {
    if (id === "freeform" || result.reason !== "ok") return result;
    const v = getArchetype(id).validate(result.lastMessage);
    if (v.ok) return result;
    return { ...result, reason: "parse_error", lastMessage: `output did not match the ${id} schema: ${v.error}` };
  }
}
