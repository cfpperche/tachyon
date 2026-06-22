/**
 * Spec 246 — the spawn-contract: a structured handoff a parent agent must hand a freshly-delegated
 * AI child (the Bridge `spawn_agent` gate). Migrated from Agent0's `delegation-gate` (5-field handoff),
 * but first-class + typed + DELIVERED to the child as its opening brief (not just a presence check).
 *
 * Pure module — no imports from bridge/manager so it stays table-testable. The Bridge handler owns
 * the policy (when to gate); this owns the SHAPE, the substance VALIDATOR (D5), and the brief
 * COMPOSITION (D3 caps).
 */

export interface SpawnContract {
  task: string;
  context: string;
  constraints: string;
  /** Exactly one of deliverable / doneWhen is required (Agent0 parity). */
  deliverable?: string;
  doneWhen?: string;
}

/** Per-slot caps (D3) — truncated (never rejected) when composing the brief; keeps the brief bounded
 *  well under the 2000-char `instructions` input cap, leaving headroom for role template + guidance. */
const SHORT_CAP = 280; // task / deliverable / done_when
const LONG_CAP = 600; // context / constraints
const TOTAL_BRIEF_CAP = 1800;

/** D5 — values that read as un-filled / gamed. Exact (normalized, lowercased) match only. */
const JUNK = new Set(["asdf", "qwer", "tbd", "todo", "n/a", "none", "null", "placeholder", "dummy", "test", "xxx"]);
/** An untouched template placeholder left in the value. */
const PLACEHOLDER_RE = /<[^>]*>|\{\{[^}]*\}\}/;
/** A path/code-like marker — its presence alone clears the "≥2 alphanumeric tokens" substance bar. */
const MARKER_RE = /[/.:_-]/;
const MIN_LEN = 8;

/** Collapse whitespace + trim (D5 normalize). */
export function normalizeField(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Does a normalized value carry real substance (D5)? Empty/placeholder/junk/too-short/single-token-no-marker fail. */
function substantive(v: string): boolean {
  if (!v) return false;
  if (PLACEHOLDER_RE.test(v)) return false;
  if (JUNK.has(v.toLowerCase())) return false;
  if (v.length < MIN_LEN) return false;
  const tokens = v.match(/[A-Za-z0-9]+/g) ?? [];
  return tokens.length >= 2 || MARKER_RE.test(v);
}

/**
 * Validate a spawn contract (D5). Returns the list of human-actionable problems (empty = ok) so the
 * Bridge handler can reject the tool call with a structured message the parent LLM retries against.
 */
export function validateSpawnContract(c: Partial<SpawnContract>): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const slot of ["task", "context", "constraints"] as const) {
    if (!substantive(normalizeField(c[slot]))) {
      errors.push(`${slot}: required — give a substantive value (≥${MIN_LEN} chars, not a placeholder/"${[...JUNK][0]}"-style stub)`);
    }
  }
  const hasDeliverable = !!normalizeField(c.deliverable);
  const hasDoneWhen = !!normalizeField(c.doneWhen);
  if (hasDeliverable && hasDoneWhen) {
    errors.push("deliverable / done_when: provide exactly ONE, not both");
  } else if (!hasDeliverable && !hasDoneWhen) {
    errors.push("deliverable OR done_when: required — name the concrete artifact or the verifiable done condition");
  } else {
    const slot = hasDeliverable ? "deliverable" : "done_when";
    const val = hasDeliverable ? c.deliverable : c.doneWhen;
    if (!substantive(normalizeField(val))) {
      errors.push(`${slot}: give a substantive value (≥${MIN_LEN} chars, not a stub)`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function clip(v: string, cap: number): string {
  const n = normalizeField(v);
  return n.length <= cap ? n : `${n.slice(0, cap - 1).trimEnd()}…`;
}

/**
 * Compose the validated contract (+ optional free-form instructions) into the child's opening brief
 * (D3). Order downstream is role → THIS → guidance (the caller passes this as `instructions` to spawn,
 * which prepends the role template and appends Bridge guidance). Bounded by per-slot + total caps.
 */
export function composeSpawnContractBrief(c: SpawnContract, instructions?: string): string {
  const lines = [
    `TASK: ${clip(c.task, SHORT_CAP)}`,
    `CONTEXT: ${clip(c.context, LONG_CAP)}`,
    `CONSTRAINTS: ${clip(c.constraints, LONG_CAP)}`,
  ];
  if (normalizeField(c.deliverable)) lines.push(`DELIVERABLE: ${clip(c.deliverable!, SHORT_CAP)}`);
  else if (normalizeField(c.doneWhen)) lines.push(`DONE_WHEN: ${clip(c.doneWhen!, SHORT_CAP)}`);
  let brief = lines.join("\n");
  const extra = normalizeField(instructions);
  if (extra) brief = `${brief}\n\n${extra}`;
  return brief.length <= TOTAL_BRIEF_CAP ? brief : `${brief.slice(0, TOTAL_BRIEF_CAP - 1).trimEnd()}…`;
}
