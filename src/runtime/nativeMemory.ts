/**
 * t-56daa1 — runtime-native memory as a TYPED capability, resolved fail-closed.
 *
 * Runtime-native memory is persistent prompt-writing authority owned by a runtime or a runtime
 * extension (`docs/research/runtime-native-memory-parity-t-d4c42e.md`). It is not an ordinary
 * native-config scalar, and it is not Tachyon's human-approved selected-memory lane.
 *
 * The research measured why one `unsupported | uncontrolled | controllable` enum is too lossy, and
 * every axis below exists because a real runtime separates it from the others:
 *
 *  - writing a disable setting proves only that Tachyon authored bytes — never that anything changed;
 *  - a runtime can stop INJECTING memory while still writing and consolidating it;
 *  - a private config home can isolate files while an external provider stays shared;
 *  - repository identity can intentionally alias clones and worktrees (Grok does);
 *  - a plugin can inject persistent context where the core runtime has no memory feature at all.
 *
 * So evidence is per axis, and `verified` has exactly one source: a behavioral observation from
 * `nativeMemoryVerifier.ts`. Nothing in this module can mint it from configuration bytes — the
 * registry below is authored at `declared`/`unsupported` on purpose, and the per-runtime tasks
 * (t-f22211, t-c46aad, t-c46c35, t-b5d28c, t-b4a557) are what promote an axis by running the
 * verifier against an exact version.
 *
 * NOT WIRED INTO CANONICAL READINESS BY THIS TASK, deliberately. `resolveMemoryPolicy` implements the
 * research's fail-closed semantics faithfully, which means that TODAY — with nothing verified — it
 * blocks every runtime that has native memory. That is the honest answer, and it is also why
 * enforcing it in profile readiness belongs to the tasks that first produce verified evidence, not to
 * this one. Wiring it before then would brick canonical readiness for a fleet that is, in fact, no
 * less safe than it was yesterday.
 */

/**
 * How strong the claim on one axis is.
 *
 * `verified` and `refuted` are the two BEHAVIORAL values, and neither may be authored from
 * configuration bytes: one says a measurement supported the claim, the other says a measurement
 * contradicted it. `declared` sits between them as "asserted by a runtime's own documentation, never
 * observed".
 *
 * `refuted` exists because t-0e88f3 found the gap the hard way. Grok's `disable` axis sat at
 * `declared` after a measurement had PROVED the shipped control did not work — and `declared` reads as
 * "nobody checked", which is the opposite of what happened. A vocabulary that cannot say "tested and
 * failed" silently downgrades its worst finding into an unmade one, exactly when the finding matters
 * most. The axis value is the one-word summary; `refutations` below records what actually failed.
 */
export type MemoryEvidence = "unsupported" | "declared" | "verified" | "refuted";

/**
 * The values that may ONLY come from an observation of the runtime. Authoring either from
 * documentation is the conflation this module exists to prevent — and it cuts both ways: a claim
 * cannot be talked into `verified`, and a claim cannot be talked into `refuted` either.
 */
export const BEHAVIORAL_MEMORY_EVIDENCE = ["verified", "refuted"] as const;

export function isBehavioralEvidence(evidence: MemoryEvidence): boolean {
  return (BEHAVIORAL_MEMORY_EVIDENCE as readonly MemoryEvidence[]).includes(evidence);
}

export type MemoryMechanism = "none" | "native" | "extension" | "external-provider";
export type MemoryScope = "agent" | "repository" | "global" | "external" | "unknown";
/** What happens to the store across one lifecycle operation. `unknown` fails closed; it is never inferred. */
export type MemoryLifecycle = "retain" | "reset" | "copy" | "shared" | "unavailable" | "unknown";

/** The six axes. Independent because real runtimes separate them — see the module doc. */
export interface MemoryEvidenceSet {
  /** can Tachyon enumerate what the store holds, without reading user memory? */
  readonly inventory: MemoryEvidence;
  readonly disable: MemoryEvidence;
  readonly enable: MemoryEvidence;
  /** does memory actually reach model input, and within the declared bound? */
  readonly injection: MemoryEvidence;
  /** does the runtime WRITE after a turn/session boundary? */
  readonly mutation: MemoryEvidence;
  /** is the store bound to the private home, or does something remain shared? */
  readonly isolation: MemoryEvidence;
}

export const MEMORY_EVIDENCE_AXES = [
  "inventory",
  "disable",
  "enable",
  "injection",
  "mutation",
  "isolation",
] as const satisfies ReadonlyArray<keyof MemoryEvidenceSet>;

export type MemoryEvidenceAxis = (typeof MEMORY_EVIDENCE_AXES)[number];

export const MEMORY_LIFECYCLE_OPERATIONS = ["fresh", "restart", "resume", "fork"] as const;
export type MemoryLifecycleOperation = (typeof MEMORY_LIFECYCLE_OPERATIONS)[number];

export interface RuntimeNativeMemoryCapabilityV1 {
  readonly schemaVersion: 1;
  readonly adapter: string;
  /**
   * The EXACT runtime version this capability was measured against. Not a floor and not a range: a
   * different version is a different set of facts until someone measures it, which is precisely the
   * drift the research flagged for Codex ("no behavioral assertion prevents version/default drift").
   */
  readonly runtimeVersion: string;
  readonly mechanism: MemoryMechanism;
  readonly defaultState: "enabled" | "disabled" | "unknown";
  readonly evidence: MemoryEvidenceSet;
  readonly control: {
    readonly detect: "none" | "config" | "runtime-status";
    readonly disable: "none" | "config" | "environment" | "argv";
    readonly enable: "none" | "config" | "environment" | "argv";
    readonly purge: "none" | "files" | "native-command" | "api";
    readonly export: "none" | "files" | "native-command" | "api";
  };
  readonly injection: {
    readonly mode: "none" | "startup-bounded" | "every-turn" | "retrieval" | "mixed" | "unknown";
    readonly bound?: { readonly kind: "bytes" | "lines" | "characters" | "items"; readonly value: number };
  };
  readonly mutation: {
    readonly modes: ReadonlyArray<"human-confirmed" | "agent-tool" | "background-extraction" | "external-provider">;
  };
  readonly storage: {
    readonly owner: "runtime" | "extension" | "external-provider" | "none";
    readonly scope: MemoryScope;
    readonly privateHomeBound: boolean | "unknown";
    readonly aliasesWorktrees: boolean | "unknown";
  };
  readonly lifecycle: Readonly<Record<MemoryLifecycleOperation, MemoryLifecycle>>;
  readonly sources: ReadonlyArray<{ readonly kind: "installed-source" | "runtime-doc" | "behavioral-test"; readonly ref: string }>;
  /**
   * Claims a measurement CONTRADICTED, kept beside the axis rather than folded into it.
   *
   * The axis value can only say how strong the evidence is; it cannot say which specific control was
   * tried and failed, and that is the part a reader needs in order not to repeat the mistake. A
   * `refuted` axis without one of these entries is a summary with no finding behind it, so
   * `assertRefutationsAreExplained` refuses the pair at construction rather than letting a bare verdict
   * ship.
   */
  readonly refutations?: ReadonlyArray<{
    readonly axis: MemoryEvidenceAxis;
    /** what was asserted — quoted from the source that asserted it, so the claim stays recognizable */
    readonly claim: string;
    /** what the runtime actually did instead */
    readonly measured: string;
    /** the exact runtime version and date the contradiction was observed at */
    readonly at: string;
    /** where the evidence lives, so the verdict can be checked instead of trusted */
    readonly evidence: string;
    /**
     * t-325794 — the control that later carried this axis to `verified`, when a DIFFERENT one did.
     *
     * Only legal on an axis that is no longer `refuted`, and required there. Grok is the case that
     * forced it: `--no-memory` was measured and failed, so the guide's claim about it is permanently
     * false, but the axis is now carried by the `GROK_MEMORY` env pin, which was measured and held.
     * Deleting the refutation to satisfy the axis would erase a false claim someone will read again in
     * the shipped guide; leaving it bare would assert a contradiction the axis does not reflect. This
     * field is what makes "the claim is still false AND the axis is verified" say something coherent
     * rather than something sloppy.
     */
    readonly supersededBy?: string;
  }>;
  /**
   * An extension/plugin boundary the built-in classification does NOT cover (research § 3). A runtime
   * whose core has no memory can still have a plugin that injects persistent context, and that stays
   * uncontrolled until its exact digest declares its own contract.
   */
  readonly extensionBoundary?: {
    readonly present: true;
    readonly why: string;
  };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The registry — measured facts, at the versions they were measured
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

const RESEARCH = "docs/research/runtime-native-memory-parity-t-d4c42e.md";

/**
 * Evidence is promoted axis by axis, only at the exact runtime version named by each entry. A
 * documented claim remains `declared`; a behavioral observation may promote only the claim that the
 * observation actually exercised.
 */
export const RUNTIME_NATIVE_MEMORY_REGISTRY: Readonly<Record<string, RuntimeNativeMemoryCapabilityV1>> = {
  claude: {
    schemaVersion: 1,
    adapter: "claude",
    runtimeVersion: "2.1.220",
    mechanism: "native",
    defaultState: "enabled",
    evidence: {
      inventory: "declared",
      // Three matched live arms on 2026-07-28 established the oracle with memory enabled, then
      // suppressed the planted marker independently through the canonical settings control and the
      // documented environment control. Same marker, prompt, model and private home in every arm.
      disable: "verified",
      enable: "verified",
      injection: "declared",
      mutation: "declared",
      isolation: "verified",
    },
    control: { detect: "config", disable: "config", enable: "config", purge: "native-command", export: "files" },
    // The first 200 lines OR 25 KiB of MEMORY.md load at every new conversation; topic files are read
    // on demand, which is why the mode is mixed rather than startup-bounded.
    injection: { mode: "mixed", bound: { kind: "lines", value: 200 } },
    mutation: { modes: ["agent-tool", "background-extraction"] },
    storage: { owner: "runtime", scope: "repository", privateHomeBound: true, aliasesWorktrees: true },
    // Only `fresh` was exercised by the live measurement. Restart/resume/fork remain documented
    // lifecycle claims, not behavioral findings, and must not be inferred from the isolation arm.
    lifecycle: { fresh: "retain", restart: "retain", resume: "retain", fork: "reset" },
    sources: [
      { kind: "runtime-doc", ref: "https://code.claude.com/docs/en/memory" },
      { kind: "runtime-doc", ref: "https://code.claude.com/docs/en/env-vars" },
      { kind: "installed-source", ref: "src/harness/HarnessManager.ts" },
      { kind: "installed-source", ref: "src/runtime/adapters/claudeMemory.ts" },
      { kind: "installed-source", ref: RESEARCH },
      { kind: "behavioral-test", ref: `${RESEARCH}#claude-2026-07-28-live` },
    ],
  },
  codex: {
    schemaVersion: 1,
    adapter: "codex",
    runtimeVersion: "0.146.0",
    mechanism: "native",
    defaultState: "disabled",
    evidence: {
      inventory: "declared",
      // Live matched arms on 2026-08-05 used the same private CODEX_HOME and planted
      // memory_summary.md marker. With memories enabled the model returned TOKEN_M8K2P; adding
      // `--disable memories` made the same prompt return NONE. No project-doc suppression was set.
      disable: "verified",
      enable: "declared",
      injection: "declared",
      mutation: "declared",
      isolation: "declared",
    },
    control: { detect: "config", disable: "argv", enable: "config", purge: "api", export: "none" },
    injection: { mode: "retrieval" },
    mutation: { modes: ["background-extraction"] },
    storage: { owner: "runtime", scope: "global", privateHomeBound: true, aliasesWorktrees: "unknown" },
    // Same CODEX_HOME retains state across fresh/restart/resume; native fork is unavailable.
    lifecycle: { fresh: "retain", restart: "retain", resume: "retain", fork: "unavailable" },
    sources: [
      { kind: "runtime-doc", ref: "https://github.com/openai/codex/blob/main/codex-rs/memories/README.md" },
      { kind: "runtime-doc", ref: "https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json" },
      { kind: "installed-source", ref: "src/harness/HarnessManager.ts" },
      { kind: "installed-source", ref: RESEARCH },
      { kind: "behavioral-test", ref: "docs/research/native-lane-suppression-sdd490-fatia-c.md#codex-memory-01460" },
    ],
  },
  grok: {
    schemaVersion: 1,
    adapter: "grok",
    runtimeVersion: "0.2.112",
    mechanism: "native",
    defaultState: "disabled",
    evidence: {
      inventory: "declared",
      // t-325794 — VERIFIED, and the axis is about the control Tachyon actually holds. t-0e88f3 left
      // this at `refuted` because the only thing measured was the FLAG, which failed; the passing
      // canonical launch could not promote it either, since in the TUI the flag alone already
      // suffices, so that arm cannot separate the env pin's contribution from the flag's.
      //
      // The isolating arm ran headless — the mode where the flag is known to LOSE, so whatever
      // disables there is the env var and nothing else — with `[memory] enabled = true` planted in
      // the private home as the enabler, no `--no-memory`, and a synthetic marker in the store:
      //   control (GROK_MEMORY absent): MEMORY_INIT + MEMORY_INJECT + MEMORY_INJECT_SEARCH +
      //     MEMORY_REINDEX, the repository-identity workspace dir built, and the model returned the
      //     planted marker verbatim.
      //   pin (GROK_MEMORY=0): not one memory event in 254 debug lines, nothing built beside the
      //     planted file, marker never reached the model — while the store still held it.
      // Same launch, one variable. `refuted` stays recorded below: the guide's claim about the flag
      // is still false, and that record does not expire because a DIFFERENT control was proven.
      disable: "verified",
      enable: "declared",
      injection: "declared",
      mutation: "declared",
      isolation: "declared",
    },
    // `environment`, not `argv`: the flag was the documented control and measurement refuted it, while
    // the env var demonstrably decided the outcome. Tachyon owns the spawn environment, so this is a
    // control it can actually hold — see `grokMemoryEnv` in adapters/grokMemory.ts.
    control: { detect: "config", disable: "environment", enable: "config", purge: "native-command", export: "native-command" },
    injection: { mode: "mixed" },
    mutation: { modes: ["human-confirmed", "agent-tool", "background-extraction"] },
    // Clones and worktrees of one origin intentionally SHARE the repository key inside a home.
    storage: { owner: "runtime", scope: "repository", privateHomeBound: true, aliasesWorktrees: true },
    lifecycle: { fresh: "retain", restart: "retain", resume: "retain", fork: "unknown" },
    sources: [
      { kind: "installed-source", ref: "~/.grok/docs/user-guide/13-memory.md" },
      { kind: "installed-source", ref: "src/probe/adapters/grok.ts" },
      { kind: "installed-source", ref: RESEARCH },
      { kind: "behavioral-test", ref: `${RESEARCH}#grok-2026-07-28-refuted` },
      { kind: "behavioral-test", ref: `${RESEARCH}#grok-2026-07-28-disable-verified` },
    ],
    refutations: [
      {
        axis: "disable",
        claim: "shipped user guide 13-memory.md, precedence rule 1: `--no-memory` CLI flag (ALWAYS disables), ranked above rule 3 `GROK_MEMORY`",
        measured:
          "HEADLESS (-p), with `--no-memory` AND GROK_MEMORY=1, a marker planted in the private store reached the model verbatim; the debug log shows MEMORY_INIT (watcher_config_enabled=true), MEMORY_INJECT_SEARCH results=1 and a first-turn injection, and the store was written during the run. A default arm with a clean environment and no flag showed none of it, which is what separates 'the flag is inert' from 'the env var outranks it'. In the interactive TUI the SAME pairing disabled memory (no MEMORY_INIT), while `--experimental-memory` + GROK_MEMORY=1 enabled it (MEMORY_INIT, MEMORY_INJECT x2, marker returned in 2.5s with no tool calls, 4.2MB index.sqlite written) — so the flag's rank depends on the launch mode, and the guide's 'always' is false as written",
        at: "Grok 0.2.112, effective models grok-4.5-build (headless) and grok-4.5 (TUI), 2026-07-28",
        evidence: "t-c46c35 journal j-b02184d17f19; t-0e88f3; approvals a-b4b050, a-c1a580, a-a3db98",
        // t-325794 (approval a-9d98ec) — the flag's claim stays false; the axis is carried by the env
        // pin, isolated headless where the flag is known to lose: control arm (GROK_MEMORY absent,
        // `[memory] enabled = true` planted) initialized and injected memory and returned the planted
        // marker; pin arm (GROK_MEMORY=0, everything else identical) produced no memory event at all.
        supersededBy: "GROK_MEMORY=0 environment pin, verified at grok 0.2.112 (t-325794, approval a-9d98ec)",
      },
    ],
  },
  opencode: {
    schemaVersion: 1,
    adapter: "opencode",
    runtimeVersion: "1.18.4",
    mechanism: "none",
    defaultState: "disabled",
    evidence: {
      inventory: "unsupported",
      disable: "unsupported",
      enable: "unsupported",
      injection: "unsupported",
      mutation: "unsupported",
      isolation: "unsupported",
    },
    control: { detect: "none", disable: "none", enable: "none", purge: "none", export: "none" },
    injection: { mode: "none" },
    mutation: { modes: [] },
    storage: { owner: "none", scope: "unknown", privateHomeBound: "unknown", aliasesWorktrees: "unknown" },
    lifecycle: { fresh: "unavailable", restart: "unavailable", resume: "unavailable", fork: "unavailable" },
    sources: [
      { kind: "runtime-doc", ref: "https://opencode.ai/v2/docs/build/plugins" },
      { kind: "installed-source", ref: RESEARCH },
    ],
    extensionBoundary: {
      present: true,
      why: "plugins mutate system/messages/tools immediately before dispatch, so a plugin can implement memory with arbitrary storage or an external provider — outside XDG isolation",
    },
  },
  pi: {
    schemaVersion: 1,
    adapter: "pi",
    runtimeVersion: "0.80.10",
    mechanism: "none",
    defaultState: "disabled",
    evidence: {
      inventory: "unsupported",
      disable: "unsupported",
      enable: "unsupported",
      injection: "unsupported",
      mutation: "unsupported",
      isolation: "unsupported",
    },
    control: { detect: "none", disable: "none", enable: "none", purge: "none", export: "none" },
    injection: { mode: "none" },
    mutation: { modes: [] },
    storage: { owner: "none", scope: "unknown", privateHomeBound: "unknown", aliasesWorktrees: "unknown" },
    lifecycle: { fresh: "unavailable", restart: "unavailable", resume: "unavailable", fork: "unavailable" },
    sources: [
      { kind: "runtime-doc", ref: "https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md" },
      { kind: "installed-source", ref: RESEARCH },
    ],
    extensionBoundary: {
      present: true,
      why: "Pi extensions implement tools and storage, so an authorized extension could add memory Tachyon does not understand the semantics of",
    },
  },
  hermes: {
    schemaVersion: 1,
    adapter: "hermes",
    runtimeVersion: "0.18.2",
    mechanism: "native",
    defaultState: "enabled",
    evidence: {
      inventory: "declared",
      disable: "declared",
      enable: "declared",
      injection: "declared",
      mutation: "declared",
      // The harness copies the real config.yaml including provider selection, so an external provider
      // can reconnect to shared state even though the built-in store starts private and empty.
      isolation: "declared",
    },
    control: { detect: "config", disable: "config", enable: "config", purge: "native-command", export: "none" },
    injection: { mode: "mixed" },
    mutation: { modes: ["agent-tool", "background-extraction", "external-provider"] },
    storage: { owner: "runtime", scope: "global", privateHomeBound: "unknown", aliasesWorktrees: "unknown" },
    lifecycle: { fresh: "retain", restart: "retain", resume: "retain", fork: "unknown" },
    sources: [
      { kind: "installed-source", ref: "~/.hermes/hermes-agent/website/docs/user-guide/features/memory.md" },
      { kind: "installed-source", ref: RESEARCH },
    ],
    extensionBoundary: {
      present: true,
      why: "one optional external memory provider with its own scope and credentials, controlled separately from the built-in store",
    },
  },
};

/**
 * A `refuted` axis must carry the refutation that produced it, and a refutation must belong to a
 * `refuted` axis — unless it names the control that superseded it (t-325794).
 *
 * Run over the static registry at module load rather than left to a test, because the failure it
 * prevents is a verdict with no finding behind it — "we measured and it failed", with no record of
 * WHAT failed, is only marginally better than the `declared` it replaced. The data is authored in this
 * repository and frozen, so if this throws it throws in CI on the commit that introduced it, never in
 * front of a user.
 */
export function assertRefutationsAreExplained(
  registry: Readonly<Record<string, RuntimeNativeMemoryCapabilityV1>>,
): void {
  for (const capability of Object.values(registry)) {
    const explained = new Set((capability.refutations ?? []).map((r) => r.axis));
    for (const axis of MEMORY_EVIDENCE_AXES) {
      const isRefuted = capability.evidence[axis] === "refuted";
      if (isRefuted && !explained.has(axis)) {
        throw new Error(
          `${capability.adapter}: evidence.${axis} is 'refuted' with no matching refutations entry — a verdict with no finding behind it`,
        );
      }
      if (!isRefuted && explained.has(axis)) {
        // t-325794 — a retained refutation on a non-refuted axis is legal ONLY when it names the
        // control that superseded it. Without that, the pair is exactly what this check was written
        // to catch: a recorded contradiction the verdict does not reflect. With it, the record says
        // the coherent thing — that claim is still false, and a different control carries the axis.
        const bare = (capability.refutations ?? []).filter(
          (r) => r.axis === axis && !r.supersededBy?.trim(),
        );
        if (bare.length > 0) {
          throw new Error(
            `${capability.adapter}: refutations names '${axis}' but evidence.${axis} is '${capability.evidence[axis]}' — a recorded contradiction the axis does not reflect (a retained refutation must name its supersededBy control)`,
          );
        }
      }
    }
  }
}

assertRefutationsAreExplained(RUNTIME_NATIVE_MEMORY_REGISTRY);

export function nativeMemoryCapability(adapter: string): RuntimeNativeMemoryCapabilityV1 | undefined {
  return RUNTIME_NATIVE_MEMORY_REGISTRY[adapter];
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Fail-closed resolution
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

/** What a profile may ASK for. `runtime-managed` is the only one that hands authority to a runtime. */
export type MemoryPolicyRequest = "disabled" | "runtime-managed";

export type MemoryPolicyOutcome =
  /** The request is honored — with the evidence that earned it. */
  | { readonly status: "allowed"; readonly policy: MemoryPolicyRequest; readonly reasons: readonly string[] }
  /** Nothing to control: the built-in runtime has no memory. Extensions stay separately uncontrolled. */
  | { readonly status: "unsupported"; readonly reasons: readonly string[] }
  /** Visible, and blocking. Canonical readiness must NOT read as Ready here. */
  | { readonly status: "blocked"; readonly reasons: readonly string[] };

export interface MemoryPolicyQuery {
  readonly adapter: string;
  readonly requested: MemoryPolicyRequest;
  /**
   * The version actually installed. Omitted means "unknown", which fails closed: a capability is a
   * statement about one exact version, and applying it to an unidentified binary is the drift the
   * research called out by name.
   */
  readonly observedVersion?: string;
  readonly capability?: RuntimeNativeMemoryCapabilityV1;
}

/**
 * Resolve a requested memory policy against measured evidence — the research's § "Fail-closed product
 * semantics", implemented rule by rule.
 *
 * The shape of every rule is the same: a claim is honored only when something OBSERVED supports it,
 * and every other outcome is `blocked` with the reason said out loud. Silence is never an answer here
 * — rule 4 exists precisely because "we could not verify disable" used to render as `Ready`.
 */
export function resolveMemoryPolicy(query: MemoryPolicyQuery): MemoryPolicyOutcome {
  const capability = query.capability ?? nativeMemoryCapability(query.adapter);
  const reasons: string[] = [];

  if (!capability) {
    // An unregistered runtime is not a runtime without memory; it is one nobody measured.
    return {
      status: "blocked",
      reasons: [`${query.adapter}: no measured native-memory capability — unknown evidence fails closed`],
    };
  }

  // Version binding, before any axis is read: evidence measured for another version is not evidence
  // about this one.
  if (!query.observedVersion) {
    return {
      status: "blocked",
      reasons: [
        `${capability.adapter}: installed version unknown — the capability describes ${capability.runtimeVersion} only`,
      ],
    };
  }
  if (query.observedVersion !== capability.runtimeVersion) {
    return {
      status: "blocked",
      reasons: [
        `${capability.adapter}: installed ${query.observedVersion} but memory evidence was measured on ${capability.runtimeVersion} — re-verify before trusting it`,
      ],
    };
  }

  // Rule 3 — `unsupported` is valid only for the BUILT-IN runtime. A loaded plugin stays a separate
  // uncontrolled capability, so it is reported rather than folded into "nothing to control".
  if (capability.mechanism === "none") {
    if (query.requested === "runtime-managed") {
      return {
        status: "blocked",
        reasons: [`${capability.adapter}: has no built-in memory to manage (mechanism: none)`],
      };
    }
    if (capability.extensionBoundary) {
      reasons.push(
        `${capability.adapter}: built-in memory is unsupported, but an extension boundary remains uncontrolled — ${capability.extensionBoundary.why}`,
      );
    }
    return { status: "unsupported", reasons };
  }

  if (query.requested === "disabled") {
    // Rule 1 — merely omitting an enable key is insufficient. Authoring a disable setting proves only
    // that Tachyon wrote bytes; the axis has to have been observed.
    if (capability.evidence.disable !== "verified") {
      // A refuted axis gets its own sentence. "not verified" is true of it but useless: it reads as a
      // gap in the record when it is actually a finding, and the reader's next move is completely
      // different — nobody should go looking for the measurement that was already run and failed.
      const refutation = capability.refutations?.find((r) => r.axis === "disable");
      return {
        status: "blocked",
        reasons: [
          refutation
            ? `${capability.adapter}: disable is 'refuted' — measured at ${refutation.at} and the control FAILED: ${refutation.measured} (claim was: ${refutation.claim}; evidence: ${refutation.evidence})`
            : `${capability.adapter}: disable is '${capability.evidence.disable}', not verified — writing a disable setting only proves Tachyon authored bytes`,
          ...(capability.defaultState === "enabled"
            // Rule 4's sharp edge: memory defaults ON and we cannot prove we turned it off.
            ? [`${capability.adapter}: memory is ON by default at ${capability.runtimeVersion}, so canonical readiness is blocked rather than Ready`]
            : []),
        ],
      };
    }
    // Rule 5 — disabling is not deleting, and saying so here keeps a caller from reading "disabled"
    // as "the bytes are gone".
    reasons.push(`${capability.adapter}: memory disabled by verified control; existing bytes are NOT deleted (purge is a separate destructive operation)`);
    return { status: "allowed", policy: "disabled", reasons };
  }

  // Rule 2 — `runtime-managed` requires verified enable, injection, mutation and isolation; complete
  // lifecycle semantics; and a purge path.
  const unverified = (["enable", "injection", "mutation", "isolation"] as const)
    .filter((axis) => capability.evidence[axis] !== "verified");
  if (unverified.length > 0) {
    reasons.push(
      `${capability.adapter}: runtime-managed needs verified enable, injection, mutation and isolation — unverified: ${unverified
        .map((axis) => `${axis}=${capability.evidence[axis]}`)
        .join(", ")}`,
    );
  }
  // Rule 7 — lifecycle is never inferred. An `unknown` operation is a hole in the contract, not a
  // detail to fill in at fork time.
  const incompleteLifecycle = MEMORY_LIFECYCLE_OPERATIONS.filter((op) => capability.lifecycle[op] === "unknown");
  if (incompleteLifecycle.length > 0) {
    reasons.push(
      `${capability.adapter}: lifecycle is unknown for ${incompleteLifecycle.join(", ")} — fresh/restart/resume/fork must never infer copy semantics`,
    );
  }
  if (capability.control.purge === "none") {
    reasons.push(`${capability.adapter}: no purge path, so memory could be created but never removed on request`);
  }
  // Rule 4 — an uncontrolled extension boundary blocks a canonical runtime-managed selection.
  if (capability.extensionBoundary) {
    reasons.push(`${capability.adapter}: an uncontrolled extension boundary remains — ${capability.extensionBoundary.why}`);
  }
  if (capability.storage.privateHomeBound !== true) {
    reasons.push(
      `${capability.adapter}: store is not proven bound to the private home (privateHomeBound: ${String(capability.storage.privateHomeBound)})`,
    );
  }

  if (reasons.length > 0) return { status: "blocked", reasons };
  return {
    status: "allowed",
    policy: "runtime-managed",
    reasons: [`${capability.adapter}: every required axis verified at ${capability.runtimeVersion}`],
  };
}

/**
 * Rule 6 — what an export may contain.
 *
 * Separate from the policy because exporting is a distinct human-initiated act: selected
 * runtime-owned TEXT only, never raw transcripts, indexes, state DBs or provider credentials. A
 * runtime with no export path answers so rather than exporting "whatever is in the directory".
 */
export function canExportMemory(capability: RuntimeNativeMemoryCapabilityV1): { allowed: boolean; reason: string } {
  if (capability.mechanism === "none") return { allowed: false, reason: "no built-in memory to export" };
  if (capability.control.export === "none") {
    return { allowed: false, reason: `${capability.adapter} exposes no export path; copying the store directly would include indexes and state` };
  }
  return {
    allowed: true,
    reason: `${capability.adapter}: export selected runtime-owned text via ${capability.control.export} — transcripts, indexes, state DBs and provider credentials stay out`,
  };
}
