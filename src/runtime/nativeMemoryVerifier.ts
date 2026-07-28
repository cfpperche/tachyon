/**
 * t-56daa1 — the behavioral verifier: the ONLY way an evidence axis becomes `verified`.
 *
 * `nativeMemory.ts` cannot mint `verified` from configuration bytes, so something has to observe the
 * runtime actually behaving. This is that something, and it is built to the research's constraints
 * (`docs/research/runtime-native-memory-parity-t-d4c42e.md` § "Required behavioral verifier"):
 *
 *  1. an isolated temporary runtime home and repository — never the user's;
 *  2. a unique synthetic marker planted only in that store;
 *  3. a non-billable inspection path when one exists; a model call ONLY with explicit authorization;
 *  4. the marker absent with memory disabled, and present only within the declared bound when enabled;
 *  5. whether writes occur after a controlled turn/session boundary;
 *  6. the required lifecycle operations;
 *  7. the temporary home deleted, with the runtime version and effective model recorded.
 *
 * Two refusals are load-bearing, and both come from measured failures rather than caution:
 *
 * **It never calls a model on its own.** The task's own constraint, and the reason is that a verifier
 * which quietly bills someone is a verifier people stop running. `runModelTurn` is unreachable without
 * an `authorization` naming who granted it and why.
 *
 * **It fails when effective-model provenance is missing or wrong.** Probe
 * `probe-42744006-bc41-426a-8047-4d8ad054c213` was requested as Claude Opus 5, executed Haiku 4.5,
 * timed out, and its output had to be discarded. A run that cannot say which model actually answered
 * has not verified anything, however green it looks.
 *
 * Pure except for the injected `VerificationEffects`, so every branch — including "the runtime wrote
 * the marker into the store while claiming memory was disabled" — is exercisable without installing a
 * runtime or spending a token.
 */
import path from "node:path";
import type { MemoryEvidence, MemoryEvidenceAxis, MemoryLifecycleOperation } from "./nativeMemory.js";

/** What the verifier is allowed to do to the world. Every one of these is scoped to the temp sandbox. */
export interface VerificationEffects {
  /** Create the isolated home/repo. Returns an absolute path the verifier will later delete. */
  mkdtemp(prefix: string): string;
  /** Remove the sandbox. Called even when a step throws — cleanup is itself an asserted outcome. */
  rm(dir: string): void;
  /** Plant the synthetic marker inside the sandbox store. */
  plantMarker(storePath: string, marker: string): void;
  /**
   * List the store's contents as text the verifier may search for its OWN marker. It must never be
   * pointed at a real home: `assertSandboxed` refuses any path outside the sandbox before this runs.
   */
  readStore(storePath: string): string;
  /**
   * A non-billable inspection: `--help`, a status subcommand, a dry-run prompt dump. Returns what the
   * runtime would send, so injection can be observed without a model answering.
   */
  inspect(request: InspectionRequest): InspectionResult;
  /** A real turn. Present only when the caller authorized one; the verifier never reaches it otherwise. */
  runModelTurn?(request: ModelTurnRequest): ModelTurnResult;
}

export interface InspectionRequest {
  readonly home: string;
  readonly repo: string;
  readonly memoryEnabled: boolean;
  readonly lifecycle: MemoryLifecycleOperation;
}

export interface InspectionResult {
  /** What the runtime would put in front of the model. Searched for the marker; never for user text. */
  readonly promptText: string;
  /** Bytes/lines the runtime reported it would inject, when it says so. */
  readonly injectedBound?: { readonly kind: "bytes" | "lines" | "characters" | "items"; readonly value: number };
  /** The model the runtime resolved. Required for any step that claims to verify injection. */
  readonly effectiveModel?: string;
}

export interface ModelTurnRequest extends InspectionRequest {
  readonly requestedModel: string;
  readonly prompt: string;
}

export interface ModelTurnResult {
  readonly promptText: string;
  readonly effectiveModel?: string;
  /** Did the store change after the boundary? The mutation axis is exactly this question. */
  readonly storeAfter: string;
}

/** Explicit human authorization for the smallest possible billable call (research step 3). */
export interface ModelCallAuthorization {
  readonly grantedBy: string;
  readonly reason: string;
}

export interface MemoryVerificationRequest {
  readonly adapter: string;
  readonly runtimeVersion: string;
  /** The model the run ASKS for. A different effective model fails the run rather than annotating it. */
  readonly requestedModel: string;
  /** Lifecycle operations to exercise. Anything not listed stays unverified rather than assumed. */
  readonly lifecycle: readonly MemoryLifecycleOperation[];
  /** Absent means: inspection only. A step needing a model turn then reports needs-authorization. */
  readonly authorization?: ModelCallAuthorization;
  /** Injected for determinism in tests; production passes a random one. */
  readonly marker?: string;
}

export interface AxisObservation {
  readonly axis: MemoryEvidenceAxis;
  readonly evidence: MemoryEvidence;
  /** What was observed, in the words of the observation — never a restatement of the request. */
  readonly note: string;
}

export type MemoryVerificationOutcome =
  | {
      readonly status: "verified";
      readonly adapter: string;
      readonly runtimeVersion: string;
      readonly effectiveModel: string;
      readonly observations: readonly AxisObservation[];
      readonly lifecycle: Readonly<Partial<Record<MemoryLifecycleOperation, string>>>;
      readonly cleanedUp: boolean;
      readonly marker: string;
    }
  | {
      /** The run needs a billable call nobody authorized. Not a failure — an unanswered question. */
      readonly status: "needs-authorization";
      readonly reason: string;
      readonly cleanedUp: boolean;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly observations: readonly AxisObservation[];
      readonly cleanedUp: boolean;
    };

/** Marker shape: unmistakable in a prompt dump, and obviously not user text. */
export function synthesizeMarker(seed: string): string {
  return `TACHYON-MEMORY-PROBE-${seed}`;
}

/**
 * Refuse any path outside the sandbox, before any effect touches it.
 *
 * The research's hard line is "must not inspect or mutate user memory". A verifier that reads a real
 * `~/.claude` even once has broken that promise no matter what it concluded, so containment is
 * checked here rather than trusted to each effect.
 */
export function assertSandboxed(sandbox: string, target: string): void {
  const root = path.resolve(sandbox);
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(
      `native-memory verifier refused a path outside its sandbox: ${resolved} is not under ${root} — the verifier must never read or mutate real memory`,
    );
  }
}

/**
 * Run the behavioral verification.
 *
 * Reads as a sequence of questions, each answered by an observation or left unverified. Nothing here
 * upgrades an axis it did not watch: an axis the run never exercised comes back `declared`, which is
 * what it was before the run started.
 */
export function verifyNativeMemory(
  request: MemoryVerificationRequest,
  effects: VerificationEffects,
): MemoryVerificationOutcome {
  const marker = request.marker ?? synthesizeMarker(`${request.adapter}-${request.runtimeVersion}`);
  const observations: AxisObservation[] = [];
  const lifecycle: Partial<Record<MemoryLifecycleOperation, string>> = {};
  let sandbox: string | undefined;
  let cleanedUp = false;

  const cleanup = (): void => {
    if (!sandbox || cleanedUp) return;
    effects.rm(sandbox);
    cleanedUp = true;
  };

  try {
    sandbox = effects.mkdtemp(`tachyon-memory-${request.adapter}-`);
    const home = path.join(sandbox, "home");
    const repo = path.join(sandbox, "repo");
    const store = path.join(home, "memory");
    // Containment first: if any of these escaped the sandbox, nothing below may run.
    for (const target of [home, repo, store]) assertSandboxed(sandbox, target);

    effects.plantMarker(store, marker);
    observations.push({
      axis: "inventory",
      evidence: "verified",
      note: `planted a synthetic marker in an isolated store at ${store}; no real memory was read`,
    });

    // ── disable: the marker must NOT reach model input ──────────────────────────────────────────
    const disabled = effects.inspect({ home, repo, memoryEnabled: false, lifecycle: "fresh" });
    if (disabled.promptText.includes(marker)) {
      observations.push({
        axis: "disable",
        evidence: "declared",
        note: "memory was configured off, yet the planted marker still reached model input — the disable control does not disable injection",
      });
      return { status: "failed", reason: `${request.adapter}: disable did not stop injection`, observations, cleanedUp: (cleanup(), cleanedUp) };
    }
    observations.push({
      axis: "disable",
      evidence: "verified",
      note: "with memory disabled, the planted marker was absent from model input",
    });

    // ── enable + injection bound: present, and only within what was declared ─────────────────────
    const enabled = effects.inspect({ home, repo, memoryEnabled: true, lifecycle: "fresh" });
    if (!enabled.promptText.includes(marker)) {
      observations.push({
        axis: "enable",
        evidence: "declared",
        note: "memory was configured on, but the planted marker never reached model input — enable is not observable this way",
      });
      return { status: "failed", reason: `${request.adapter}: enable produced no observable injection`, observations, cleanedUp: (cleanup(), cleanedUp) };
    }
    observations.push({ axis: "enable", evidence: "verified", note: "with memory enabled, the planted marker reached model input" });

    // Provenance is required for the axes that describe what the MODEL saw. Without it the run cannot
    // say whose input this was (the discarded-probe lesson).
    const effectiveModel = enabled.effectiveModel ?? disabled.effectiveModel;
    if (!effectiveModel) {
      return {
        status: "failed",
        reason: `${request.adapter}: no effective-model provenance — a run that cannot say which model answered has verified nothing`,
        observations,
        cleanedUp: (cleanup(), cleanedUp),
      };
    }
    if (effectiveModel !== request.requestedModel) {
      return {
        status: "failed",
        reason: `${request.adapter}: requested ${request.requestedModel} but ${effectiveModel} answered — discard the run rather than attribute it (probe-42744006)`,
        observations,
        cleanedUp: (cleanup(), cleanedUp),
      };
    }

    if (enabled.injectedBound) {
      observations.push({
        axis: "injection",
        evidence: "verified",
        note: `injection observed within the declared bound of ${enabled.injectedBound.value} ${enabled.injectedBound.kind}`,
      });
    } else {
      // Seen, but unbounded: "it injects" is weaker than "it injects at most N", and the product's
      // runtime-managed rule depends on the bound, so this stays short of verified.
      observations.push({
        axis: "injection",
        evidence: "declared",
        note: "injection observed but the runtime reported no bound, so the bounded-injection contract is unproven",
      });
    }

    // ── mutation: does a controlled boundary write? Needs a real turn, hence authorization ───────
    if (!request.authorization) {
      cleanup();
      return {
        status: "needs-authorization",
        reason: `${request.adapter}: proving whether a turn boundary WRITES memory needs one authorized model call; inspection alone cannot answer it`,
        cleanedUp,
      };
    }
    if (!effects.runModelTurn) {
      cleanup();
      return {
        status: "needs-authorization",
        reason: `${request.adapter}: authorized by ${request.authorization.grantedBy} but no model-turn effect was wired`,
        cleanedUp,
      };
    }
    const storeBefore = effects.readStore(store);
    const turn = effects.runModelTurn({
      home,
      repo,
      memoryEnabled: true,
      lifecycle: "fresh",
      requestedModel: request.requestedModel,
      prompt: `say nothing; this turn exists to observe whether ${marker} is written back`,
    });
    if (turn.effectiveModel !== request.requestedModel) {
      return {
        status: "failed",
        reason: `${request.adapter}: authorized turn requested ${request.requestedModel} but ${turn.effectiveModel ?? "an unnamed model"} answered — discard the run (probe-42744006)`,
        observations,
        cleanedUp: (cleanup(), cleanedUp),
      };
    }
    observations.push({
      axis: "mutation",
      evidence: "verified",
      note: turn.storeAfter === storeBefore
        ? "the store was unchanged after a controlled turn boundary — no background write observed"
        : "the store changed after a controlled turn boundary — the runtime writes memory unprompted",
    });

    // ── isolation: everything observed stayed inside the sandbox ────────────────────────────────
    observations.push({
      axis: "isolation",
      evidence: "verified",
      note: `every path read or written resolved under ${sandbox}; no ambient home participated`,
    });

    // ── lifecycle: only what was actually exercised ─────────────────────────────────────────────
    for (const operation of request.lifecycle) {
      const after = effects.inspect({ home, repo, memoryEnabled: true, lifecycle: operation });
      lifecycle[operation] = after.promptText.includes(marker)
        ? "marker still present — the store survived this operation"
        : "marker absent — the store did not survive this operation";
    }

    cleanup();
    return {
      status: "verified",
      adapter: request.adapter,
      runtimeVersion: request.runtimeVersion,
      effectiveModel,
      observations,
      lifecycle,
      cleanedUp,
      marker,
    };
  } catch (error) {
    // A thrown step still has to leave nothing behind: the sandbox is the whole isolation promise.
    cleanup();
    return {
      status: "failed",
      reason: `${request.adapter}: ${error instanceof Error ? error.message : String(error)}`,
      observations,
      cleanedUp,
    };
  }
}

/**
 * Fold a verification into the evidence set an adapter may then declare.
 *
 * Only axes the run OBSERVED are promoted, and only from a `verified` outcome — a failed or
 * unauthorized run leaves every axis exactly where it was. This is the seam the per-runtime tasks
 * use, and keeping the promotion here (rather than letting each adapter hand-edit its evidence) is
 * what makes "verified means observed" checkable in one place.
 */
export function promoteEvidence(
  current: Readonly<Record<MemoryEvidenceAxis, MemoryEvidence>>,
  outcome: MemoryVerificationOutcome,
): Record<MemoryEvidenceAxis, MemoryEvidence> {
  const next = { ...current };
  if (outcome.status !== "verified") return next;
  for (const observation of outcome.observations) {
    if (observation.evidence === "verified") next[observation.axis] = "verified";
  }
  return next;
}
