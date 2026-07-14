/**
 * spec 216 — role/instruction templates.
 *
 * A `role` is a REUSABLE TASK CONTRACT, not a persona. Each template states what the
 * agent should DO for a delegated job (scope, boundaries, how to verify, what to report) —
 * never an identity claim ("you are a 10x engineer"). This is context-engineering: it scopes
 * the task, it does not role-play a character. Templates are English (repo-artifact rule).
 *
 * Composition is at DELIVERY (loadConfig.composeCommand consumes the result): the role
 * template is the base, an explicit `instructions:` is appended after it (the human's words
 * extend the contract, never silently replace it). `custom` carries no preset contract — the
 * user supplies the whole thing via `instructions`.
 */

export const ROLES = ["coder", "reviewer", "tester", "orchestrator", "custom"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

const CODER = [
  "Your task: implement the assigned change as the smallest correct code edit.",
  "- Read the relevant files and existing patterns before editing.",
  "- Prefer small steps; avoid unrelated refactors and scope creep.",
  "- After changing code, run a check that covers the risk; if you cannot verify, say why.",
  "- Report: files changed, verification result, remaining risk or blockers.",
].join("\n");

const REVIEWER = [
  "Your task: review for quality. Do not take over planning, and do not edit code by default.",
  "- Look first for real bugs, regression risk, edge cases, and test gaps.",
  "- For each finding give: severity, file/line, the trigger, and a minimal suggested fix.",
  "- If there is no high-risk issue, say so and state the remaining risk and unverified scope.",
  "- Order findings by severity, blocking issues first.",
].join("\n");

const TESTER = [
  "Your task: reproduce, test, and produce evidence.",
  "- First state the behavior under test, its entry point, and the failure condition.",
  "- Prefer running the real command or real path; add a minimal test only when needed.",
  "- Record the commands, results, key output, and any scenario you could not cover.",
  "- Report distinguishes: passed, failed, unverified, and suggested next step.",
].join("\n");

const ORCHESTRATOR = [
  "Your task: coordinate the work. Respond to the user and drive the other agents.",
  "- Clarify the goal and break it into small dispatchable tasks.",
  "- Keep the shared checklist (pins) and the project handoff current so plan, progress, and blockers are trackable.",
  "- Dispatch through Tachyon's Bridge tools (spawn_agent, write_input, wait_for_agent) so the",
  "  work is visible in the team; collect results and advance the next step.",
  "- Don't bounce a decision back to the user when you can reasonably make it.",
].join("\n");

/** Studio-only placeholder for `custom` — never delivered to an agent. */
const CUSTOM_PLACEHOLDER = [
  "Describe this agent's task contract:",
  "- Goal: what this agent is responsible for.",
  "- Boundaries: what it may and may not do.",
  "- How to work: how it investigates, changes, verifies, or reviews.",
  "- Done: which results, risks, and blockers it must report on delivery.",
].join("\n");

const TEMPLATES: Record<Exclude<Role, "custom">, string> = {
  coder: CODER,
  reviewer: REVIEWER,
  tester: TESTER,
  orchestrator: ORCHESTRATOR,
};

/** The contract text for a role. `custom` returns a Studio placeholder (not for delivery). */
export function roleTemplate(role: Role): string {
  return role === "custom" ? CUSTOM_PLACEHOLDER : TEMPLATES[role];
}

/**
 * The instructions actually delivered: role template (if a preset) then the explicit
 * instructions. `custom`/no role → just the instructions (today's behavior). Returns
 * undefined when there is nothing to deliver.
 */
export function composeInstructions(
  role: Role | undefined,
  instructions: string | undefined,
): string | undefined {
  const extra = instructions?.trim() ? instructions.trim() : undefined;
  if (!role || role === "custom") return extra;
  const base = roleTemplate(role);
  return extra ? `${base}\n\n${extra}` : base;
}

/**
 * Short coordination note appended to a Bridge-spawned child's instructions (Part B).
 * Guidance only — Tachyon cannot intercept a CLI's native sub-agent tools; this just
 * nudges the child to keep delegated work visible by going through the Bridge.
 */
export function bridgeGuidanceTail(): string {
  return [
    "[Tachyon] You are part of a Tachyon team. Coordinate through the Bridge tools",
    "(create_pin/list_pins, append_project_handoff_note, write_input, spawn_agent, wait_for_agent). If you delegate, spawn",
    "through the Bridge — your CLI's built-in sub-agents (Task/Explore/…) run work Tachyon",
    "cannot see (no tab, no lineage, no attention). A bug you find is a task (create_task, kind 'bug'),",
    "not a pin. If you have a declared verify gate, run it",
    "and confirm it passes before you report done — going idle is not proof your work is green.",
  ].join(" ");
}

/** Apply the Bridge guidance to a (possibly empty) instruction body, when enabled. */
export function withBridgeGuidance(
  instructions: string | undefined,
  enabled: boolean,
): string | undefined {
  if (!enabled) return instructions;
  const tail = bridgeGuidanceTail();
  const body = instructions?.trim();
  return body ? `${body}\n\n${tail}` : tail;
}

/**
 * Compact one-line reminder re-injected after a compaction (Part C). Re-anchors the role and
 * points at the durable per-agent role doc rather than re-typing the whole contract.
 */
export function roleReminder(role: Role | undefined, docPath: string): string {
  const who = role && role !== "custom" ? `the ${role}` : "your assigned";
  return `[Tachyon] Re-anchor: you are ${who} agent for this task. Re-read your full task contract with: cat ${docPath}`;
}

/**
 * Durable per-agent role doc (written under `.tachyon/roles/<agent>.md`) — the `cat`-recover
 * fallback the reminder points at, and the always-on path when auto re-anchor is off.
 */
export function buildRoleDoc(agent: string, role: Role | undefined, instructions: string | undefined): string {
  const contract = composeInstructions(role, instructions);
  return [
    `# Tachyon role — ${agent}`,
    "",
    "Auto-generated by Tachyon. If you lost context after a compaction, this is your task contract.",
    "",
    role && role !== "custom" ? `Role: ${role}` : "Role: custom / freeform",
    "",
    contract ?? "(no task contract was set for this agent)",
    "",
  ].join("\n");
}
