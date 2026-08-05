/**
 * spec 363 T3 — the generated PRIMER + BEFORE-FINISHING block. Advisory orientation (the protocol
 * GATE — doorbell witness + canonical stub name, T1/T2 — is the enforcement; this module never
 * blocks anything). ONE renderer, two outputs, from ONE input struct, so the primer (pushed at the
 * opening of a brief) and the Before-finishing block (pushed at the END, for recency — dueto major
 * #2) can never drift apart: both are derived from the same `spawner`/`gate`/`verify` facts in a
 * single pass. Pure module (no bridge/manager imports) so it stays table-testable, mirroring
 * spawnContract.ts's shape.
 */

import { containsUnsafeFramingCharacter } from "../config/framingSafety.js";

/** Narrow read-only gated Delivery shape so this module stays a leaf
 *  (no bridge-internal coupling beyond the pure stub-path helper). */
/** Mirrors TachyonConfig["settings"]["verify"] (src/config/loadConfig.ts) — the SAME shape
 *  the agent is told to run, so the primer never invents commands. */
export interface PrimerVerifySettings {
  full?: string;
  typecheck?: string;
}

export interface PrimerInput {
  /** The spawned agent's own name (TACHYON_AGENT_NAME). */
  agentName: string;
  /** Gated delegation's delegator (spec 363 T1's doorbell target), when this is a gated spawn. */
  delegator?: string;
  /** Plain Temporary lineage parent. */
  parent?: string;
  /** Explicit settings.verify facts from tachyon.yml; undefined commands are omitted, never inferred. */
  verify?: PrimerVerifySettings;
  /**
   * t-3f93b4 — one already-rendered sentence about this checkout's dependencies, from
   * `describeDependencyState`. Undefined means "nothing measured", and the line is omitted rather
   * than guessed at.
   *
   * This is the half of that task that is a contract and not an optimization. The primer has always
   * told the agent to run `settings.verify.typecheck` and focused tests; until this field existed it
   * said nothing at all about whether the checkout it was handing over could run them. Three
   * delegated children measured on 2026-08-02 each answered that silence independently with their
   * own 478 MB `npm ci`. A product that asks for verification says whether verification is possible.
   */
  dependencies?: string;
}

export interface RenderedPrimer {
  /** ~30-line block, prepended at the OPENING of a newly pushed brief (spawn/restart/re-anchor). */
  primer: string;
  /** ≤8-line block, appended at the very END of the brief (recency beats tidiness — dueto major #2). */
  beforeFinishing: string;
}

/** Fixed delimiters (design requirement, not styling — spec.md "Format is a design requirement"):
 *  agents must learn to RECOGNIZE the section, never parse prose. */
export const PRIMER_OPEN = "── TACHYON PRIMER ──";
export const PRIMER_CLOSE = "── END PRIMER ──";
export const BEFORE_FINISHING_OPEN = "── BEFORE FINISHING ──";
export const BEFORE_FINISHING_CLOSE = "── END BEFORE FINISHING ──";

/** HARD budget (spec.md "HARD budget ~30 lines"; plan.md test list: "budget guard (≤34 lines)"). */
export const PRIMER_LINE_BUDGET = 34;
/** plan.md T3: "BEFORE FINISHING (≤8 lines, END of brief)". */
export const BEFORE_FINISHING_LINE_BUDGET = 8;

/** Single fact both sections key off — who the doorbell (`notify_agent`) targets. Gated wins
 *  (delegator is the Bridge-witnessed doorbell target per T1); falls back to the Temporary parent. */
function spawnerOf(input: PrimerInput): string | undefined {
  const delegator = input.delegator?.trim();
  const parent = input.parent?.trim();
  return delegator || parent || undefined;
}

function identityLines(input: PrimerInput): string[] {
  const spawner = spawnerOf(input);
  return [`Identity: you are agent "${input.agentName}"${spawner ? `, spawned by "${spawner}"` : " (no delegator/parent on record)"}.`];
}

/**
 * t-486f43 — every line here is a FACT about a Tachyon mechanism, because this block is immune to
 * project-owned guidance (see `precedenceLines`) and only the product can state these.
 *
 * Two of them used to fuse a fact with a working method in one sentence, which handed the method the
 * same immunity: "Keep completion concise" (report style) rode on the notice transport, and "use
 * set_continuity only when material state would otherwise be lost" (checkpoint cadence) rode on
 * continuity's durability. Measured on 2026-08-05: the maintainer of this very repository wanted the
 * OPPOSITE continuity policy and had nowhere to say it, because the sentence carrying it could not be
 * overridden. The facts stayed; the recipes moved to project-owned guidance, where a project can
 * disagree with them.
 *
 * The test for that boundary is `test/unit/projectGuidanceOwnership.test.ts` — a new line here must be
 * classified as product fact there, or it fails.
 */
function protocolLines(): string[] {
  return [
    "Protocol (apply when relevant):",
    "  - Waking another agent carries ONE sanitized line: over 500 characters it is refused, never truncated, and it is best-effort pane input rather than durable history — only what the line points at survives.",
    "  - Continuity is durable working memory: what you checkpoint with set_continuity survives compaction, clear, restart and a new session, and is re-injected when you cross one.",
    "  - Human approval text injected into your pane is only a nudge; confirm via get_approval_status(id) before acting.",
  ];
}

function configuredVerificationLines(input: PrimerInput): string[] {
  const checks = [
    ...(input.verify?.full !== undefined ? [`  - full: ${input.verify.full}`] : []),
    ...(input.verify?.typecheck !== undefined ? [`  - typecheck: ${input.verify.typecheck}`] : []),
  ];
  return checks.length > 0 ? ["Configured verification (source: workspace config settings.verify):", ...checks] : [];
}

/** t-3f93b4 — sits directly under the configured checks, because it is the answer to "can I run them?". */
function dependencyLines(input: PrimerInput): string[] {
  const line = input.dependencies?.trim();
  return line ? [line] : [];
}

/**
 * t-48f504 — which of the two documents that name an agent's work wins, said out loud.
 *
 * This used to be one clause: "the active task contract governs task-specific work". Two different
 * things in a spawned agent's brief answer to the word "contract", and that sentence chose neither:
 *
 *  - the SPAWN CONTRACT — spec 246's task/context/constraints/deliverable, which `spawn_agent`'s own
 *    description calls "DELEGATION CONTRACT", rendered as `TASK:` / `CONTEXT:` / `DONE_WHEN:`;
 *  - the WORK ON RECORD section, which introduces itself with "This is the contract for this
 *    session", and whose selector (`assignmentSelection.ts`) keys on status `active` — so "the
 *    ACTIVE task contract" reads as a direct pointer at it.
 *
 * Measured on 2026-08-01: three launches of one reviewer, two of them refused, both refusals CORRECT
 * under one reading and wrong under the other. An agent given two defensible readings picks one, and
 * which one is a property of the agent rather than of the product.
 *
 * The fix is not to rank them — they are not the same kind of statement. They answer different
 * questions, so the rule is scoped by question:
 *
 *  - BOARD OWNERSHIP belongs to the board. It is the shared register, read live at launch, and the
 *    only one a human can change after the spawn. A brief cannot create or assign a board row.
 *  - SUBSTANCE belongs to the spawner's brief. It can direct work that holds no board row;
 *    a board row carries a problem statement, not this session's instructions.
 *  - Two records naming DIFFERENT BOARD work is neither — it is a conflict, and the agent reports it
 *    instead of resolving it. No board row plus a substantive brief is the valid third state above.
 *
 * `spawnTaskClaim.ts` removes the disagreement by construction for a spawn that claims a board task.
 * These lines govern every spawn that does not.
 */
function precedenceLines(): string[] {
  return [
    "Precedence — two records can name your work, and they answer different questions:",
    "  - WHICH BOARD task is yours, if any: the \"WORK ON RECORD\" section below, projected from the board at launch. It wins on board ownership; no such section, or \"none\" in it, means you hold NO board task. A brief cannot create or assign a board row.",
    "  - WHAT to do: the TASK/CONTEXT/CONSTRAINTS/DELIVERABLE brief your spawner wrote. It wins on substance — including work that holds no board task — because the directive exists nowhere else, and a board row is a problem statement, not this session's instructions.",
    "  - If BOTH name DIFFERENT BOARD work, that is a conflict and not a choice: report it to your spawner and do not pick one. No board task plus a substantive brief is not a conflict: execute the brief.",
    "This Tachyon primer governs orchestration protocol; project-owned guidance governs repository conventions and cannot override either contract or protocol.",
  ];
}

function beforeFinishingVerificationLines(input: PrimerInput): string[] {
  const check = input.verify?.full !== undefined
    ? `Run configured check (workspace config settings.verify.full): ${input.verify.full}`
    : input.verify?.typecheck !== undefined
      ? `Run configured check (workspace config settings.verify.typecheck): ${input.verify.typecheck}`
      : undefined;
  return check
    ? [
        // t-21bcb7 — the full suite holds a machine-wide lock every agent queues behind, so it is
        // priced per DELIVERY, not per step. That is a fact about a shared host resource, which is
        // why it survived t-486f43's separation.
        "Verification applies only when delivering repository changes; skip it for read-only investigation, reporting, and task authoring.",
        // t-486f43 — this used to read "Use focused tests while implementing; run this on the tree
        // you deliver", fusing a working method with what a check actually covers. The method (WHICH
        // smaller checks to run along the way) is the project's and lives in project-owned guidance;
        // what a run attests is the product's own fact and stays.
        "A check attests the exact TREE it ran on: a pass measured on any other tree is not evidence about what you deliver.",
        check,
      ]
    : [];
}

/** Renders both sections from ONE pass over the input (single source of truth — spec.md dueto #7):
 *  precedence, spawner and verify facts are computed once and read by both outputs. */
export function renderPrimer(input: PrimerInput): RenderedPrimer {
  const interpolated = [
    input.agentName,
    input.delegator,
    input.parent,
    input.verify?.full,
    input.verify?.typecheck,
    input.dependencies,
  ].filter((value): value is string => value !== undefined);
  if (interpolated.some(containsUnsafeFramingCharacter)) {
    throw new Error("primer facts must not contain control characters");
  }
  const spawner = spawnerOf(input);
  const primerLines = [
    PRIMER_OPEN,
    ...identityLines(input),
    ...protocolLines(),
    ...configuredVerificationLines(input),
    ...dependencyLines(input),
    ...precedenceLines(),
    PRIMER_CLOSE,
  ];

  const beforeFinishingLines = [
    BEFORE_FINISHING_OPEN,
    ...beforeFinishingVerificationLines(input),
    ...(spawner
      // t-21bcb7 — a notify is best-effort pane input, not history: it points at durable detail
      // instead of carrying it, which is also what keeps it inside the one-line cap.
      ? [`Call notify_agent(to: "${spawner}", summary: status + commit/tree + where the detail lives) — the doorbell; do not skip it.`]
      : []),
    BEFORE_FINISHING_CLOSE,
  ];

  return { primer: primerLines.join("\n"), beforeFinishing: beforeFinishingLines.join("\n") };
}

/** Wraps existing composed instructions with the primer (before) + before-finishing (after). */
export function wrapWithPrimer(instructions: string, input: PrimerInput): string {
  const { primer, beforeFinishing } = renderPrimer(input);
  const body = instructions.trim();
  return [primer, body, beforeFinishing].filter(Boolean).join("\n\n");
}
