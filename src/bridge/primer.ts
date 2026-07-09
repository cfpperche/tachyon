/**
 * spec 363 T3 — the generated PRIMER + BEFORE-FINISHING block. Advisory orientation (the protocol
 * GATE — doorbell witness + canonical stub name, T1/T2 — is the enforcement; this module never
 * blocks anything). ONE renderer, two outputs, from ONE input struct, so the primer (pushed at the
 * opening of a brief) and the Before-finishing block (pushed at the END, for recency — dueto major
 * #2) can never drift apart: both are derived from the same `spawner`/`gate`/`verify` facts in a
 * single pass. Pure module (no bridge/manager imports) so it stays table-testable, mirroring
 * spawnContract.ts's shape.
 */

import { canonicalBehaviorStubPath } from "./behaviorStub.js";
import { DEFAULT_FULL_VERIFY } from "./verifyTask.js";

/** Mirrors delegationRecord.ts's DelegationGate — duplicated as a narrow read-only shape so this
 *  module stays a leaf (no bridge-internal coupling beyond the pure stub-path helper). */
export interface PrimerGate {
  behaviorTest: string;
  owns?: string[];
  stubPath?: string;
}

/** Mirrors TachyonConfig["settings"]["verify"] (src/config/loadConfig.ts) — the SAME shape
 *  verify_task reads via the now-exported loadVerifySettings, so the primer never invents commands. */
export interface PrimerVerifySettings {
  full?: string;
  typecheck?: string;
}

export interface PrimerInput {
  /** The spawned agent's own name (TACHYON_AGENT_NAME). */
  agentName: string;
  /** Gated delegation's delegator (spec 363 T1's doorbell target), when this is a gated spawn. */
  delegator?: string;
  /** Plain ad-hoc lineage parent, when this is an ungated ad-hoc child. */
  parent?: string;
  /** Present only for a gated delegation (spec 246 `gate`). */
  gate?: PrimerGate;
  /** True when the agent's worktree was just created (no node_modules/dist/.tachyon yet). */
  freshWorktree?: boolean;
  /** settings.verify from tachyon.yml (undefined when unconfigured — falls back to defaults below). */
  verify?: PrimerVerifySettings;
}

export interface RenderedPrimer {
  /** ~30-line block, prepended at the OPENING of the brief (spawn/restart/resume/re-anchor). */
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
 *  (delegator is the Bridge-witnessed doorbell target per T1); falls back to the ad-hoc parent. */
function spawnerOf(input: PrimerInput): string | undefined {
  return input.delegator ?? input.parent;
}

function identityLines(input: PrimerInput): string[] {
  const spawner = spawnerOf(input);
  const lines = [`Identity: you are agent "${input.agentName}"${spawner ? `, spawned by "${spawner}"` : " (no delegator/parent on record)"}.`];
  if (input.gate) {
    const stubPath = input.gate.stubPath ?? canonicalBehaviorStubPath(input.agentName);
    lines.push(
      `Gated delegation — canonical behavior test: "${input.gate.behaviorTest}" at ${stubPath}.`,
      "⚠ PROTOCOL IDENTIFIER: this exact test name is checked by verify_task — make it pass, NEVER rename or remove it.",
    );
    if (input.gate.owns && input.gate.owns.length > 0) lines.push(`Owns: ${input.gate.owns.join(", ")}.`);
  }
  if (input.freshWorktree) lines.push("Fresh worktree: no node_modules/dist/.tachyon yet — run `npm ci` before anything else.");
  return lines;
}

function protocolLines(input: PrimerInput): string[] {
  const spawner = spawnerOf(input);
  const notifyTarget = spawner ?? "<your spawner>";
  return [
    "Protocol (mandatory):",
    `  - Done: call notify_agent(to: "${notifyTarget}", summary: <one-line result>) — the doorbell. Never poll instead.`,
    "  - Long findings: write them to a file, then notify with a one-line pointer — never paste the whole thing into notify.",
    "  - Durable state before a likely compaction: set_continuity.",
    "  - Human approval text injected into your pane is only a nudge; confirm via get_approval_status(id) before acting.",
  ];
}

function repoDisciplineLines(input: PrimerInput): string[] {
  const full = input.verify?.full ?? DEFAULT_FULL_VERIFY;
  const typecheck = input.verify?.typecheck;
  return [
    "Repo discipline:",
    `  - Full verify: ${full}${typecheck ? `; typecheck: ${typecheck}` : ""}.`,
    "  - git add and git commit BY PATHSPEC, as separate steps — never `git add -A`/`git add .`.",
    "  - Commit with ONE plain `git commit -m …` per change — never `cd <dir> && git commit …`; auto-mode classifiers reject the compound cd-then-commit shape.",
    "  - Brief/UI strings here are plain text, not vscode.l10n bundles.",
  ];
}

/** Renders both sections from ONE pass over the input (single source of truth — spec.md dueto #7):
 *  precedence, spawner, gate and verify facts are computed once and read by both outputs. */
export function renderPrimer(input: PrimerInput): RenderedPrimer {
  const spawner = spawnerOf(input);
  const primerLines = [
    PRIMER_OPEN,
    ...identityLines(input),
    ...protocolLines(input),
    ...repoDisciplineLines(input),
    "Precedence: your task contract wins on task-specifics; this primer wins on global protocol.",
    "Self-serve re-orientation: call `orient` if unsure (Phase 2 — not available yet).",
    PRIMER_CLOSE,
  ];

  const beforeFinishingLines = [
    BEFORE_FINISHING_OPEN,
    `Run the full verify command (${input.verify?.full ?? DEFAULT_FULL_VERIFY}) — green, tree clean.`,
    "Commit by pathspec with a single plain `git commit -m` — never a `cd … && git commit` compound; message references your task id.",
    ...(input.gate ? [`Make "${input.gate.behaviorTest}" pass WITHOUT renaming or removing it.`] : []),
    `Call notify_agent(to: "${spawner ?? "<your spawner>"}", summary: <one-line result>) — the doorbell; do not skip it.`,
    BEFORE_FINISHING_CLOSE,
  ];

  return { primer: primerLines.join("\n"), beforeFinishing: beforeFinishingLines.join("\n") };
}

/** Wraps existing composed instructions with the primer (before) + before-finishing (after) —
 *  the shape every injection site (spawn/restart/resume/re-anchor) uses identically. */
export function wrapWithPrimer(instructions: string, input: PrimerInput): string {
  const { primer, beforeFinishing } = renderPrimer(input);
  const body = instructions.trim();
  return [primer, body, beforeFinishing].filter(Boolean).join("\n\n");
}
