/**
 * Spec 246 — the spawn-contract: a structured handoff a parent agent must hand a freshly-delegated
 * AI child (the Bridge `spawn_agent` gate). Modeled on a `delegation-gate` 5-field handoff,
 * but first-class + typed + DELIVERED to the child as its opening brief (not just a presence check).
 *
 * Pure module — no imports from bridge/manager so it stays table-testable. The Bridge handler owns
 * the policy (when to gate); this owns the SHAPE, the substance VALIDATOR (D5), and the brief
 * COMPOSITION (D3) — lossless, backstopped by an explicit MAX_CONTRACT_CHARS rejection (t-11a2d1).
 */

import type { SpawnActorKind } from "./spawnActor.js";

export interface SpawnContract {
  task: string;
  context: string;
  constraints: string;
  /** Exactly one of deliverable / doneWhen is required (delegation-gate parity). */
  deliverable?: string;
  doneWhen?: string;
}

export type SpawnContractCompletion = "deliverable" | "done_when";

/**
 * t-11a2d1 — composition used to silently CLIP each slot to a per-field cap and the whole brief to
 * a 1800-char total, so a real coordinator contract (2-6KB observed in the wild) lost content the
 * caller never knew was cut — the durable Delivery persisted the full contract, but the CHILD never
 * saw the missing part. Now that briefFile.ts's deliverableBody diverts an over-threshold (4000
 * char) composed body to the agent's brief file instead of inlining it into the tmux pane,
 * composition no longer needs to shrink anything to fit a pane budget: it's LOSSLESS, delivered in
 * full either inline or via the file. MAX_CONTRACT_CHARS below is the only remaining backstop — a
 * hard ceiling against a genuinely pathological paste, enforced by an EXPLICIT rejection (the
 * caller gets an actionable error) rather than a silent truncation.
 */
const TASK_JOURNAL_GUIDANCE_SEPARATOR = "\n\n";
/** Hard ceiling on the composed contract body (task+context+constraints+deliverable/done_when+
 *  instructions, before the fixed guidance suffixes). Real contracts run 2-6KB — this leaves >10x
 *  headroom while still catching a runaway paste (e.g. a whole log file dropped into `context`). */
const MAX_CONTRACT_CHARS = 64 * 1024;

/** D5 — values that read as un-filled / gamed. Exact (normalized, lowercased) match only. */
const JUNK = new Set(["asdf", "qwer", "tbd", "todo", "n/a", "none", "null", "placeholder", "dummy", "test", "xxx"]);
/** An untouched template placeholder — the ENTIRE value is nothing but "<...>" / "{{...}}" (anchored: a
 *  real sentence that merely mentions a code/doc placeholder like "<select>" or "<id>" mid-string is fine;
 *  see t-5bcfa3, where this used to be unanchored and rejected substantive prose over an embedded tag). */
const PLACEHOLDER_RE = /^(<[^>]*>|\{\{[^}]*\}\})$/;
/** A path/code-like marker — its presence alone clears the "≥2 alphanumeric tokens" substance bar. */
const MARKER_RE = /[/.:_-]/;
const MIN_LEN = 8;

/** Collapse whitespace + trim (D5 normalize). */
export function normalizeField(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Structural completion discriminator shared by fresh composition and persisted-ledger parsing.
 * Empty strings are absent; zero or two populated fields are invalid and never fall back to DONE_WHEN. */
export function spawnContractCompletion(
  contract: Pick<SpawnContract, "deliverable" | "doneWhen">,
): SpawnContractCompletion | undefined {
  const hasDeliverable = normalizeField(contract.deliverable).length > 0;
  const hasDoneWhen = normalizeField(contract.doneWhen).length > 0;
  if (hasDeliverable === hasDoneWhen) return undefined;
  return hasDeliverable ? "deliverable" : "done_when";
}

/** Non-whitespace codepoint count — punctuation (em-dash, arrows, curly quotes) counts same as ASCII;
 *  never inflate/deflate length by counting UTF-16 surrogate-pair units instead of real codepoints. */
function substanceLength(v: string): number {
  return Array.from(v.replace(/\s/g, "")).length;
}

/** Does a normalized value carry real substance (D5)? Empty/placeholder/junk/too-short/single-token-no-marker fail. */
function substantive(v: string): boolean {
  if (!v) return false;
  if (PLACEHOLDER_RE.test(v)) return false;
  if (JUNK.has(v.toLowerCase())) return false;
  if (substanceLength(v) < MIN_LEN) return false;
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

/**
 * spec 332 — the delegation contract's completion-notification guidance. Always appended in full
 * by composeSpawnContractBrief (dueto F5: the completion contract must never be lost to truncation
 * — t-11a2d1 replaced truncation with an explicit reject, so an over-cap contract now gets no brief
 * at all rather than one missing this) and ADDITIVE to the human-facing completion reporting, never
 * a replacement (dueto F6).
 */
export function notifyParentGuidance(parent: string): string {
  return (
    `When the deliverable/done_when is met, call notify_agent(to: "${parent}", summary: <one-line result>) ` +
    `so '${parent}' wakes up — in ADDITION to (not instead of) your normal completion reporting (a handoff note or the deliverable itself).`
  );
}

/**
 * t-8605be part 3 — behavioral guidance so a delegated child doesn't block on an interactive prompt
 * (dueto: the fixPair case — a Temporary opened AskUserQuestion and sat in needs-input, unreachable
 * until a human noticed the badge, even though its own contract already contained the answer). Only
 * meaningful when there's a parent to route a decision fork to (same gate as notifyParentGuidance);
 * always appended in full by composeSpawnContractBrief, same treatment as notifyParentGuidance.
 */
export function noInteractivePromptGuidance(parent: string): string {
  return (
    `Don't block on an interactive prompt: route decision forks to your parent ` +
    `(notify_agent(to: "${parent}", summary: <the question>)) instead of blocking on a human. If a tool ` +
    "you're using opens one anyway (no way around it), answer with the most reasonable choice yourself " +
    "and record what you answered and why (a handoff note or your completion report) — don't sit idle " +
    "waiting for a human to notice."
  );
}

export function taskJournalGuidance(): string {
  return (
    "Task-local notes policy: blocker/decision while working an existing task -> append_task_note(taskId, text); " +
    "new follow-up work -> create_task; cross-cutting human reminder -> create_pin. Examples: " +
    "blocked by missing API key on t-abc123 -> append_task_note; found separate docs cleanup -> create_task; " +
    "remember to discuss roadmap risk with the human -> create_pin."
  );
}

/**
 * The waiting guidance handed to a contract-skipped spawn — an agent parked until a human or a
 * coordinator assigns it something. Lives here, beside the other fixed protocol renderings, so
 * `briefCarriesTaskSubstance` can recognize it from the same literal the Bridge emits.
 */
export function idleSpawnGuidance(skipReason: string): string {
  return [
    "Task: absent — awaiting assignment.",
    `Recorded skip reason: ${normalizeField(skipReason)}`,
    "Wait for a direct task assignment. Do not scan unrelated tasks, pins, or continuity and do not invent work.",
  ].join("\n");
}

/**
 * t-e3aaae — the fixed protocol blocks this module (and the contract-skipped spawn path) emit
 * AROUND task substance. Recognized by their opening literal, which is fixed protocol text rather
 * than caller input, so an agent name or parent name interpolated into one never defeats the match.
 *
 * Why this exists: `def.taskBrief` is one flat string that carries both the protocol boilerplate and
 * the task, so "is there a task?" was answered by "is the string non-empty?". A brief made of
 * nothing but these blocks is non-empty and yet says nothing about what to do — and a restart
 * re-delivering such a row announced `task brief (present)` over pure boilerplate (measured: agent
 * `claude-opus5`, whose persisted brief was identity + doorbell + no-blocking guidance and nothing
 * else). Presence must be a claim about substance, so it is measured on the residue.
 */
const PROTOCOL_BOILERPLATE_OPENINGS: RegExp[] = [
  /^You are agent \S+ \(that is also the value of your \$TACHYON_AGENT_NAME env var\)\./,
  /^When the deliverable\/done_when is met, call notify_agent\(to: "/,
  /^Don't block on an interactive prompt: /,
  /^Task-local notes policy: /,
  /^Task: absent — awaiting assignment\./,
  /^Recorded skip reason: /,
  /^Wait for a direct task assignment\./,
];

/**
 * The part of a composed brief that is NOT fixed protocol boilerplate — i.e. what the agent was
 * actually told to do. Blank-line separated blocks are the composition unit every renderer above
 * joins on, so classification happens per block and a real task sitting beside boilerplate survives.
 */
export function briefTaskSubstance(brief: string | undefined): string {
  if (!brief) return "";
  return brief
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block && !PROTOCOL_BOILERPLATE_OPENINGS.some((pattern) => pattern.test(block)))
    .join("\n\n");
}

/** True when a composed brief carries task substance of its own, not just protocol boilerplate. */
export function briefCarriesTaskSubstance(brief: string | undefined): boolean {
  return briefTaskSubstance(brief).length > 0;
}

/**
 * t-d7b3a9 layer A — the very first line a freshly-spawned child reads: its own name, said outright.
 * TACHYON_AGENT_NAME is injected into every spawn's env (AgentManager.ts) but nothing ever told the
 * agent that, so a child guesses parent/sender fields from context instead of reading them off the
 * env — dueto: claude-2 spawned codex-review with a guessed parent, then codex-review notified with a
 * guessed sender, both wrong within the same hour. Always prepended in full by
 * composeSpawnContractBrief (same treatment as notifyParentGuidance) and placed FIRST so nothing
 * about a long task/context ever costs the agent its own identity.
 */
export function identityLine(name: string): string {
  return (
    `You are agent ${name} (that is also the value of your $TACHYON_AGENT_NAME env var). ` +
    `Use this EXACT name whenever a Bridge tool asks for your own agent name — parent, agent, sender, caller — never guess it.`
  );
}

/**
 * Compose the validated contract (+ optional free-form instructions) into the child's opening brief.
 * Order downstream is persistent instructions → THIS → guidance (the caller passes this as `instructions` to spawn,
 * which appends Bridge guidance). LOSSLESS: no slot is truncated —
 * AgentManager.effectiveCmd diverts an over-threshold body to the agent's brief file (briefFile.ts)
 * before it ever reaches tmux, so the full contract always reaches the child, inline or via file.
 * The identity line (before) and the spec-332 notify-parent guidance (when `parent` is given, after)
 * are always appended in full regardless of contract size.
 *
 * Throws when the composed body (contract slots + optional instructions) exceeds MAX_CONTRACT_CHARS
 * (64KB) — an explicit, actionable rejection instead of the silent clipping this replaces.
 */
export function composeSpawnContractBrief(name: string, c: SpawnContract, instructions?: string, parent?: string): string {
  const lines = [`TASK: ${normalizeField(c.task)}`, `CONTEXT: ${normalizeField(c.context)}`, `CONSTRAINTS: ${normalizeField(c.constraints)}`];
  if (normalizeField(c.deliverable)) lines.push(`DELIVERABLE: ${normalizeField(c.deliverable!)}`);
  else if (normalizeField(c.doneWhen)) lines.push(`DONE_WHEN: ${normalizeField(c.doneWhen!)}`);
  let brief = lines.join("\n");
  const extra = normalizeField(instructions);
  if (extra) brief = `${brief}\n\n${extra}`;
  if (brief.length > MAX_CONTRACT_CHARS) {
    throw new Error(
      `spawn_agent contract is ${brief.length} chars, over the ${MAX_CONTRACT_CHARS}-char (64KB) hard cap — ` +
        "trim task/context/constraints/deliverable/done_when/instructions and retry. (A large-but-reasonable " +
        "contract is delivered to the child in full via its brief file, not truncated — this cap only rejects " +
        "a genuinely pathological paste.)",
    );
  }
  const journalGuidance = taskJournalGuidance();
  const withJournal = `${brief}${TASK_JOURNAL_GUIDANCE_SEPARATOR}${journalGuidance}`;
  const withGuidance = parent ? `${withJournal}\n\n${notifyParentGuidance(parent)}\n\n${noInteractivePromptGuidance(parent)}` : withJournal;
  return `${identityLine(name)}\n\n${withGuidance}`;
}

/**
 * t-6fe04b — one wording for one rule, refused twice.
 *
 * A refusal that only says what NOT to do gets worked around. In the incident behind t-e787dc the
 * caller met this rule, was told to "omit cwd or spawn without parent", and instead wrote an
 * absolute path into the child's BRIEFING — outside every guardrail the refusal existed to protect.
 * So the message names the governed alternative, and the Bridge and the AgentManager say the same
 * sentence: two refusals disagreeing about the way out would be worse than one.
 *
 * t-e88c8a — the alternative it named USED TO BE `delivery_join`, and that tool was retired with the
 * Delivery machinery. A refusal pointing at a door that does not exist is worse than one that only
 * forbids: the caller burns a turn discovering the tool is not there, and then invents the same
 * workaround this message exists to prevent. Both remaining exits are real and reachable today.
 *
 * Its own guard is why the dead pointer survived three removal stages: the test asserted the string
 * CONTAINS "delivery_join", so deleting the tool left the assertion passing. A guard that pins a
 * name must pin it against the live registration, not against itself.
 *
 * t-5f823a — and the exit it named instead was reachable only by a HUMAN caller. `resolveActor`
 * gives an agent caller its own name for an omitted `parent` (spec 351: a delegating agent may not
 * spawn an orphan), so "spawn without parent" is not a door an agent can walk through — it is the
 * one thing the identity model exists to forbid it. Naming a live tool is not enough; the exit has
 * to be executable BY THE CALLER READING IT. Hence the exits are enumerated per caller kind below
 * and pinned against `resolveActor` itself, not against this text.
 *
 * t-d06da3 — the exits were both HEAVY, and the light one did not exist yet. Until this task the only
 * way to give a delegated child a directory of its own was to write it into tachyon.yml first, once
 * per delegation, because `spawn_agent worktree:true` was refused outright for a Temporary AI child.
 * That refusal is gone, so the direct exit joins the list. It is offered to every caller kind for the
 * same reason the unparented one is not: this rule fires only on a Temporary AI spawn (a resolved
 * `parent` implies `cmd`), and that is exactly the door `worktree:true` now opens. The pin follows the
 * mechanism, as before — reachability here is decided by the `spawn_agent` handler itself, so the test
 * drives it per caller kind rather than reading this prose back to itself.
 */

/** The rule, invariant across callers — the sentence every rendering of this refusal shares. */
export const PARENT_CWD_RULE =
  "spawn_agent cannot combine parent with cwd: a parented child inherits its parent's working directory.";

/**
 * The ways out of the parent+cwd rule. Enumerated rather than written inline so a test can pin the
 * OFFER against the mechanism that decides reachability, instead of pinning prose against prose.
 */
export type SpawnCwdExit =
  /** spawn the child with no lineage at all and name its directory — only a caller that CAN be unparented. */
  | "unparented-spawn"
  /** t-d06da3 — ask for isolation instead of naming a path: the child is born in its own checkout. */
  | "isolate-in-own-worktree"
  /** put the child on the roster with a worktree of its own. */
  | "declare-in-config"
  /** accept the inheritance: drop cwd, and the child runs where its parent runs. */
  | "inherit-parent-cwd";

const EXIT_PROSE: Record<SpawnCwdExit, string> = {
  "unparented-spawn": "To run somewhere else, spawn without parent and pass cwd.",
  "isolate-in-own-worktree":
    "To give the child a directory of its own, drop cwd and pass worktree:true — it is born in its own "
    + "git worktree on its own branch, and dismissing it takes that checkout with it.",
  "declare-in-config": "For a checkout that outlives the child, declare it in tachyon.yml with a worktree.",
  "inherit-parent-cwd": "Omit cwd and the child runs where you run.",
};

/**
 * Why an agent gets a different list: for every other caller kind an omitted `parent` resolves to
 * nothing, so "spawn without parent" is a real instruction. For an agent it resolves to the caller,
 * which is not an oversight to route around — it is spec 351. Telling an agent to do it anyway is
 * how the incident behind t-e787dc repeats: a refusal that points nowhere gets answered with an
 * absolute path written into the child's BRIEFING, outside every guardrail this rule protects.
 */
const AGENT_LINEAGE_NOTE =
  "You are an agent: an omitted parent resolves to your own identity (spec 351 — a delegating agent "
  + "cannot spawn a child with no lineage), so every spawn you make is parented and the exit a human "
  + "caller has here is not one you can take.";

/** The exits that exist for a given caller kind. `undefined` is the unauthenticated/legacy Bridge. */
export function parentCwdExitsFor(callerKind: SpawnActorKind | undefined): SpawnCwdExit[] {
  return callerKind === "agent"
    ? ["inherit-parent-cwd", "isolate-in-own-worktree", "declare-in-config"]
    : ["unparented-spawn", "isolate-in-own-worktree", "declare-in-config"];
}

/** The refusal as the given caller should hear it — the rule, then only the exits that caller has. */
export function parentCwdRefusalFor(callerKind: SpawnActorKind | undefined): string {
  const exits = parentCwdExitsFor(callerKind).map((exit) => EXIT_PROSE[exit]);
  const preamble = callerKind === "agent" ? [PARENT_CWD_RULE, AGENT_LINEAGE_NOTE] : [PARENT_CWD_RULE];
  return [...preamble, ...exits].join(" ");
}

/**
 * The caller-neutral rendering. The AgentManager throws THIS one: it is reached by launches that
 * carry no caller identity at all (config-driven, internal), and it is deliberately the same
 * sentence-plus-exits a non-agent Bridge caller hears, so one rule never gets two stories.
 */
export const PARENT_CWD_REFUSAL = parentCwdRefusalFor(undefined);
