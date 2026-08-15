import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cancelSavedAgentProposal, listSavedAgentProposalDecisions, readLiveSavedAgentProposalQueue, recordSavedAgentProposal } from "@tachyon/engine/agents/savedAgentProposalStore.js";
import { cancelSavedAgentRemovalProposal, listSavedAgentRemovalProposalDecisions, readLiveSavedAgentRemovalProposalQueue, recordSavedAgentRemovalProposal } from "@tachyon/engine/agents/savedAgentRemovalProposalStore.js";
import { readAgentProfileGrants, workspaceConfigSha256 } from "@tachyon/engine/config/agentProfileGrants.js";
import type { AgentOwnershipRosterV1 } from "@tachyon/shared/config/agentProfileStudio.js";
import { parentCwdRefusalFor } from "@tachyon/engine/agents/spawnContract.js";
import type { Task } from "@tachyon/shared/tasks/types.js";
import { NO_QUOTA_CHANNEL } from "@tachyon/engine/runtimeOps/runtimeCondition.js";
import { validateSpawnContract, composeSpawnContractBrief, notifyParentGuidance, noInteractivePromptGuidance, identityLine, idleSpawnGuidance, normalizeField } from "@tachyon/engine/agents/spawnContract.js";
import type { SpawnContract } from "@tachyon/engine/agents/spawnContract.js";
import { decideSpawnTaskClaim } from "../spawnTaskClaim.js";
import type { SpawnTaskClaimDecision } from "../spawnTaskClaim.js";
import { collectAgentTouchedFiles } from "@tachyon/engine/worktree/agentTouchedFiles.js";
import { admitAgentRuntimeCommand, SUPPORTED_AGENT_RUNTIME_NAMES } from "@tachyon/shared/agents/agentRuntimeAdmission.js";
import { type BridgeDeps, AGENT_NAME, TASK_ID, dismissOwnedWorktree, dismissReceipt, emitTaskNotification, fail, lifecycleScopeGuard, managedEntry, ok, outputCapabilities, releaseSpawnClaim, resolveDeclaredActor, taskNotificationActor } from "./shared.js";

export function registerFleetTools(mcp: McpServer, deps: BridgeDeps): void {

  mcp.registerTool(
    "retask_agent",
    {
      description:
        "Give one triaged board Task to an already-live Temporary agent without restarting it or touching its checkout. " +
        "Claims the task, then pushes a freshly projected WORK ON RECORD into the existing conversation through the " +
        "queue-safe notice path. Refuses while the agent owns different active work: finish or release that assignment first.",
      inputSchema: {
        name: AGENT_NAME.describe("live Temporary agent to retask"),
        task_id: TASK_ID.describe("triaged or active-unassigned board task to claim"),
      },
    },
    async ({ name, task_id }) => {
      try {
        const denied = lifecycleScopeGuard(deps, "restart_agent", name);
        if (denied) return fail(new Error(denied.replaceAll("restart_agent", "retask_agent")));
        if (!deps.deliverNotice) throw new Error("retask_agent is unavailable: queue-safe agent delivery is not configured");

        // Validate the live Temporary and its prompt channel before the board write. The returned
        // projection is intentionally discarded: the authoritative one is rendered after the claim.
        await deps.manager.liveRetaskWorkRecord(name);
        const competing = deps.tasks.listRaw().filter(
          (task) => task.status === "active" && task.assignee === name && task.id !== task_id,
        );
        if (competing.length > 0) {
          throw new Error(
            `retask_agent refused: '${name}' still owns active ${competing.map((task) => task.id).join(", ")}; ` +
            "finish or release that assignment before choosing different work",
          );
        }

        const prior = deps.tasks.get(task_id);
        const decision = decideSpawnTaskClaim(prior, name);
        if (decision.kind === "refuse") {
          throw new Error(decision.reason.replaceAll("spawn_agent", "retask_agent").replaceAll("Spawning", "Retasking"));
        }
        let claimed: Task | undefined;
        try {
          if (decision.kind === "claim") {
            claimed = await deps.tasks.update(task_id, {
              status: "active",
              assignee: name,
              expect: { updatedAt: prior.updatedAt },
              ...(deps.caller?.kind === "agent" && deps.caller.name ? { actor: deps.caller.name } : {}),
            });
            deps.onTasksChanged?.({ reason: "task-mutated", id: claimed.id });
          }
          const record = await deps.manager.liveRetaskWorkRecord(name);
          const receipt = await deps.deliverNotice(name, record);
          return ok(JSON.stringify({ agent: name, task: task_id, delivery: receipt.status }, null, 2));
        } catch (error) {
          if (claimed) await releaseSpawnClaim(deps, claimed, prior);
          throw error;
        }
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "spawn_agent",
    {
      description:
        "Compatibility name: start a managed entry in this workspace. With only a name, spawns the entry declared in tachyon.yml; " +
        "pass cmd to spawn a Temporary sub-agent (e.g. a fresh AI CLI for a delegated task). " +
        `cmd MUST name a supported LLM runtime (${SUPPORTED_AGENT_RUNTIME_NAMES.join(", ")}) — a generic process ` +
        "(shell, server, build) is refused here and belongs to spawn_terminal, which starts it with no task, lineage, brief or worktree. " +
        "For a Temporary delegated agent, pass parent=<your own agent name — find it in your $TACHYON_AGENT_NAME env var, never guess it>; " +
        "when starting a declared Saved Agent, omit parent because ownership comes only from the saved roster. " +
        "DELEGATION CONTRACT (spec 246): when you spawn a Temporary AI agent (cmd is an AI CLI), you MUST hand it a " +
        "structured brief — task + context + constraints + (deliverable OR done_when) — or the call is rejected. " +
        "The contract is delivered to the child as its opening brief, so fill it with real substance. " +
        "Pass skip_contract_reason=<why, ≥10 chars> ONLY for a genuinely trivial spawn (recorded, surfaced to the human). " +
        "BOARD CLAIM: pass claim_task=<t-xxxxxx> or claim_task=[<t-xxxxxx>, ...] to launch the agent FOR triaged board tasks. " +
        "Every task moves to active with this agent as assignee before launch, so the brief you write and the work the agent " +
        "reads off the board are one fact instead of two that can disagree. A task this agent cannot hold (still in " +
        "inbox, closed, or assigned to someone else) is refused HERE, naming the reason, instead of launching an " +
        "agent that discovers it a turn later. Triage stays a SEPARATE, DELIBERATE decision — not a human-only one: " +
        "an inbox task is never claimed by spawning at it, and whoever triages leaves author and reason in the " +
        "task journal (t-f33480). The old wording said \"human decision\" and nothing enforced it; a boundary that " +
        "is neither imposed nor audited is a sentence, so the enforcement became the TRACE rather than the caller. " +
        "With parent set, the child's brief already teaches it to call notify_agent(to: \"<your name>\", summary: ...) when the " +
        "deliverable/done_when is met — no need to tell it separately. That lands on your pane the next time you go idle " +
        "(spec 341); a coordinator that stays busy past that (spec 493, t-167b5c) should also poll " +
        "read_notices(agent: \"<your name>\") rather than assume the pane wake-up alone caught it. " +
        "Subject to the maxAgents guardrail.",
      inputSchema: {
        name: AGENT_NAME.describe("managed entry name (becomes part of the tmux session name)"),
        cmd: z
          .string()
          .min(1)
          .optional()
          .describe(`command for a Temporary instance — must name a supported LLM runtime (${SUPPORTED_AGENT_RUNTIME_NAMES.join(", ")}); omit to use tachyon.yml`),
        cwd: z.string().optional().describe("working directory for a Temporary instance"),
        instructions: z
          .string()
          .max(2000)
          .optional()
          .describe("extra free-form prose appended AFTER the delegation contract in the child's brief (optional)"),
        parent: AGENT_NAME.optional().describe(
          "Temporary agents only: YOUR agent name, recording runtime lineage. Omit for a declared Saved Agent; its ownership comes from the roster.",
        ),
        worktree: z
          .boolean()
          .optional()
          .describe(
            // t-6fe04b — it said "ignored for a sub-agent", and the Bridge REFUSED it outright for a
            // Temporary AI agent. "Ignored" and "refused" are different promises to a caller, and only
            // one of them was true.
            //
            // t-d06da3 — and then the refusal itself went. Neither word describes this parameter now:
            // a delegated child may ask for isolation, and `resolveWorktreeCwd` has always honored it
            // (`ctx.parent && !ctx.worktree` is the inheritance branch — `worktree:true` opts out of it).
            // The old text also offered "spawn top-level", which an agent caller cannot do at all: an
            // omitted `parent` resolves to the caller itself (spec 351), so every spawn it makes is
            // parented. This says what the parameter DOES, to the caller who reads it most.
            "give this agent its own git worktree + branch, instead of inheriting a directory. "
            + "For a delegated child this is the governed alternative to cwd (which is refused for a parented "
            + "child): it opts out of running where its parent runs and is born in its own checkout. "
            + "Dismissing the child removes that checkout with it; a branch holding unmerged commits is kept.",
          ),
        // spec 246 — the delegation contract (required for a Temporary AI agent unless skip_contract_reason is given).
        task: z.string().optional().describe("what the child must do — one substantive directive"),
        context: z.string().optional().describe("the situation/files/background the child needs to start"),
        constraints: z.string().optional().describe("what NOT to do; scope guardrails; budgets; style"),
        deliverable: z.string().optional().describe("the concrete artifact expected (use this OR done_when)"),
        done_when: z.string().optional().describe("the verifiable done condition (use this OR deliverable)"),
        skip_contract_reason: z
          .string()
          .optional()
          .describe("bypass the contract gate for a trivial spawn — ≥10 chars explaining why; recorded + surfaced to the human"),
        // t-48f504 — the board claim. Deliberately a task ID and not another prose slot: `task` above is
        // the directive and can say anything, which is exactly why it could never bind a spawn to the board.
        claim_task: z.union([TASK_ID, z.array(TASK_ID).min(1)]).optional().describe(
          "board task or tasks this agent is launched FOR. A string preserves the singular format. An array claims "
          + "every task before launch. Each task must be triaged or already active under this agent. Any invalid "
          + "item refuses the entire spawn by task id and reason, so the contract and work-on-record stay complete.",
        ),
      },
    },
    async ({ name, cmd, cwd, instructions, parent, worktree, task, context, constraints, deliverable, done_when, skip_contract_reason, claim_task }) => {
      try {
        const isTemporaryAiAgent = !!cmd;
        // t-c861e5 — starting a declared Saved Agent is an activation, not a delegation. The
        // authenticated caller may request the activation, but must not become runtime lineage or
        // ownership merely by making that request. Saved ownership is read exclusively from the
        // roster (`declaredOwner`). Temporary agents still resolve and authenticate their parent.
        if (!isTemporaryAiAgent && parent !== undefined) {
          return fail(new Error(
            "spawn_agent parent is only valid for a Temporary delegated agent; omit parent when starting a declared Saved Agent because ownership comes from the roster",
          ));
        }
        // spec 351 — Temporary delegation resolves omitted parent to the caller itself; a lineage
        // lie is a structured mismatch. Saved activation deliberately preserves parent=undefined.
        if (isTemporaryAiAgent) {
          const parentActor = resolveDeclaredActor(deps, parent);
          if (!parentActor.ok) return fail(new Error(parentActor.message));
          parent = parentActor.name;
        }
        // t-6fe04b — refuse the incompatible pair at the ENTRY: before a delegation contract is
        // composed, so the caller does not spend a turn writing a brief for a spawn that cannot
        // happen. The old one said only what NOT to do, and in the incident behind t-e787dc the
        // caller answered a refusal that pointed nowhere by putting an absolute path in the child's
        // BRIEFING — the least governed outcome available.
        //
        // t-5f823a — it used to sit ABOVE the resolution and read the caller's LITERAL `parent`,
        // which made it catch only the explicit pair. Measured consequence: an agent that passed
        // cwd alone sailed past here, had its omitted parent filled in with its own name two lines
        // up, and was refused by the AgentManager one step later — with a message telling it to
        // "spawn without parent and pass cwd", which is exactly what it had just done. The rule was
        // right and the message was unexecutable, which is the worse of the two failures.
        //
        // So it runs on the RESOLVED parent, which is the honest predicate ("will this child be
        // parented?"), and renders the refusal for THIS caller — an agent hears only the exits an
        // agent has. Resolution is pure and cheap; nothing has been composed or mutated yet, so
        // t-6fe04b's "refuse at the entry" property is unchanged.
        if (parent && cwd) {
          return fail(new Error(parentCwdRefusalFor(deps.caller?.kind)));
        }
        // SDD 478 M9 — attestation runs BEFORE every other Temporary check, including the delegation
        // contract. A command that may not be an agent at all must hear WHY and which operation to use;
        // being told first that its delegation contract is incomplete would send the caller to fill in
        // a brief for an entity this door is never going to create.
        //
        // Scoped to the genuine Temporary door: a `delivery_join` execution is a DIFFERENT door with its
        // own contract (an immutable Delivery, an owned subset, an expected HEAD) and its own measured
        // policy for an unrecognized reviewer runtime — SDD 368 T10 deliberately runs one and advises
        // rather than refusing. M9 was told to enforce a boundary, not to withdraw that.
        if (cmd) {
          const admission = admitAgentRuntimeCommand(cmd);
          if (!admission.ok) return fail(new Error(`spawn_agent refused: ${admission.reason}`));
        }
        // t-48f504 / t-66c4d7 — DECIDE every board claim here. APPLY them before launch.
        //
        // Splitting the two is the whole point of the measured incident: the spawn SUCCEEDED three
        // times at work the child could not hold, so the refusal arrived a launch and a 13KB brief
        // later, from the child. Deciding at the entry makes an unreachable contract cost a tool call.
        // Validation finishes before any write. One invalid item refuses the complete dispatch.
        // A partial spawn would recreate the disagreement this parameter removes.
        const claimTaskIds = claim_task === undefined
          ? []
          : [...new Set(Array.isArray(claim_task) ? claim_task : [claim_task])];
        const claimPlans: Array<{ id: string; prior: Task; decision: SpawnTaskClaimDecision }> = [];
        for (const claimTaskId of claimTaskIds) {
          let boardTask: Task;
          try {
            boardTask = deps.tasks.get(claimTaskId);
          } catch (error) {
            return fail(new Error(`spawn_agent cannot claim '${claimTaskId}': ${(error as Error).message}`));
          }
          const decision = decideSpawnTaskClaim(boardTask, name);
          if (decision.kind === "refuse") return fail(new Error(decision.reason));
          claimPlans.push({ id: claimTaskId, prior: boardTask, decision });
        }
        // t-d06da3 — a `isTemporaryAiAgent && worktree === true` refusal used to stand here, and it is
        // gone. Two measured reasons, both recorded in spec 484:
        //
        // 1. It protected nothing. The honesty control behind the cwd refusal (c0d6ed81) exists because
        //    a parented child's cwd is DECIDED by `resolveWorktreeCwd`, so a supplied path would be
        //    silently discarded. `worktree:true` supplies no path — there is nothing to discard — and the
        //    resolver's own contract already reads "sub-agent (parent set): inherit the parent's cwd
        //    unless `worktree:true` opts into its own worktree". Only this door disagreed.
        // 2. Its cost was the opposite of containment. With both exits shut, a coordinator's remaining
        //    option was to run the child in the PARENT's worktree — strictly less contained than the
        //    thing being refused — and the exits it named were "declare the agent in tachyon.yml" (an
        //    edit per delegation) and "spawn top-level", which no agent caller can execute: an omitted
        //    parent resolves to the caller (`resolveActor`), so every spawn an agent makes is parented.
        //    That is the same defect 0ac7a71e fixed one refusal over; the fix was written for one message.
        //
        // What replaces it is not a second guard: `worktree` flows to the manager below and the resolver
        // decides, exactly as it does for a declared agent.
        //
        // spec 246 — the contract gate fires only for a Temporary AI-agent spawn (the genuine "delegate a fresh
        // task to a new CLI" case). A declared agent (no cmd, carries config intent) is not gated.
        // Enforced HERE at the agent-facing Bridge surface so it is runtime-neutral across the attested
        // runtimes and never re-fires on restart/resume/fork.
        //
        // M9 collapsed what this used to compute: an accepted `cmd` is an attested runtime by
        // construction now, so there is no longer a terminal child to exempt — the kind is not inferred.
        const suppliedTaskBrief = !!normalizeField(instructions);
        let brief = instructions;
        let contract: SpawnContract | undefined;
        if (isTemporaryAiAgent) {
          if (skip_contract_reason !== undefined) {
            if (normalizeField(skip_contract_reason).length < 10) {
              return fail(new Error("skip_contract_reason must be ≥10 chars explaining why this delegation needs no contract"));
            }
            const structuredFields = [
              ["task", task],
              ["context", context],
              ["constraints", constraints],
              ["deliverable", deliverable],
              ["done_when", done_when],
            ].filter((entry) => entry[1] !== undefined).map((entry) => entry[0]);
            if (structuredFields.length > 0) {
              return fail(new Error(
                `skip_contract_reason cannot be combined with structured contract fields: ${structuredFields.join(", ")}. ` +
                "For delegated work, remove skip_contract_reason so the contract is validated and delivered; " +
                "for a genuinely trivial spawn, remove the structured contract fields.",
              ));
            }
            deps.notify(`agent '${parent ?? "?"}' spawned '${name}' WITHOUT a delegation contract — reason: ${normalizeField(skip_contract_reason)}`, "warn");
            if (!suppliedTaskBrief) {
              brief = idleSpawnGuidance(skip_contract_reason);
            }
            // spec 332 — the skip-reason path bypasses the full contract, but a delegated child with a
            // parent still gets taught to notify_agent(<parent>) on completion (dueto: the guidance is
            // orthogonal to whether the FULL contract was given).
            if (parent) {
              // t-8605be part 3 — same orthogonality as notifyParentGuidance: a contract-skipped spawn
              // still needs the no-blocking-on-prompts guidance, when there's a parent to route to.
              const guidance = `${notifyParentGuidance(parent)}\n\n${noInteractivePromptGuidance(parent)}`;
              brief = brief ? `${brief}\n\n${guidance}` : guidance;
            }
            // t-d7b3a9 layer A — even a contract-skipped spawn gets told its own name (dueto: identity
            // confusion doesn't care whether the full delegation contract was filled in).
            brief = brief ? `${identityLine(name)}\n\n${brief}` : identityLine(name);
          } else {
            const candidate = { task, context, constraints, deliverable, doneWhen: done_when };
            const v = validateSpawnContract(candidate);
            if (!v.ok) {
              return fail(
                new Error(
                  `spawn_agent needs a delegation contract for an AI sub-agent. Fix and retry:\n- ${v.errors.join("\n- ")}\n` +
                    "(or pass skip_contract_reason=<why, ≥10 chars> for a genuinely trivial spawn)",
                ),
              );
            }
            contract = { task: task!, context: context!, constraints: constraints!, deliverable, doneWhen: done_when };
            brief = composeSpawnContractBrief(name, contract, instructions, parent);
          }
        }
        // Each claim moves status and assignee in one store transaction.
        // A failed later write releases earlier claims before refusing the dispatch.
        //
        // It goes through the store directly rather than through `update_task`, whose SDD-370 guard
        // refuses assigning to an agent whose runtime is not ready. That guard is right for the tool
        // and wrong here: the launch three lines down is what makes the runtime ready, so the claim
        // is the one assignment that must precede readiness. The CAS on `updatedAt` keeps it honest
        // against a concurrent board writer between each decision and write.
        const claimed: Array<{ task: Task; prior: Task }> = [];
        try {
          for (const plan of claimPlans) {
            if (plan.decision.kind !== "claim") continue;
            const updated = await deps.tasks.update(plan.id, {
              status: "active",
              assignee: name,
              expect: { updatedAt: plan.prior.updatedAt },
              ...(deps.caller?.kind === "agent" && deps.caller.name ? { actor: deps.caller.name } : {}),
            });
            claimed.push({ task: updated, prior: plan.prior });
            deps.onTasksChanged?.({ reason: "task-mutated", id: updated.id });
            const claimActor = taskNotificationActor(deps);
            emitTaskNotification(deps, { type: "assigned", task: updated, actor: claimActor, from: plan.prior.assignee, to: name });
            emitTaskNotification(deps, { type: "statusChanged", task: updated, actor: claimActor, from: plan.prior.status, to: "active" });
          }
        } catch (claimError) {
          for (const entry of claimed.slice().reverse()) {
            await releaseSpawnClaim(deps, entry.task, entry.prior);
          }
          throw claimError;
        }
        try {
          // reveal:false — spawning a child must not steal the human's editor focus (F3);
          // the child shows in the tree (nested under parent), opened on demand.
          await deps.manager.spawn(name, {
            cmd,
            // M9 — this door only ever asks for an Agent, and says so instead of letting the manager
            // work it out from the command string.
            kind: "agent",
            cwd,
            // A contract-skipped idle spawn has operational waiting guidance, not an execution brief.
            // Keep it in the instructions layer so the startup manifest truthfully reports no task.
            instructions: isTemporaryAiAgent
              ? (skip_contract_reason !== undefined && !suppliedTaskBrief ? brief : undefined)
              : brief,
            taskBrief: isTemporaryAiAgent
              ? (skip_contract_reason !== undefined && !suppliedTaskBrief ? undefined : brief)
              : undefined,
            parent,
            worktree,
            reveal: false,
            contract,
            contractSkipReason: skip_contract_reason,
          });
        } catch (spawnError) {
          // A claim that outlives its failed launch is the defect wearing the other face: the board
          // would hold `active`/assigned work for an agent that does not exist, and the next reader —
          // human or a restart of the same name — would believe it. Put the row back exactly as the
          // decision above found it, and say so if even that fails.
          for (const entry of claimed.slice().reverse()) {
            await releaseSpawnClaim(deps, entry.task, entry.prior);
          }
          throw spawnError;
        }
        const session = deps.manager.session(name);
        const state = deps.manager.kindOf(name) !== "agent" || await deps.manager.isReady(name) ? "ready" : "starting";
        return ok(JSON.stringify({ agent: name, session, state }, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "spawn_terminal",
    {
      description:
        "Start a generic process in this workspace — a shell, a server, a build, a watcher. This is the other half of " +
        "the Agent/Terminal boundary (SDD 478): a terminal is a process, not an entity. It has no task, no lineage, no " +
        "brief, no delegation contract, no worktree, no memory and no model — those are agent capabilities, and " +
        `there are no parameters here to carry them. Use spawn_agent for a supported LLM runtime (${SUPPORTED_AGENT_RUNTIME_NAMES.join(", ")}). ` +
        "Stop it with kill_agent and remove the stopped row with dismiss_agent, exactly like any other Temporary entry.",
      inputSchema: {
        name: AGENT_NAME.describe("managed entry name (becomes part of the tmux session name)"),
        cmd: z.string().min(1).describe("the command to run, verbatim — Tachyon does not interpret it"),
        cwd: z.string().optional().describe("working directory for the process"),
      },
    },
    async ({ name, cmd, cwd }) => {
      try {
        // No parent: lineage is an Agent semantic. A terminal that showed up nested under a spawner
        // would read as a delegation, which is the exact confusion this operation exists to end.
        await deps.manager.spawn(name, { cmd, kind: "terminal", cwd, reveal: false });
        return ok(JSON.stringify({ terminal: name, session: deps.manager.session(name), state: "ready" }, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "kill_agent",
    {
      description:
        "Compatibility name: stop a running managed entry (kills its tmux session). GOVERNANCE (t-bec361): " +
        "as an agent you may stop only yourself, an agent below you in your own lineage, or a Saved Agent you own " +
        "in the roster — never a sibling, a parent, or an unrelated fleet member. An out-of-scope target is refused with a structured error naming " +
        "the target's owner. For a Temporary that owns a checkout this call also removes its worktree and branch, " +
        "which is why the scope is narrower than read-only tools'. For a Temporary, end-of-life removes " +
        "Tachyon activity, pane transcripts, and the private runtime home under .tachyon/bridge-mcp. A harness home " +
        "under .tachyon/harness keeps its runtime-native caches, which are not a uniform archive.",
      inputSchema: { name: AGENT_NAME },
    },
    async ({ name }) => {
      try {
        // Ahead of every side effect, including the worktree cascade below: an out-of-scope caller
        // must not be able to reach the teardown, and must not learn from a refusal whether it ran.
        const denied = lifecycleScopeGuard(deps, "kill_agent", name);
        if (denied) return fail(new Error(denied));
        const info = await managedEntry(deps, name);
        // t-a76aed — for a running Temporary that owns a checkout, kill IS the reachable end-of-life
        // door: it is the call a coordinator makes on a finished child, and the documented follow-up
        // `dismiss_agent` used to answer "not found" because kill had already collected the row. Run the
        // same worktree cascade dismiss uses, while the owning row still exists. Do not put the CASCADE
        // in AgentManager.kill: removeAgentWorktree itself uses manager.kill to stop occupancy, so doing
        // that would recurse (and would double-remove through the other doors). t-28bf8f puts the far
        // narrower row-collection GUARD there instead — no recursion, and it covers the sidebar's Kill.
        if (info?.lifetime === "temporary" && deps.agentWorktrees?.ledger.get(name)?.worktree) {
          const released = await dismissOwnedWorktree(deps, name);
          // t-28bf8f — the row is collected HERE, and only here, because only now is the checkout
          // proved released. The cascade's own occupancy gate tore the pane down through
          // `manager.kill`, which since t-28bf8f deliberately leaves a still-owning Temporary row
          // listed; a refusal anywhere above therefore throws past this line and the agent stays
          // addressable for the retry, instead of vanishing from the board with its checkout, its
          // branch and its registry entry stranded behind it.
          deps.manager.dismissTemporary(name);
          return ok(dismissReceipt(name, released));
        }
        await deps.manager.kill(name);
        return ok(`agent '${name}' killed`);
      } catch (err) {
        const info = await managedEntry(deps, name);
        // t-28bf8f — this hint belongs to the plain kill door alone. A cascade refusal now leaves
        // exactly this shape (listed, Temporary, pane down), and answering it with "use dismiss_agent"
        // would replace the measured reason — a live root process in the checkout — with advice for a
        // different problem, pointing at a door that refuses identically because the refusal is right.
        if (info && info.lifetime === "temporary" && !info.running && !deps.agentWorktrees?.ledger.get(name)?.worktree) {
          return fail(new Error(`agent '${name}' is not running; use dismiss_agent to remove the stopped Temporary entry`));
        }
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "dismiss_agent",
    {
      description:
        "Dismiss a stopped Temporary managed entry from this workspace. This removes the ephemeral row and its durable " +
        "Temporary footprint; it is only valid for Temporary entries that are no longer running. Use kill_agent first for " +
        "a running Temporary instance. Tachyon activity and pane transcripts are deleted, and so is the private runtime " +
        "home under .tachyon/bridge-mcp (Grok/Hermes, with a receipt naming its size), plus the file-shaped configs there for Claude/OpenCode. A harness home under " +
        ".tachyon/harness keeps its runtime-native caches, which are not a uniform archive. Declared tachyon.yml agents " +
        "cannot be dismissed through the Bridge.",
      inputSchema: { name: AGENT_NAME },
    },
    async ({ name }) => {
      try {
        const info = await managedEntry(deps, name);
        if (!info) return fail(new Error(`agent '${name}' not found`));
        // t-849277 — `saved` is a lifetime, not an entity kind. Both profile-backed agents and
        // declared terminals have that lifetime, but only the former can use the removal-proposal
        // and Agent Studio doors. A terminal's human door is the sidebar Remove action; its API door
        // is the same `config.agent.delete` operation that action invokes.
        if (info.lifetime === "saved") {
          if (info.kind === "terminal") {
            return fail(new Error(
              `agent '${name}' is a terminal declared in tachyon.yml and cannot be dismissed through the Bridge; ` +
              "use Remove in the sidebar, or invoke config.agent.delete",
            ));
          }
          return fail(new Error(
            `agent '${name}' is a Saved Agent (declared in tachyon.yml) and cannot be dismissed through the Bridge; ` +
            "use propose_saved_agent_removal for a human-approved retirement, or remove it from Agent Studio",
          ));
        }
        if (info.running) return fail(new Error(`agent '${name}' is still running; use kill_agent first, then dismiss_agent if it remains listed`));
        // t-d06da3 — the worktree step, ahead of BOTH dismissal branches, through the cascade the
        // other door already runs. See `dismissOwnedWorktree` for why it is that cascade and not a
        // second one, and which of its gates a Temporary dismiss actually needs.
        const released = await dismissOwnedWorktree(deps, name);
        if (info.dead && !released) {
          await deps.manager.kill(name);
          return ok(`agent '${name}' dismissed`);
        }
        // A `dead` entry whose checkout WAS released has already had its pane torn down: the cascade's
        // occupancy gate reads a stopped-but-present pane as occupied and kills it, through the same
        // `manager.kill` this branch would call. Calling it twice would throw AgentNotRunningError and
        // turn a completed dismissal into an error; `dismissTemporary` is idempotent and finishes the row.
        deps.manager.dismissTemporary(name);
        return ok(dismissReceipt(name, released));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "acknowledge_agent",
    {
      description:
        "Answer the host's idle/stall poke about a child: you inspected it, you decided, leave it as it is. " +
        "The fifth exit beside inspect / dismiss / resume / re-delegate — the one that means 'I know'. It does NOT " +
        "mute the child: Tachyon stays quiet only while the state you acknowledged holds, and speaks again when that " +
        "child produces new output, changes state, or stays idle several times longer than the window you " +
        "acknowledged — and the returning line says WHICH of those happened. Refused when nothing was asked about " +
        "that child, so it can never be used as a pre-emptive mute. The acknowledgement is session-local and does not " +
        "survive a re-delegation of the same name.",
      inputSchema: { name: AGENT_NAME.describe("the child agent the poke was about") },
    },
    async ({ name }) => {
      try {
        if (!deps.acknowledgeIdlePoke) return fail(new Error("acknowledge_agent is not available on this Bridge"));
        const info = await managedEntry(deps, name);
        if (!info) return fail(new Error(`agent '${name}' not found`));
        const receipt = deps.acknowledgeIdlePoke(name);
        if (!receipt) {
          return fail(new Error(
            `no outstanding idle poke for '${name}' — nothing to acknowledge. ` +
            "Acknowledgement answers a notice you were sent; it cannot be taken in advance.",
          ));
        }
        return ok(JSON.stringify({
          agent: receipt.agent,
          acknowledged: receipt.reason === "idle" ? "idle" : "silent while working",
          idleMinutes: Math.round(receipt.idleMs / 60_000),
          nextCheckInMinutes: receipt.nextCheckInMs === null ? null : Math.round(receipt.nextCheckInMs / 60_000),
          note: "silent until this child changes state, produces new output, or reaches the next check-in",
        }, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "runtime_condition",
    {
      description:
        "What condition is each runtime in — read before deciding WHERE to send work. Answers two "
        + "INDEPENDENT axes and never merges them: configuration/capability (is this runtime manageable, "
        + "and how much of that was measured rather than merely documented) and capacity (how much quota "
        + `is left right now). A runtime with no live quota source says '${NO_QUOTA_CHANNEL}' by name — it is `
        + "never reported as zero used and never left silent, because an absence that looks like data is "
        + "worse than an absence. A quota read off a surface rendered for a human is labelled best-effort. "
        + "Every field carries the registry it was derived from; this tool authors no runtime list of its "
        + "own. Purely cached: it reads what Tachyon already collected and starts no runtime process. You "
        + "do not have to poll it — when a runtime's slack comes back, Tachyon pokes the coordinator.",
      inputSchema: {
        runtime: z
          .string()
          .max(64)
          .optional()
          .describe("report on one runtime only (e.g. 'claude'); omit for every runtime Tachyon knows"),
      },
    },
    async ({ runtime }) => {
      try {
        if (!deps.runtimeCondition) return fail(new Error("runtime_condition is not available on this Bridge"));
        const report = deps.runtimeCondition();
        if (!runtime) return ok(JSON.stringify(report, null, 2));
        const selected = report.runtimes.find((entry) => entry.runtime === runtime);
        if (!selected) {
          const known = report.runtimes.map((entry) => entry.runtime).join(", ");
          return fail(new Error(`no runtime '${runtime}' — Tachyon knows: ${known}`));
        }
        return ok(JSON.stringify({ ...report, runtimes: [selected] }, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "restart_agent",
    {
      description:
        "Restart a managed entry (spec 389). stop=graceful|force (default graceful) × session=resume|new (default resume; falls back to new when resume is unavailable). " +
        "Graceful asks the CLI to exit, waits, then force-kills the tmux session only if still alive (never dismisses a Temporary instance). " +
        "Force replaces the process immediately. Crash/watch auto-restarts use force+new internally. " +
        "GOVERNANCE (t-bec361/t-b5f896): as an agent you may restart only yourself, an agent below you in your own " +
        "lineage, or a Saved Agent you own in the roster; an out-of-scope target is refused with a structured error naming the target's owner.",
      inputSchema: {
        name: AGENT_NAME,
        stop: z.enum(["graceful", "force"]).optional().describe("how to stop a live pane; default graceful"),
        session: z.enum(["resume", "new"]).optional().describe("resume prior conversation or open a new section; default resume"),
      },
    },
    async ({ name, stop, session }) => {
      try {
        const denied = lifecycleScopeGuard(deps, "restart_agent", name);
        if (denied) return fail(new Error(denied));
        // Product defaults: graceful + resume (AgentManager applies the same when omitted).
        const result = await deps.manager.restart(name, {
          stop: stop ?? "graceful",
          session: session ?? "resume",
        });
        const mode = `${result.stop}+${result.session}`;
        const detail = [
          // t-f6aa7c — a caller that ASKED to resume and got a new section is told why here too.
          // The same silence that let a human discover a crashed agent's memory loss by behaviour
          // would let an agent discover its own the same way; `resumeUnavailable` is present only on
          // that path, so an ordinary `session: "new"` receipt is unchanged.
          result.resumed
            ? "resumed prior session"
            : `new section${result.resumeUnavailable ? ` (${result.resumeUnavailable})` : ""}`,
          result.forcedAfterGracefulTimeout ? "graceful timed out → session hard-kill" : undefined,
        ].filter(Boolean).join("; ");
        return ok(`agent '${name}' restarted (${mode}; ${detail})`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  /**
   * SDD 482 phase 4C — the ownership roster, rebuilt from the rows the Bridge already has.
   *
   * `declaredOwner` is DERIVED from each agent's `subagents` at config load, so inverting it here
   * reconstructs the same relation rather than reading a second source that could disagree with the
   * first. Terminals are included because the spec 352 contract refuses them as ownership targets by
   * NAME — omitting them would turn "that is a terminal" into the less useful "that does not exist".
   */
  const workspaceOwnershipRoster = async (
    bridge: Pick<BridgeDeps, "manager">,
  ): Promise<AgentOwnershipRosterV1> => {
    const rows = await bridge.manager.list();
    return rows.map((row) => ({
      name: row.name,
      kind: row.kind === "terminal" ? ("terminal" as const) : ("agent" as const),
      subagents: rows.filter((other) => other.declaredOwner === row.name).map((other) => other.name),
    }));
  };

  /**
   * SDD 482 phase 4 slice B (`t-5e1113`) — the ONLY agent-facing entry point to the creation door,
   * and it can do exactly one thing: leave a typed, digest-bound proposal where a human will find it.
   *
   * The baseline this changes: before this tool, an agent could not reach profile creation by any
   * route at all. It still cannot — nothing here writes a profile, an authority record or a roster
   * entry, and there is deliberately no approval or commit path yet. What an agent gains is the
   * ability to ASK, under a capability no profile in this workspace currently holds.
   *
   * IDENTITY IS AUTHENTICATED, NOT DECLARED. The proposer is `deps.caller`, resolved by the Bridge
   * from the token, and there is no `proposer` parameter to override it. This matters more here than
   * almost anywhere else: the Bridge's auth is one shared token, so if the tool accepted a name, ANY
   * agent could borrow the identity of one that holds the grant and the capability check would be
   * decorative. A non-agent caller is refused outright — a legacy or human-kind token has no profile
   * to carry a grant, and treating "no profile" as "no restriction" is the classic direction of this
   * bug.
   */
  mcp.registerTool(
    "propose_saved_agent",
    {
      description:
        "Propose that a human create a Saved Agent (a durable agent profile in this workspace). This does NOT create " +
        "anything: it records a typed, digest-bound proposal for a human to review, and requires the caller's profile " +
        "to hold the 'grants.proposeSavedAgent' capability — absence is refused by name. Ownership, model, reasoning and " +
        "requested grants are explicit, digest-bound and shown to the human. Nothing starts automatically. Identical " +
        "re-proposals collapse onto the live one; proposals expire after 24h.",
      inputSchema: {
        name: AGENT_NAME.describe("roster name for the proposed Saved Agent"),
        runtime_adapter: z.string().min(1).max(64).describe("runtime adapter id, e.g. 'claude'"),
        rationale: z.string().min(1).max(4000).describe("why this agent should exist — shown to the human verbatim"),
        executable: z.string().min(1).max(256).optional(),
        display_name: z.string().min(1).max(256).optional(),
        model: z.string().min(1).max(512).optional(),
        reasoning_effort: z.string().min(1).max(128).optional(),
        permission_authorizations: z.array(z.string().min(1).max(128)).max(8).optional().describe(
          "explicit runtime-native permission capabilities to authorize; validated against the selected runtime and shown to the human",
        ),
        ownership: z.enum(["proposer", "top-level"]).optional().describe(
          "durable roster ownership (default proposer). top-level creates no declaredOwner edge.",
        ),
        grant_propose_saved_agent: z.boolean().optional().describe(
          "request authority to propose further Saved Agents; every future proposal still needs human approval",
        ),
        skills: z.array(z.string().min(1).max(128)).max(64).optional(),
        mcp_servers: z.array(z.string().min(1).max(128)).max(64).optional(),
        // t-4071e4 — isolated or not, and nothing else. There is deliberately no path/branch/base
        // parameter: the checkout location is governed by the workspace, and a proposer that could
        // name it would be escaping the worktrees root rather than stating a preference. Omitted means
        // ISOLATED — a proposed agent is born in its own worktree, and the human sees that at review.
        isolated_worktree: z.boolean().optional().describe(
          "run in its own isolated git worktree (default true). The path and branch are never yours to choose.",
        ),
      },
    },
    async (input) => {
      try {
        const caller = deps.caller ?? { kind: "legacy" as const };
        if (caller.kind !== "agent" || !caller.name) {
          return fail(new Error(
            "CALLER_REQUIRED: propose_saved_agent requires a Bridge-resolved agent caller; a proposal is bound to the " +
            "proposer's profile grant, and a caller without a profile has no grant to check",
          ));
        }
        const proposer = caller.name;
        const admission = recordSavedAgentProposal({
          workspaceRoot: deps.workspaceRoot,
          proposer,
          proposerProfile: { grants: readAgentProfileGrants(deps.workspaceRoot, proposer) },
          spec: {
            name: input.name,
            runtimeAdapter: input.runtime_adapter,
            rationale: input.rationale,
            ...(input.executable ? { executable: input.executable } : {}),
            ...(input.display_name ? { displayName: input.display_name } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.reasoning_effort ? { reasoningEffort: input.reasoning_effort } : {}),
            ...(input.permission_authorizations?.length
              ? { permissionAuthorizations: input.permission_authorizations }
              : {}),
            ...(input.ownership ? { ownership: input.ownership } : {}),
            ...(input.grant_propose_saved_agent ? { grants: { proposeSavedAgent: true } } : {}),
            ...(input.isolated_worktree !== undefined ? { workspace: { worktree: input.isolated_worktree } } : {}),
            ...(input.skills?.length || input.mcp_servers?.length
              ? {
                  capabilities: {
                    ...(input.skills?.length ? { skills: input.skills } : {}),
                    ...(input.mcp_servers?.length ? { mcp: input.mcp_servers } : {}),
                  },
                }
              : {}),
          },
          base: { configSha256: workspaceConfigSha256(deps.workspaceRoot) },
          nowMs: Date.now(),
          // The ownership edge this WILL create — proposer owns the new agent — is validated against
          // the live roster by the same spec 352 rules a Studio edit obeys, so a conflict surfaces
          // before a human approves rather than as an opaque config rollback afterwards. v1 refuses
          // any other ownership claim, so there is no `owns_subagents` input to carry one.
          roster: await workspaceOwnershipRoster(deps),
        });
        if (!admission.ok) return fail(new Error(`${admission.code}: ${admission.reason}`));
        // t-8e9b5e — ring the doorbell. Best-effort: a notification that fails must never turn a
        // recorded proposal into a failed call, because the proposal IS the durable outcome.
        if (!admission.collapsedOnto) {
          try {
            deps.onSavedAgentProposed?.({
              id: admission.proposal.id,
              name: input.name,
              proposer,
            });
          } catch { /* observation only */ }
        }
        return ok(JSON.stringify({
          id: admission.proposal.id,
          digest: admission.proposal.digest,
          expiresAt: admission.proposal.expiresAt,
          collapsedOnto: admission.collapsedOnto,
          // Said plainly so a proposer does not wait for something that cannot happen yet.
          state: "pending human review; nothing is created until a human approves this exact digest",
        }, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_saved_agent_proposals",
    {
      description:
        "List this workspace's live (unexpired) Saved Agent proposals AND decided ones (approved, denied, cancelled, expired). " +
        "Read-only. Live rows carry the proposer, the digest a human approval would be bound to, and the expiry. " +
        "`decided` is how the four terminal outcomes stay distinguishable after the live file is gone.",
      inputSchema: {},
    },
    async () => {
      try {
        // Not scoped to the caller: the queue is shared, the ceiling is per-proposer, and an agent
        // that cannot see a neighbour's pending proposal will re-propose the same agent under a
        // different name. Nothing here is secret — it is what the human is about to be shown.
        const nowMs = Date.now();
        const queue = readLiveSavedAgentProposalQueue(deps.workspaceRoot, nowMs);
        return ok(JSON.stringify({
          proposals: queue.proposals.map((p) => ({
            id: p.id,
            proposer: p.proposer,
            digest: p.digest,
            createdAt: p.createdAt,
            expiresAt: p.expiresAt,
            spec: p.spec,
          })),
          decided: listSavedAgentProposalDecisions(deps.workspaceRoot, nowMs).map((d) => ({
            id: d.id,
            proposer: d.proposer,
            digest: d.digest,
            agentName: d.agentName,
            outcome: d.outcome,
            resolvedAt: d.resolvedAt,
            resolvedBy: d.resolvedBy,
          })),
          // Reported, never hidden: a queued file that fails its digest is the one thing a reader must
          // not mistake for "withdrawn". It also consumes ceiling, so an unexplained refusal would be
          // worse than the noise.
          unreadable: queue.unreadable,
        }, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "cancel_saved_agent_proposal",
    {
      description:
        "Withdraw a Saved Agent proposal you made. Only the proposer may cancel its own proposal. Cancelling an id that " +
        "is already gone succeeds, so a retry after a crash converges instead of failing.",
      inputSchema: {
        id: z.string().regex(/^sp-[0-9a-f]{6}$/, "proposal id must be sp-<6hex>"),
        reason: z.string().min(1).max(500).describe("short audit reason, recorded in the witness log"),
      },
    },
    async ({ id, reason }) => {
      try {
        const caller = deps.caller ?? { kind: "legacy" as const };
        if (caller.kind !== "agent" || !caller.name) {
          return fail(new Error("CALLER_REQUIRED: cancel_saved_agent_proposal requires a Bridge-resolved agent caller"));
        }
        const result = cancelSavedAgentProposal({
          workspaceRoot: deps.workspaceRoot,
          id,
          by: caller.name,
          reason,
          nowMs: Date.now(),
        });
        return ok(result.cancelled ? `proposal '${id}' cancelled` : `proposal '${id}' was already gone`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  /**
   * t-afe120 — the ONLY agent-facing entry to Saved Agent retirement. Symmetric with propose_saved_agent:
   * records a digest-bound request; human approval runs the host-side forget cascade. Does NOT loosen
   * dismiss_agent (which correctly refuses Saved Agents).
   */
  mcp.registerTool(
    "propose_saved_agent_removal",
    {
      description:
        "Propose that a human RETIRE a Saved Agent (profile-backed roster entry). This does NOT remove anything: it " +
        "records a typed, digest-bound proposal for Human Inbox review. Requires the caller's profile to hold " +
        "'grants.proposeSavedAgent' — same capability as proposing creation. On human approval the host stops the " +
        "session, releases any governed worktree, and retires profile+authority+roster through the same cascade as " +
        "Agent Studio Forget. Temporary entries use kill_agent + dismiss_agent instead. You cannot propose removing yourself.",
      inputSchema: {
        name: AGENT_NAME.describe("Saved Agent roster name to retire"),
        rationale: z.string().min(1).max(4000).describe("why this agent should be removed — shown to the human verbatim"),
      },
    },
    async (input) => {
      try {
        const caller = deps.caller ?? { kind: "legacy" as const };
        if (caller.kind !== "agent" || !caller.name) {
          return fail(new Error(
            "CALLER_REQUIRED: propose_saved_agent_removal requires a Bridge-resolved agent caller; a proposal is bound to the " +
            "proposer's profile grant, and a caller without a profile has no grant to check",
          ));
        }
        const proposer = caller.name;
        const info = await managedEntry(deps, input.name);
        const profile = deps.inspectSavedAgentProfile
          ? await deps.inspectSavedAgentProfile(input.name)
          : undefined;
        const admission = recordSavedAgentRemovalProposal({
          workspaceRoot: deps.workspaceRoot,
          proposer,
          proposerProfile: { grants: readAgentProfileGrants(deps.workspaceRoot, proposer) },
          spec: { name: input.name, rationale: input.rationale },
          base: { configSha256: workspaceConfigSha256(deps.workspaceRoot) },
          target: {
            ...(profile ? { profile } : {}),
            ...(info?.lifetime === "temporary" ? { temporary: true } : {}),
          },
          nowMs: Date.now(),
        });
        if (!admission.ok) return fail(new Error(`${admission.code}: ${admission.reason}`));
        if (!admission.collapsedOnto) {
          try {
            deps.onSavedAgentRemovalProposed?.({
              id: admission.proposal.id,
              name: input.name,
              proposer,
            });
          } catch { /* observation only */ }
        }
        return ok(JSON.stringify({
          id: admission.proposal.id,
          digest: admission.proposal.digest,
          expiresAt: admission.proposal.expiresAt,
          collapsedOnto: admission.collapsedOnto,
          agent: input.name,
          state: "pending human review; nothing is removed until a human approves this exact digest",
        }, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_saved_agent_removal_proposals",
    {
      description:
        "List this workspace's live (unexpired) Saved Agent removal proposals AND decided ones (approved, denied, cancelled, expired). " +
        "Read-only. Live rows carry the proposer, the digest a human approval would be bound to, the target agent, and the expiry. " +
        "`decided` is how the four terminal outcomes stay distinguishable after the live file is gone.",
      inputSchema: {},
    },
    async () => {
      try {
        const nowMs = Date.now();
        const queue = readLiveSavedAgentRemovalProposalQueue(deps.workspaceRoot, nowMs);
        return ok(JSON.stringify({
          proposals: queue.proposals.map((p) => ({
            id: p.id,
            proposer: p.proposer,
            digest: p.digest,
            createdAt: p.createdAt,
            expiresAt: p.expiresAt,
            spec: p.spec,
            base: {
              agentId: p.base.agentId,
              profileRevision: p.base.profileRevision.slice(0, 16) + "…",
            },
          })),
          decided: listSavedAgentRemovalProposalDecisions(deps.workspaceRoot, nowMs).map((d) => ({
            id: d.id,
            proposer: d.proposer,
            digest: d.digest,
            agentName: d.agentName,
            outcome: d.outcome,
            resolvedAt: d.resolvedAt,
            resolvedBy: d.resolvedBy,
          })),
          unreadable: queue.unreadable,
        }, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "cancel_saved_agent_removal_proposal",
    {
      description:
        "Withdraw a Saved Agent removal proposal you made. Only the proposer may cancel its own proposal. Cancelling " +
        "an id that is already gone succeeds, so a retry after a crash converges instead of failing.",
      inputSchema: {
        id: z.string().regex(/^sr-[0-9a-f]{6}$/, "removal proposal id must be sr-<6hex>"),
        reason: z.string().min(1).max(500).describe("short audit reason, recorded in the witness log"),
      },
    },
    async ({ id, reason }) => {
      try {
        const caller = deps.caller ?? { kind: "legacy" as const };
        if (caller.kind !== "agent" || !caller.name) {
          return fail(new Error("CALLER_REQUIRED: cancel_saved_agent_removal_proposal requires a Bridge-resolved agent caller"));
        }
        const result = cancelSavedAgentRemovalProposal({
          workspaceRoot: deps.workspaceRoot,
          id,
          by: caller.name,
          reason,
          nowMs: Date.now(),
        });
        return ok(result.cancelled ? `removal proposal '${id}' cancelled` : `removal proposal '${id}' was already gone`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_agents",
    {
      description:
        "Compatibility name: list this workspace's managed entries: agents and terminals declared in tachyon.yml and/or currently running. " +
        "Rows include runtime parent lineage plus declaredOwner ownership metadata from tachyon.yml subagents, advisory capabilities for output reading, and stopped Temporary dismissal; action tools still re-check state.",
      inputSchema: {},
    },
    async () => {
      try {
        const agents = await deps.manager.list();
        const enriched = await Promise.all(
          agents.map(async (a) => {
            return {
              ...a,
              capabilities: outputCapabilities(a, deps),
              ...(a.running && deps.attentionOf?.(a.name) ? { attention: deps.attentionOf(a.name) } : {}),
            };
          }),
        );
        return ok(JSON.stringify(enriched, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "agent_touched_files",
    {
      description:
        "t-75e9c7 — which files has each LIVE agent already touched, read from its OWN worktree diff " +
        "(current base-branch merge-base vs working tree, spec 213) instead of anyone declaring it. " +
        "Using the current merge-base prevents a Saved Agent's stale creation base from attributing " +
        "main-branch drift to that agent (t-004255). Replaces the coordinator " +
        "writing that list from memory into every brief: this is a FACT observed during the work, not a " +
        "promise made before it. Includes UNCOMMITTED changes on purpose — an agent with zero commits " +
        "yet is not reported as having 'touched nothing', because that would be exactly the lie this " +
        "tool exists to kill. Cheap: three `git` calls per live agent, run on demand (no cache to go " +
        "stale). Read-only and ADVISORY — this is not a file lock (worktrees already isolate writes); " +
        "it only tells you where two agents' work will collide at MERGE. An agent with no isolated " +
        "worktree (a shared-checkout agent) is reported by name with worktree:false and a note, never " +
        "silently folded into an empty file list.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!deps.touchedFiles) return fail(new Error("agent_touched_files is not available on this Bridge (no worktree diff port)"));
        const rows = await deps.manager.list();
        const report = await collectAgentTouchedFiles(
          rows,
          (name) => deps.agentWorktrees?.ledger.get(name)?.worktree,
          { changedFiles: deps.touchedFiles, mergeBase: deps.touchedFilesMergeBase },
        );
        return ok(JSON.stringify(report, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ── SDD 494 Part 4 — the roster reconciliation, beside reconcile_worktrees ────────────
  mcp.registerTool(
    "reconcile_roster",
    {
      description:
        "SDD 494 Part 4 — confront the four records that hold a Saved Agent's presence and report, per " +
        "agent: membership, the four owner facts (roster row, profile on disk, host authority, runtime " +
        "projection), the derived disagreement state, and THE DOOR THAT WOULD REMOVE IT. Read-only: " +
        "nothing is written, and the state is derived on every call because three of the four facts live " +
        "outside Tachyon's records. Ask it when an agent looks broken and you do not know where to take " +
        "it out. The five states are orphan-locator (roster row, no profile), unlisted-profile (profile, " +
        "no roster row), unattested (no host authority), unprojectable (all three records agree and the " +
        "runtime projection fails), and stranded-authority (authority only); `consistent` means the " +
        "records agree. A member is removable through Agent Studio Forget or " +
        "propose_saved_agent_removal even when it cannot run — removal reads membership, never " +
        "runnability. A state with no roster row reports no door and is never cleaned up automatically, " +
        "because the residue may be a profile that holds work.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!deps.savedAgentRosterReconciliation) return fail(new Error("roster reconciliation is not available on this Bridge"));
        return ok(JSON.stringify(await deps.savedAgentRosterReconciliation(), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
