import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ScheduleDef } from "../../config/loadConfig.js";
import { type BridgeDeps, AGENT_NAME, fail, ok, proposalAuthor, validateProposedSchedule } from "./shared.js";

export function registerScheduleTools(mcp: McpServer, deps: BridgeDeps): void {

  mcp.registerTool(
    "propose_schedule",
    {
      description:
        "Propose a scheduled action (a cron-like timer). The proposal is INERT — it never fires — " +
        "until the HUMAN approves it in the sidebar; approving writes it into tachyon.yml. Use this " +
        "when you notice something should run regularly (e.g. tests hourly, a daily standup summary). " +
        "The proposal is recorded under YOUR name, resolved by the Bridge from your token — there is no " +
        "author parameter, because the human approving it is authorizing a config-as-code write and must " +
        "see who asked. " +
        "Exactly one of every (interval like '1h','30m') or at ('HH:MM' daily); exactly one of run (a " +
        "command/runbook name) or spawn (an agent name, optional instructions). Re-proposing the same " +
        "name replaces the prior pending proposal.",
      inputSchema: {
        name: AGENT_NAME.describe("a short name for the schedule"),
        every: z.string().optional().describe("interval, e.g. '1h' or '30m'"),
        at: z.string().optional().describe("daily wall-clock time 'HH:MM' (24h, local)"),
        run: z.string().optional().describe("a command or runbook name to run"),
        spawn: z.string().optional().describe("a declared agent to spawn"),
        instructions: z.string().optional().describe("startup prompt when spawning"),
        reason: z.string().optional().describe("why you want this — shown to the human"),
      },
    },
    async ({ name, every, at, run, spawn, instructions, reason }) => {
      try {
        if (!deps.proposals) return fail(new Error("schedule proposals are not available on this Bridge"));
        const schedule: ScheduleDef = {};
        if (every !== undefined) schedule.every = every;
        if (at !== undefined) schedule.at = at;
        if (run !== undefined) schedule.run = run;
        if (spawn !== undefined) schedule.spawn = spawn;
        if (instructions !== undefined) schedule.instructions = instructions;
        const problem = validateProposedSchedule(schedule);
        if (problem) return fail(new Error(problem));
        const by = proposalAuthor(deps);
        // t-d4f246 — NO capability gate here, and the absence is a decision rather than an omission.
        //
        // A gate on `grants.proposeSavedAgent` was written and removed: it would have denied this tool
        // to every agent in the roster (no canonical profile grants it), and it would have made one flag
        // mean two powers — which is the exact conflation `grants` was created narrow to prevent
        // (t-5e1113: "joining the two would leave a reader unable to tell 'has the fetch MCP' from
        // 'may create agents'"). Whether a schedule proposal deserves a gate OF ITS OWN is a policy
        // question for the maintainer, tracked in t-e5ecec; until then this stays as it has always been.
        //
        // What holds today is the same thing that held before the Inbox landed: the proposal is INERT.
        // It never fires until a human approves it, and approval is now a first-class Inbox decision
        // with a doorbell rather than a row nobody was told about.
        const proposal = deps.proposals.create(name, schedule, by, reason);
        deps.onScheduleProposed?.({ id: proposal.id, name, by });
        return ok(JSON.stringify({ status: "pending human approval", id: proposal.id, name }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_schedules",
    {
      description:
        "List schedules: the active ones (from tachyon.yml, with their next/last run) and any pending " +
        "proposals still awaiting human approval. Pending proposals never fire until approved.",
      inputSchema: {},
    },
    async () => {
      try {
        const active = deps.scheduler ? deps.scheduler.list() : [];
        const pending = deps.proposals ? deps.proposals.list() : [];
        return ok(JSON.stringify({ active, pending }, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
