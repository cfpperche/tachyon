/**
 * t-e722ce — the plan a human reads BEFORE approving a Saved Agent forget.
 *
 * ## Why this exists
 *
 * Removing an agent was a chain of hidden preconditions, each discovered by trial and error and each
 * reported as the same flattened sentence. Measured on 0.56.142: three rounds of guessing for an
 * operation the product could compute on the first click. The transaction always knew what it was
 * about to touch — `commitAgentProfileForget` journals its manifest, its config target and its live
 * snapshot before it moves a byte — so the missing piece was never knowledge. It was that nobody
 * showed it.
 *
 * This module is that projection, and ONLY that: read-only, side-effect-free, and deliberately not a
 * second implementation of the gates. Every step below mirrors one gate of the real cascade, in the
 * order the cascade runs it, and each carries the same `AgentProfileRefusal` code the gate would
 * throw. When a gate moves, this list is wrong in a way a test can see — which is the point of
 * projecting the transaction rather than describing it.
 *
 * ## The authority, and why it is the ledger
 *
 * Three sources answer "does this agent own a worktree?" and they can disagree:
 *
 *   - `.tachyon/sessions.json` (the LEDGER) — what `deleteConfiguredAgent`, `removeAgentWorktree`
 *     and `prepareAgentProfileForget` each read, at three separate gates.
 *   - `.tachyon/managed-worktrees.json` (the REGISTRY) — a derived index for hygiene and Control.
 *   - the checkout on disk — what git can still see.
 *
 * The plan reads the LEDGER, because the plan's only job is to say what the transaction will do, and
 * the ledger is what the transaction asks. A plan that consulted the registry could report "no
 * worktree" while the forget refuses `forget-worktree-owned` — which is precisely the dead end this
 * task exists to remove, rebuilt one layer higher.
 *
 * The other two sources are not ignored; they are reported as `dissent`. A disagreement is a FACT
 * about the workspace the human should see, and it is never a gate. The registry is reconciled by
 * the cascade itself (`removeAgentWorktree` writes both), and a checkout that is already gone is a
 * proved-absent state (`checkoutAlreadyAbsent`, 078ab8e3) that changes what the step will DO without
 * changing whether it runs.
 */
import { z } from "zod";
import { AGENT_PROFILE_REFUSAL_CODE_RE, type AgentProfileRefusalCode } from "./agentProfileRefusal.js";

/**
 * The cascade's steps, in execution order.
 *
 * `stop-session` and `remove-worktree` are `config.agent.delete`'s prologue; the four after them are
 * `commitAgentProfileForget`'s journal phases (`authority-retired` → `locator-removed` →
 * `home-quarantined` → `runtime-converged`). The names are the human's, the
 * order is the machine's, and they must not be reordered for readability — a plan that lists the
 * steps in a prettier order than they run is a plan that mispredicts which one blocks first.
 */
export const AGENT_FORGET_PLAN_STEP_IDS = [
  "stop-session",
  "remove-worktree",
  "retire-authority",
  "remove-locator",
  "quarantine-profile",
  "converge-runtime",
] as const;

export type AgentForgetPlanStepId = (typeof AGENT_FORGET_PLAN_STEP_IDS)[number];

/**
 * Three states, and the distinction between the first two is the whole reason the plan is readable.
 *
 * `satisfied` is not "skipped": it is a precondition the workspace already meets, and saying so is
 * what stops a human from going off to satisfy it again — the exact loop that sent one through
 * Control → Worktrees and back.
 */
export const AGENT_FORGET_PLAN_STEP_STATES = ["satisfied", "will-run", "blocked"] as const;

const stepSchema = z.object({
  id: z.enum(AGENT_FORGET_PLAN_STEP_IDS),
  state: z.enum(AGENT_FORGET_PLAN_STEP_STATES),
  /** What this step will touch, or why it is already satisfied. Never a stack or a host path. */
  detail: z.string().min(1).max(512),
  /** The engine code the real gate would refuse with. Present only when `state` is `blocked`. */
  refusalCode: z.string().regex(AGENT_PROFILE_REFUSAL_CODE_RE).optional(),
  /** The gesture that unblocks it. A blocked step without one is the generic error, again. */
  resolution: z.string().min(1).max(512).optional(),
}).strict();

export type AgentForgetPlanStepV1 = z.infer<typeof stepSchema>;

export const agentForgetPlanSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  agentName: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/),
  /** The revision the plan was computed against; the approval carries it back. */
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  /** Named on the wire so the panel can say WHICH source decided, not just what it decided. */
  authority: z.literal("session-ledger"),
  steps: z.array(stepSchema).min(1).max(16),
  /** Sources that disagree with the authority. Reported, never acted on. */
  dissent: z.array(z.object({
    source: z.enum(["managed-worktree-registry", "checkout"]),
    claim: z.string().min(1).max(256),
  }).strict()).max(8),
  /** What survives the cascade untouched. */
  retained: z.array(z.string().min(1).max(64)).max(32),
  /** What is moved into the durable retirement receipt rather than deleted. */
  retiredToReceipt: z.array(z.string().min(1).max(64)).max(32),
  risk: z.object({
    branch: z.string().max(1024).optional(),
    uncommittedChanges: z.number().int().nonnegative(),
    commitsAheadOfBase: z.number().int().nonnegative(),
    unpushedCommits: z.number().int().nonnegative(),
    /**
     * spec 444 — the `baseRef..HEAD` probe itself failed, so `commitsAheadOfBase: 0` means UNKNOWN
     * and must never be read as "contained in base". Surfaced rather than smoothed over: a plan that
     * shows a confident zero it could not measure is worse than one that admits the gap.
     */
    aheadProbeFailed: z.boolean(),
    /** The branch is deleted with the checkout only when Tachyon created it and git can safe-delete it. */
    branchDeletionPlanned: z.boolean(),
    liveDescendants: z.array(z.string().min(1).max(128)).max(64),
  }).strict(),
  /** False when any step is blocked; the approval control is disabled on it. */
  executable: z.boolean(),
}).strict();

export type AgentForgetPlanV1 = z.infer<typeof agentForgetPlanSchemaV1>;

/**
 * Computing the plan can itself be refused — the profile may have moved between the panel's last
 * snapshot and the click. That refusal travels as a VALUE for the same reason
 * `agentProfileStudioLifecycleResultSchemaV1` does: an exception crossing the engine↔shell wire
 * arrives as `{ code: "COMMAND_FAILED" }` with its class gone, and the panel would be back to
 * guessing from prose. `code` is validated by SHAPE so a shell one release behind still renders a
 * refusal it has never heard of.
 */
export const agentForgetPlanResultSchemaV1 = z.union([
  z.object({ schemaVersion: z.literal(1), kind: z.literal("plan"), plan: agentForgetPlanSchemaV1 }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    kind: z.literal("refused"),
    code: z.string().regex(AGENT_PROFILE_REFUSAL_CODE_RE),
    message: z.string().min(1).max(1_000),
  }).strict(),
]);

export type AgentForgetPlanResultV1 = z.infer<typeof agentForgetPlanResultSchemaV1>;

/**
 * t-33ae3f — what `commitAgentProfileForget` deliberately leaves on disk, declared ONCE.
 *
 * It lives here rather than beside the transaction because the plan renders it to a human and this
 * module is bundled for the webview, while the transaction module opens files and cannot be. The
 * transaction re-exports it, so every existing reader is unchanged and there is still exactly one
 * list: whatever is added to the retention set belongs here, and whatever the transaction removes
 * must NOT.
 */
export const AGENT_PROFILE_FORGET_RETAINED_BINDINGS = [
  "runtime homes",
  "worktrees",
  "session-owner rows",
  "continuity",
] as const;

/**
 * What the cascade removes out of the bare forget's retention set.
 *
 * `AGENT_PROFILE_FORGET_RETAINED_BINDINGS` describes `commitAgentProfileForget` ALONE, which never
 * removes a worktree — it refuses when one is owned. The cascade removes the checkout first, so
 * repeating that list verbatim here would tell the human their worktree survives while the very
 * plan they are reading says it will be deleted. Expressed as a delta against the one declared list
 * (t-33ae3f's rule: one list, so the declaration cannot drift from the behaviour) rather than as a
 * second hand-written set that would silently diverge the next time either side changes.
 */
export const AGENT_FORGET_CASCADE_REMOVED_BINDINGS = ["worktrees"] as const;

export const AGENT_FORGET_PLAN_RETAINED_BINDINGS: readonly string[] =
  AGENT_PROFILE_FORGET_RETAINED_BINDINGS
    .filter((binding) => !(AGENT_FORGET_CASCADE_REMOVED_BINDINGS as readonly string[]).includes(binding));

/**
 * Not deleted and not retained in place: quarantined under
 * `.tachyon/retired-agent-profiles/<agentId>/<txid>/`, where an audit can still read them.
 * `convergeAgentProfileForget` moves the activity projections there and `quarantineHome` moves the
 * canonical profile tree; both are recoverable, and a human deciding whether to press the button
 * needs to know that before they press it, not after.
 */
export const AGENT_FORGET_PLAN_RETIRED_TO_RECEIPT: readonly string[] = [
  "canonical profile tree",
  "activity projections",
];

export interface AgentForgetPlanWorktreeFacts {
  branch: string;
  path: string;
  tachyonCreatedBranch: boolean;
  /** Absent when the status probe could not run (the checkout is gone, for instance). */
  status: {
    staged: number;
    unstaged: number;
    untracked: number;
    conflicts: number;
    aheadOfBase: number;
    unpushed: number;
    aheadProbeFailed?: boolean;
  } | null;
}

/**
 * Everything the projection is allowed to know. Gathered by `Workspace.planAgentProfileForget`,
 * which is the only place permitted to touch tmux, git and disk for it; keeping the projection pure
 * is what lets every branch below be exercised without an engine.
 */
export interface AgentForgetPlanFactsV1 {
  agentName: string;
  revision: string;
  /** Mirrors `AgentOccupancyVerdict`: a `free` verdict carries no detail because there is none. */
  occupancy: { state: "occupied"; detail: string } | { state: "free" } | { state: "unknown"; detail: string };
  liveDescendants: readonly string[];
  /** THE AUTHORITY. Null means the ledger says this agent owns no checkout. */
  ledgerWorktree: AgentForgetPlanWorktreeFacts | null;
  /** Proved by repository + disk, not by the shape of a git error. Null when unowned or unprobed. */
  checkoutPresent: boolean | null;
  /** The derived index. Compared against the authority, never substituted for it. */
  registryWorktreeBranch: string | null;
  authorityPresent: boolean;
  locatorPresent: boolean;
  profileHomePresent: boolean;
}

function step(
  id: AgentForgetPlanStepId,
  state: (typeof AGENT_FORGET_PLAN_STEP_STATES)[number],
  detail: string,
  blocked?: { code: AgentProfileRefusalCode; resolution: string },
): AgentForgetPlanStepV1 {
  return {
    id,
    state,
    detail,
    ...(blocked ? { refusalCode: blocked.code, resolution: blocked.resolution } : {}),
  };
}

function stopSessionStep(facts: AgentForgetPlanFactsV1): AgentForgetPlanStepV1 {
  if (facts.occupancy.state === "unknown") {
    // t-4736b4 — unmeasurable occupancy is neither alive nor gone, and the cascade refuses rather
    // than guess. The plan says the same thing at the same strength: this is the one blocked step a
    // retry can clear on its own, so its resolution is a retry and not a gesture.
    return step("stop-session", "blocked", `occupancy could not be measured — ${facts.occupancy.detail}`, {
      code: "agent-profile/occupancy-unverifiable",
      resolution: "Check the tmux server, then compute the plan again. Nothing was read as free.",
    });
  }
  if (facts.occupancy.state === "occupied") {
    return step("stop-session", "will-run", `the session is live (${facts.occupancy.detail}) and will be killed`);
  }
  return step("stop-session", "satisfied", "no live session, pane or reservation holds this agent");
}

function removeWorktreeStep(facts: AgentForgetPlanFactsV1): AgentForgetPlanStepV1 {
  const owned = facts.ledgerWorktree;
  if (!owned) return step("remove-worktree", "satisfied", "the session ledger records no checkout for this agent");
  if (facts.liveDescendants.length > 0) {
    return step("remove-worktree", "blocked", `${facts.liveDescendants.join(", ")} still run inside this checkout`, {
      // Not one of forget's own codes: this gate lives in `removeAgentWorktree`, ahead of the
      // canonical transaction, and it is the same class of fact — a session holds the checkout.
      code: "agent-profile/worktree-release-agent-running",
      resolution: `Stop ${facts.liveDescendants.join(", ")} first — they share this worktree.`,
    });
  }
  if (facts.checkoutPresent === false) {
    return step(
      "remove-worktree",
      "will-run",
      `the checkout at ${owned.path} is already gone; only the ownership of ${owned.branch} will be released`,
    );
  }
  const branchNote = owned.tachyonCreatedBranch
    ? `; branch ${owned.branch} was created by Tachyon and is deleted if git can safe-delete it`
    : `; branch ${owned.branch} pre-existed and is kept`;
  return step("remove-worktree", "will-run", `deletes the checkout at ${owned.path}${branchNote}`);
}

function retireAuthorityStep(facts: AgentForgetPlanFactsV1): AgentForgetPlanStepV1 {
  if (!facts.authorityPresent) {
    return step("retire-authority", "blocked", "the host-custodied authority for this profile is missing or no longer matches it", {
      code: "agent-profile/forget-authority-stale",
      resolution: "Reload the profile in Agent Studio; if it still does not match, the authority record must be repaired first.",
    });
  }
  return step("retire-authority", "will-run", "retires this agent's record in the host authority vault");
}

function removeLocatorStep(facts: AgentForgetPlanFactsV1): AgentForgetPlanStepV1 {
  return facts.locatorPresent
    ? step("remove-locator", "will-run", `removes the '${facts.agentName}' entry from tachyon.yml`)
    : step("remove-locator", "satisfied", "tachyon.yml no longer declares this agent");
}

function quarantineProfileStep(facts: AgentForgetPlanFactsV1): AgentForgetPlanStepV1 {
  return facts.profileHomePresent
    ? step("quarantine-profile", "will-run", `moves .tachyon/agents/${facts.agentName}/ into the retirement receipt`)
    : step("quarantine-profile", "satisfied", "the canonical profile directory is already retired");
}

function convergeRuntimeStep(): AgentForgetPlanStepV1 {
  return step(
    "converge-runtime",
    "will-run",
    "drops the session ledger row, the generated spawn brief, and the pane transcript",
  );
}

function dissentOf(facts: AgentForgetPlanFactsV1): AgentForgetPlanV1["dissent"] {
  const dissent: { source: "managed-worktree-registry" | "checkout"; claim: string }[] = [];
  const owned = facts.ledgerWorktree;
  if (facts.registryWorktreeBranch !== null && owned === null) {
    dissent.push({
      source: "managed-worktree-registry",
      claim: `the worktree registry still lists ${facts.registryWorktreeBranch}; the ledger does not, so no checkout step will run`,
    });
  } else if (facts.registryWorktreeBranch === null && owned !== null) {
    dissent.push({
      source: "managed-worktree-registry",
      claim: `the worktree registry lists nothing; the ledger owns ${owned.branch}, and the ledger decides`,
    });
  } else if (owned !== null && facts.registryWorktreeBranch !== null && facts.registryWorktreeBranch !== owned.branch) {
    dissent.push({
      source: "managed-worktree-registry",
      claim: `the worktree registry lists ${facts.registryWorktreeBranch}; the ledger owns ${owned.branch}`,
    });
  }
  if (owned !== null && facts.checkoutPresent === false) {
    dissent.push({ source: "checkout", claim: `nothing exists at ${owned.path}; the ownership record outlived the directory` });
  }
  return dissent;
}

/**
 * Project the cascade onto a plan. Pure: same facts in, same plan out, nothing touched.
 *
 * A step never guesses forward. `remove-worktree` reports what it will do given the checkout that
 * exists NOW, and `stop-session` reports occupancy as measured, because a plan that predicted the
 * state after its own earlier steps would be describing a workspace nobody has seen.
 */
export function projectAgentForgetPlan(facts: AgentForgetPlanFactsV1): AgentForgetPlanV1 {
  const steps: AgentForgetPlanStepV1[] = [
    stopSessionStep(facts),
    removeWorktreeStep(facts),
    retireAuthorityStep(facts),
    removeLocatorStep(facts),
    quarantineProfileStep(facts),
    convergeRuntimeStep(),
  ];
  const owned = facts.ledgerWorktree;
  const status = owned?.status ?? null;
  return agentForgetPlanSchemaV1.parse({
    schemaVersion: 1,
    agentName: facts.agentName,
    revision: facts.revision,
    authority: "session-ledger",
    steps,
    dissent: dissentOf(facts),
    retained: [...AGENT_FORGET_PLAN_RETAINED_BINDINGS],
    retiredToReceipt: [...AGENT_FORGET_PLAN_RETIRED_TO_RECEIPT],
    risk: {
      ...(owned ? { branch: owned.branch } : {}),
      uncommittedChanges: status ? status.staged + status.unstaged + status.untracked + status.conflicts : 0,
      commitsAheadOfBase: status?.aheadOfBase ?? 0,
      unpushedCommits: status?.unpushed ?? 0,
      aheadProbeFailed: status?.aheadProbeFailed === true,
      branchDeletionPlanned: owned?.tachyonCreatedBranch === true && facts.checkoutPresent !== false,
      liveDescendants: [...facts.liveDescendants],
    },
    executable: steps.every((entry) => entry.state !== "blocked"),
  });
}
