/**
 * Spec 257 (D7, OQ5) — probe archetypes: a structured brief + a MACHINE output contract, selectable
 * per probe. The framing guard is a PROPERTY OF THE ARCHETYPE, not something the caller hand-writes
 * each time — `adversarial-review` carries the anti-bias "disagree, find what's wrong" instruction;
 * `factual-verify` carries the anti-fabrication "cite, separate verified from unverified" instruction.
 * Each defines an output schema (so phase-2 pipeline/verify consumption is free); the prose answer is
 * still available. `freeform` is the prose-only escape hatch. Output that doesn't match the schema is
 * a non-compliance the caller surfaces as `parse_error` (D4). Pure module — no fs/spawn.
 */

export type ArchetypeId = "adversarial-review" | "factual-verify" | "freeform";

export type Severity = "blocker" | "major" | "minor";
export interface Finding {
  title: string;
  severity: Severity;
  target?: string;
  problem: string;
  fix?: string;
}
export interface AdversarialReviewOutput {
  findings: Finding[];
  mostImportant?: string;
}

export type Verdict = "true" | "false" | "unverifiable";
export interface Claim {
  claim: string;
  verdict: Verdict;
  confidence?: string;
  evidence?: string;
}
export interface FactualVerifyOutput {
  claims: Claim[];
}

export interface ArchetypeBrief {
  task: string;
  context?: string;
  constraints?: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Archetype<T = unknown> {
  readonly id: ArchetypeId;
  /** the framing guard (anti-bias / anti-fabrication) — prepended to every brief. */
  readonly framing: string;
  /** how the model must shape its answer (the output contract). */
  readonly outputInstruction: string;
  /** validate the model's final message against the contract (non-compliant → parse_error upstream). */
  validate(lastMessage: string): Validation<T>;
}

const PROBE_BOUNDARY =
  "You are running as a bounded Tachyon probe. Do NOT inspect the filesystem, run shell commands, browse, " +
  "or use tools. Base your answer only on the TASK, CONTEXT, and CONSTRAINTS below. If the provided context is " +
  "insufficient, say what is unverifiable instead of exploring.";

const ADVERSARIAL_FRAMING =
  "You are an INDEPENDENT, ADVERSARIAL reviewer. Your job is to DISAGREE and find what is wrong, weak, " +
  "missing, or over/under-engineered. Confirmation is useless; do not summarize or compliment. If you " +
  "find yourself agreeing, push harder for where it breaks.";

const FACTUAL_FRAMING =
  "You are a FACT-CHECKER. Do NOT fabricate. For each claim, cite concrete evidence and clearly separate " +
  "what you can VERIFY from what you cannot. Prefer 'unverifiable' over a guess.";

/** Pull the first JSON object out of a model message (fenced ```json block, else first balanced braces). */
export function extractJsonObject(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c) as unknown;
    } catch {
      /* try next */
    }
  }
  return null;
}

const SEVERITIES: ReadonlySet<string> = new Set<Severity>(["blocker", "major", "minor"]);
const VERDICTS: ReadonlySet<string> = new Set<Verdict>(["true", "false", "unverifiable"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export const adversarialReview: Archetype<AdversarialReviewOutput> = {
  id: "adversarial-review",
  framing: ADVERSARIAL_FRAMING,
  outputInstruction:
    'Return ONLY a JSON object: {"findings":[{"title","severity":"blocker|major|minor","target","problem","fix"}],"mostImportant"}.',
  validate(lastMessage) {
    const o = extractJsonObject(lastMessage);
    if (!isObj(o) || !Array.isArray(o.findings)) return { ok: false, error: "missing findings[]" };
    const findings: Finding[] = [];
    for (const f of o.findings) {
      if (!isObj(f) || typeof f.title !== "string" || typeof f.problem !== "string" || !SEVERITIES.has(f.severity as string)) {
        return { ok: false, error: "a finding is missing title/problem/severity" };
      }
      findings.push({
        title: f.title,
        severity: f.severity as Severity,
        problem: f.problem,
        target: typeof f.target === "string" ? f.target : undefined,
        fix: typeof f.fix === "string" ? f.fix : undefined,
      });
    }
    return { ok: true, value: { findings, mostImportant: typeof o.mostImportant === "string" ? o.mostImportant : undefined } };
  },
};

export const factualVerify: Archetype<FactualVerifyOutput> = {
  id: "factual-verify",
  framing: FACTUAL_FRAMING,
  outputInstruction: 'Return ONLY a JSON object: {"claims":[{"claim","verdict":"true|false|unverifiable","confidence","evidence"}]}.',
  validate(lastMessage) {
    const o = extractJsonObject(lastMessage);
    if (!isObj(o) || !Array.isArray(o.claims)) return { ok: false, error: "missing claims[]" };
    const claims: Claim[] = [];
    for (const c of o.claims) {
      if (!isObj(c) || typeof c.claim !== "string" || !VERDICTS.has(c.verdict as string)) {
        return { ok: false, error: "a claim is missing claim/verdict" };
      }
      claims.push({
        claim: c.claim,
        verdict: c.verdict as Verdict,
        confidence: typeof c.confidence === "string" ? c.confidence : undefined,
        evidence: typeof c.evidence === "string" ? c.evidence : undefined,
      });
    }
    return { ok: true, value: { claims } };
  },
};

/** The escape hatch — no schema; the prose answer is the value. */
export const freeform: Archetype<string> = {
  id: "freeform",
  framing: "",
  outputInstruction: "",
  validate(lastMessage) {
    return { ok: true, value: lastMessage };
  },
};

const ARCHETYPES: Record<ArchetypeId, Archetype<unknown>> = {
  "adversarial-review": adversarialReview as Archetype<unknown>,
  "factual-verify": factualVerify as Archetype<unknown>,
  freeform: freeform as Archetype<unknown>,
};

export function getArchetype(id: ArchetypeId): Archetype<unknown> {
  return ARCHETYPES[id];
}

/** Compose the full prompt: framing guard → task/context/constraints → output contract. */
export function composeBrief(id: ArchetypeId, brief: ArchetypeBrief): string {
  const a = getArchetype(id);
  const parts: string[] = [PROBE_BOUNDARY];
  if (a.framing) parts.push(a.framing);
  parts.push(`TASK: ${brief.task}`);
  if (brief.context) parts.push(`CONTEXT: ${brief.context}`);
  if (brief.constraints) parts.push(`CONSTRAINTS: ${brief.constraints}`);
  if (a.outputInstruction) parts.push(a.outputInstruction);
  return parts.join("\n\n");
}
