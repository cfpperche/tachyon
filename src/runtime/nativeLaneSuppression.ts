/**
 * SDD 490 Fatia C — native lane suppression as a typed, fail-closed registry.
 *
 * Formation refuses delivery until `nativeSuppressionConfirmed(adapter)` is true
 * (`packages/engine/src/agents/formation/lifecycleHost.ts`). The suppression receipt covers every enabled human
 * lane at once (`humanLanes.ts`), so a receipt is only honest when the runtime can suppress native
 * delivery of every formation-lane equivalent — not memory alone.
 *
 * Memory disable evidence stays in `nativeMemory.ts`. This module records the **rules/instructions**
 * surface (CLAUDE.md / AGENTS.md / equivalents) and the **combined** gate the host reads.
 *
 * `verified` has exactly one source: a behavioral observation recorded under `sources` with kind
 * `behavioral-test`. Documentation alone may only author `declared` or `unsupported`.
 *
 * Evidence: `docs/research/native-lane-suppression-sdd490-fatia-c.md`.
 */

import { nativeMemoryCapability } from "@tachyon/engine/runtime/nativeMemory.js";

export type LaneSuppressionEvidence = "unsupported" | "declared" | "verified" | "refuted";

export const BEHAVIORAL_LANE_SUPPRESSION_EVIDENCE = ["verified", "refuted"] as const;

export function isBehavioralLaneSuppressionEvidence(evidence: LaneSuppressionEvidence): boolean {
  return (BEHAVIORAL_LANE_SUPPRESSION_EVIDENCE as readonly LaneSuppressionEvidence[]).includes(evidence);
}

/** How Tachyon (or a measurement harness) applies the measured control. */
export type LaneSuppressionControlKind = "none" | "argv" | "config" | "environment" | "private-home-omit";

export interface LaneSurfaceSuppression {
  readonly evidence: LaneSuppressionEvidence;
  readonly control: LaneSuppressionControlKind;
  /**
   * Exact control string measured — argv fragment, config key=value, env assignment, or a short
   * description of private-home omission. Empty only when `control` is `none`.
   */
  readonly controlSpec: string;
  /** One-line note of what was observed (or why it stays declared). */
  readonly note: string;
}

export interface RuntimeNativeLaneSuppressionV1 {
  readonly schemaVersion: 1;
  readonly adapter: string;
  /**
   * Exact runtime version the surfaces below were measured against. Not a floor: a different binary
   * is a different set of facts until re-measured.
   */
  readonly runtimeVersion: string;
  /**
   * Combined gate. `verified` only when every required surface is `verified`. The host reads this
   * through `isNativeSuppressionConfirmed` — never invents a second path.
   */
  readonly evidence: LaneSuppressionEvidence;
  /** Why the combined gate is not `verified`, when it is not. */
  readonly reason?: string;
  readonly surfaces: {
    /**
     * Project/home instruction files: CLAUDE.md, AGENTS.md, and each runtime's equivalent.
     * Maps to the formation instructions lane.
     */
    readonly instructions: LaneSurfaceSuppression;
    /**
     * Companion pointer into the memory registry's disable axis. Stored so a reader does not have to
     * invent the conjunction; the combined `evidence` already applies it.
     */
    readonly memory: LaneSurfaceSuppression;
  };
  readonly sources: ReadonlyArray<{
    readonly kind: "installed-source" | "runtime-doc" | "behavioral-test";
    readonly ref: string;
  }>;
}

const RESEARCH = "docs/research/native-lane-suppression-sdd490-fatia-c.md";
const MEMORY_RESEARCH = "docs/research/runtime-native-memory-parity-t-d4c42e.md";

/**
 * Combined evidence is derived from the surfaces so a hand-edit cannot claim overall `verified`
 * while a surface stays declared. Memory evidence is re-checked against `nativeMemory.ts` at load
 * time for the three measured adapters — the lane registry does not re-author memory findings.
 */
function memorySurfaceFromRegistry(adapter: string, fallbackVersion: string): LaneSurfaceSuppression {
  const mem = nativeMemoryCapability(adapter);
  if (!mem || mem.mechanism === "none") {
    return {
      evidence: "unsupported",
      control: "none",
      controlSpec: "",
      note: `${adapter}: no built-in native memory in the memory registry`,
    };
  }
  const disable = mem.evidence.disable;
  const controlKind: LaneSuppressionControlKind =
    mem.control.disable === "argv"
      ? "argv"
      : mem.control.disable === "environment"
        ? "environment"
        : mem.control.disable === "config"
          ? "config"
          : "none";
  return {
    evidence: disable,
    control: controlKind,
    controlSpec:
      adapter === "claude"
        ? "autoMemoryEnabled:false / CLAUDE_CODE_DISABLE_AUTO_MEMORY=1"
        : adapter === "grok"
          ? "GROK_MEMORY=0"
          : adapter === "codex"
            ? "--disable memories"
            : mem.control.disable,
    note:
      disable === "verified"
        ? `memory disable verified at ${mem.runtimeVersion} (lane record ${fallbackVersion}; see ${MEMORY_RESEARCH})`
        : `memory disable is '${disable}' at ${mem.runtimeVersion} — not verified, so a multi-lane receipt cannot be honest`,
  };
}

function combineEvidence(
  instructions: LaneSurfaceSuppression,
  memory: LaneSurfaceSuppression,
): { evidence: LaneSuppressionEvidence; reason?: string } {
  if (instructions.evidence === "refuted" || memory.evidence === "refuted") {
    return {
      evidence: "refuted",
      reason: "a required surface was measured and failed — see surface notes",
    };
  }
  if (instructions.evidence === "verified" && (memory.evidence === "verified" || memory.evidence === "unsupported")) {
    return { evidence: "verified" };
  }
  const gaps: string[] = [];
  if (instructions.evidence !== "verified") {
    gaps.push(`instructions=${instructions.evidence}`);
  }
  if (memory.evidence !== "verified" && memory.evidence !== "unsupported") {
    gaps.push(`memory=${memory.evidence}`);
  }
  return {
    evidence: "declared",
    reason: `combined gate requires verified instructions and verified-or-unsupported memory — open: ${gaps.join(", ")}`,
  };
}

function entry(
  adapter: string,
  runtimeVersion: string,
  instructions: LaneSurfaceSuppression,
  sources: RuntimeNativeLaneSuppressionV1["sources"],
): RuntimeNativeLaneSuppressionV1 {
  const memory = memorySurfaceFromRegistry(adapter, runtimeVersion);
  const combined = combineEvidence(instructions, memory);
  return {
    schemaVersion: 1,
    adapter,
    runtimeVersion,
    evidence: combined.evidence,
    ...(combined.reason ? { reason: combined.reason } : {}),
    surfaces: { instructions, memory },
    sources,
  };
}

export const RUNTIME_NATIVE_LANE_SUPPRESSION_REGISTRY: Readonly<Record<string, RuntimeNativeLaneSuppressionV1>> = {
  claude: entry(
    "claude",
    "2.1.222",
    {
      evidence: "verified",
      control: "argv",
      controlSpec: "--setting-sources user",
      note:
        "project CLAUDE.md planted marker returned NONE with --setting-sources user; TOKEN returned with user,project and project-only; user-home CLAUDE.md under CLAUDE_CONFIG_DIR still loads (Tachyon-owned private home omits it). --bare also skips CLAUDE.md but refuses OAuth.",
    },
    [
      { kind: "runtime-doc", ref: "claude --help (--bare, --setting-sources)" },
      { kind: "installed-source", ref: "src/harness/HarnessManager.ts (canonical --setting-sources user)" },
      { kind: "behavioral-test", ref: `${RESEARCH}#claude-21222` },
      { kind: "behavioral-test", ref: `${MEMORY_RESEARCH}#claude-2026-07-28-live` },
    ],
  ),
  codex: entry(
    "codex",
    "0.146.0",
    {
      evidence: "verified",
      control: "config",
      controlSpec: "project_doc_max_bytes=0",
      note:
        "AGENTS.md marker TOKEN_X9F2Q returned under default project_doc; NONE with -c project_doc_max_bytes=0; --ignore-rules still returned the marker (execpolicy only).",
    },
    [
      { kind: "runtime-doc", ref: "codex exec --help (--ignore-rules = execpolicy .rules, not AGENTS.md)" },
      { kind: "installed-source", ref: "codex binary config surface project_doc_max_bytes" },
      { kind: "behavioral-test", ref: `${RESEARCH}#codex-01460` },
    ],
  ),
  grok: entry(
    "grok",
    "0.2.118",
    {
      evidence: "declared",
      control: "none",
      controlSpec: "",
      note:
        "grok inspect --json always lists planted AGENTS.md; --system-prompt-override and GROK_MEMORY=0 still return the marker; no argv/env/config disable for project rules. Silence requires file absence (ambient inspector), not a runtime control.",
    },
    [
      { kind: "installed-source", ref: "~/.grok/docs/user-guide/12-project-rules.md" },
      { kind: "runtime-doc", ref: "grok --help (no --no-rules / project-instruction disable)" },
      { kind: "behavioral-test", ref: `${RESEARCH}#grok-02118` },
      { kind: "behavioral-test", ref: `${MEMORY_RESEARCH}#grok-2026-07-28-disable-verified` },
    ],
  ),
};

/** Structural guard: verified surfaces and overall must cite a behavioral-test source. */
export function assertLaneSuppressionEvidenceIsExplained(
  registry: Readonly<Record<string, RuntimeNativeLaneSuppressionV1>> = RUNTIME_NATIVE_LANE_SUPPRESSION_REGISTRY,
): void {
  for (const capability of Object.values(registry)) {
    const behavioral = capability.sources.filter((s) => s.kind === "behavioral-test");
    const surfacesVerified =
      capability.surfaces.instructions.evidence === "verified" || capability.surfaces.memory.evidence === "verified";
    if ((capability.evidence === "verified" || surfacesVerified) && behavioral.length === 0) {
      throw new Error(
        `${capability.adapter}: claims verified lane suppression without a behavioral-test source — the worst outcome Fatia C forbids`,
      );
    }
    if (capability.evidence === "verified") {
      if (capability.surfaces.instructions.evidence !== "verified") {
        throw new Error(`${capability.adapter}: overall verified but instructions is '${capability.surfaces.instructions.evidence}'`);
      }
      if (
        capability.surfaces.memory.evidence !== "verified" &&
        capability.surfaces.memory.evidence !== "unsupported"
      ) {
        throw new Error(`${capability.adapter}: overall verified but memory is '${capability.surfaces.memory.evidence}'`);
      }
    }
    if (capability.surfaces.instructions.control === "none" && capability.surfaces.instructions.controlSpec.trim()) {
      throw new Error(`${capability.adapter}: instructions control is none but controlSpec is non-empty`);
    }
    if (capability.surfaces.instructions.control !== "none" && !capability.surfaces.instructions.controlSpec.trim()) {
      throw new Error(`${capability.adapter}: instructions control '${capability.surfaces.instructions.control}' needs controlSpec`);
    }
  }
}

assertLaneSuppressionEvidenceIsExplained();

export function nativeLaneSuppressionCapability(adapter: string): RuntimeNativeLaneSuppressionV1 | undefined {
  return RUNTIME_NATIVE_LANE_SUPPRESSION_REGISTRY[adapter];
}

/**
 * Host callback for formation: true only when the combined registry entry is `verified`.
 *
 * Unregistered adapters stay false (fail closed). Version is not passed by the lifecycle host today;
 * the registry pins the exact version measured so a reader can re-check the binary before trusting
 * a receipt.
 */
export function isNativeSuppressionConfirmed(adapter: string): boolean {
  const capability = nativeLaneSuppressionCapability(adapter);
  return capability?.evidence === "verified";
}
