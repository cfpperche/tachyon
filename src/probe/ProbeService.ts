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
import { envelopeFor, runningEnvelope, type ProbeEnvelope, type ProbeResult, type RunId } from "./taxonomy.js";
import { enforceModelProof, resolveModelProof } from "./modelProof.js";
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
  /** fired when a run is admitted (spec 257 — refresh the transient sidebar running-probe chip). */
  onLaunch?: () => void;
  /** spec 351 (dueto F11) — mint a per-run caller token through the SAME digest-only registry agents use,
   *  scoped like `probe:<runId>`; undefined when no registry is wired (probes stay ordinary unauthenticated
   *  callers, exactly as before this spec). The plaintext lives only in this run's in-memory result — it
   *  is NEVER written to ProbeRunMeta/the store (digest-only persistence invariant extends to probes). */
  mintCallerToken?: (name: string) => string | undefined;
  /** revoke the per-run token when the run leaves in-flight (success/failure/timeout/cancel) — "expiring
   *  with the run" is exact, not TTL-approximate. No-op if nothing was minted. */
  revokeCallerToken?: (name: string) => void;
}

/** the caller-identity name a probe run's per-run token is minted/resolved under (spec 351). */
export function probeCallerName(runId: RunId): string {
  return `probe:${runId}`;
}

/** Default subprocess budget. Longer than the Bridge sync cap so sync probes can hand back a runId. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5 * 60_000;
/** Claude review probes routinely need more wall time than a smoke probe; callers can still override. */
export const DEFAULT_CLAUDE_REVIEW_TIMEOUT_MS = 10 * 60_000;

interface InFlight {
  controller: AbortController;
  done: Promise<ProbeEnvelope>;
}

/** Narrow an opaque native field to a string list — anything else is treated as absent evidence. */
function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") && value.length > 0
    ? value as string[]
    : undefined;
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
  private readonly onLaunch?: () => void;
  private readonly mintCallerToken?: (name: string) => string | undefined;
  private readonly revokeCallerToken?: (name: string) => void;
  private readonly inflight = new Map<RunId, InFlight>();

  constructor(deps: ProbeServiceDeps) {
    this.adapters = deps.adapters;
    this.store = deps.store;
    this.runFn = deps.runFn ?? defaultRunProbe;
    this.isolate = deps.isolate;
    // Fail closed for write-capable probes even when no authorize is wired (codex review #11/#31):
    // a write probe without isolation could mutate the caller's real repo.
    this.authorize = deps.authorize ?? ((req) => (req.write ? { ok: false, reason: "write-capable probes require explicit authorization" } : { ok: true }));
    this.maxConcurrent = deps.maxConcurrent ?? 4;
    this.now = deps.now ?? Date.now;
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.onComplete = deps.onComplete;
    this.onLaunch = deps.onLaunch;
    this.mintCallerToken = deps.mintCallerToken;
    this.revokeCallerToken = deps.revokeCallerToken;
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
  async launch(req: ProbeRequest): Promise<{ runId: RunId; done: Promise<ProbeEnvelope>; callerToken?: string }> {
    const auth = this.authorize(req);
    if (!auth.ok) throw new ProbeRejectedError(`unauthorized: ${auth.reason ?? "caller not permitted"}`);
    if (this.inflight.size >= this.maxConcurrent) {
      throw new ProbeRejectedError(`concurrency cap reached (${this.maxConcurrent}); retry when a probe finishes`);
    }
    const adapter = this.adapters.get(req.runtime);
    if (!adapter) throw new ProbeRejectedError(`unknown runtime: ${req.runtime}`);

    // Reserve the slot BEFORE the capability await, so two concurrent launches can't both pass the cap
    // check and then both insert (codex review #3). On a rejection we release the reservation.
    const runId = mintRunId();
    // spec 351 — a per-run caller token, minted through the SAME registry agents use, scoped to this run
    // (parent attribution stays in ProbeRunMeta.caller below — this token is a SEPARATE, ephemeral
    // identity, never persisted). Revoked wherever the run leaves in-flight, below.
    const callerName = probeCallerName(runId);
    const callerToken = this.mintCallerToken?.(callerName);
    const revoke = () => this.revokeCallerToken?.(callerName);
    const controller = new AbortController();
    this.inflight.set(runId, { controller, done: Promise.resolve(runningEnvelope(runId)) });
    try {
      const cap = await adapter.detectCapability();
      if (!cap.available) throw new ProbeRejectedError(`runtime '${req.runtime}' unavailable: ${cap.reason ?? "no capability"}`);
      const done = this.execute(runId, req, adapter, cap.binaryVersion, controller.signal).finally(() => {
        this.inflight.delete(runId);
        revoke();
      });
      this.inflight.set(runId, { controller, done });
      this.onLaunch?.(); // surface the transient running chip immediately
      return { runId, done, callerToken };
    } catch (err) {
      this.inflight.delete(runId);
      revoke();
      throw err;
    }
  }

  /** Is this runId an in-flight run? Lets the Bridge tell "running" from a bogus id (codex review #2). */
  hasInFlight(runId: RunId): boolean {
    return this.inflight.has(runId);
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
    if (!back) return null;
    const { envelope, meta } = back;
    if (!envelope.result || envelope.result.modelProof) return envelope;
    // SDD 473 — a run stored before the verdict existed carries no `modelProof`. Derive one from
    // the evidence that WAS stored, using the same rule as a live run. This never invents proof (a
    // run with nothing recorded reads as `unproven`); it only stops an old artifact from being
    // indistinguishable from one that was actually proven.
    const proof = resolveModelProof({
      requested: meta.requestedModel,
      effective: meta.reportedNativeModels,
      effectiveCanonical: meta.reportedModels,
      // Only what the run itself recorded — an old run that predates SDD 476 has no evidence kind,
      // and the current adapter's capability says nothing about the run that was actually stored.
      evidence: meta.modelEvidence,
    });
    return { ...envelope, result: { ...envelope.result, modelProof: proof } };
  }

  /**
   * Reconcile the ledger after a Bridge restart (OQ3): any run dir with metadata but no result was
   * incomplete (its process is gone) → publish a `failed` envelope so it never reads as still-running.
   */
  async reap(): Promise<{ reaped: RunId[] }> {
    const reaped: RunId[] = [];
    const metas = await this.store.listIncomplete();
    for (const meta of metas) {
      // Honest (codex review #19): we do NOT persist pids in v1, so we did not actually kill anything —
      // claim process_error + an orphaned marker, never a fictitious SIGKILL.
      const result: ProbeResult = {
        reason: "process_error",
        lastMessage: "orphaned: incomplete at Bridge restart — the probe process state is unknown and was NOT reaped (pids are not persisted in v1)",
        exitCode: null,
        timedOut: false,
        native: { runtime: meta.runtime, orphaned: true },
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
      ...(req.model ? { requestedModel: req.model } : {}),
      archetype: req.archetype,
      caller: req.caller, // provenance/ownership (codex review #49)
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

    let envelope: ProbeEnvelope;
    try {
      const scratchDir = await this.store.scratchDir(runId);
      const spec: ProbeSpec = {
        runtime: req.runtime,
        prompt: composeBrief(req.archetype, req.brief),
        model: req.model,
        cwd,
        timeoutMs: req.timeoutMs ?? this.defaultTimeoutFor(req),
        budgetUsd: req.budgetUsd,
        sandbox: req.write ? "workspace-write" : "read-only",
        archetype: req.archetype,
      };
      let result = await this.runFn(adapter, spec, { scratchDir, signal });
      result = this.validateArchetype(req.archetype, result);
      const reportedModels = stringList(result.native.reportedModels);
      const reportedNativeModels = stringList(result.native.reportedNativeModels);
      // SDD 473 — a probe is read as evidence, so decide here whether the model that ran can be
      // shown to be the model that was asked for, and refuse the result when it cannot.
      const proof = resolveModelProof({
        requested: req.model,
        effective: reportedNativeModels,
        effectiveCanonical: reportedModels,
        // SDD 476 — the adapter declares what KIND of evidence it produces; the service only carries
        // it, so no runtime can be characterised as stronger than the adapter itself claims.
        evidence: adapter.modelEvidence,
      });
      result = enforceModelProof(result, proof, adapter.reportsEffectiveModel === true);
      envelope = envelopeFor(runId, result);
      await this.store.writeResult(envelope, {
        ...meta,
        ...(reportedModels ? { reportedModels } : {}),
        ...(reportedNativeModels ? { reportedNativeModels } : {}),
        modelProof: proof.verdict,
        ...(proof.evidence ? { modelEvidence: proof.evidence } : {}),
        finishedAt: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      // An orchestration error becomes a `failed` envelope — a probe must never crash the Bridge,
      // and an async caller polling read_probe_result must always get a terminal answer.
      envelope = envelopeFor(runId, {
        reason: "process_error",
        lastMessage: `probe orchestration error: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: null,
        timedOut: false,
        native: { runtime: req.runtime },
      });
      await this.store.writeResult(envelope, { ...meta, finishedAt: new Date(this.now()).toISOString() }).catch(() => undefined);
    } finally {
      if (cleanup) await cleanup().catch(() => undefined);
    }
    // Notify OUTSIDE the try/catch (codex review #36): a throwing onComplete must never overwrite a
    // successful result with a process_error.
    try {
      this.onComplete?.(envelope);
    } catch {
      /* a notification failure never changes the outcome */
    }
    return envelope;
  }

  private defaultTimeoutFor(req: ProbeRequest): number {
    if (req.runtime === "claude" && req.archetype === "adversarial-review") {
      return Math.max(this.defaultTimeoutMs, DEFAULT_CLAUDE_REVIEW_TIMEOUT_MS);
    }
    return this.defaultTimeoutMs;
  }

  /** OQ5 — a successful run whose output doesn't match the archetype schema is a `parse_error`, but the
   *  model's actual answer is PRESERVED in `lastMessage` (codex review #26); the schema error goes to native. */
  private validateArchetype(id: ArchetypeId, result: ProbeResult): ProbeResult {
    if (id === "freeform" || result.reason !== "ok") return result;
    const v = getArchetype(id).validate(result.lastMessage);
    if (v.ok) return result;
    return { ...result, reason: "parse_error", native: { ...result.native, schemaError: `did not match the ${id} schema: ${v.error}` } };
  }
}
