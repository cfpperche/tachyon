import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runningEnvelope } from "@tachyon/engine/probe/taxonomy.js";
import type { ProbeEnvelope } from "@tachyon/engine/probe/taxonomy.js";
import { type BridgeDeps, fail, ok, resolveDeclaredActor } from "./shared.js";

/** Product input boundary for the runtimes accepted by probe_agent. */
export const PROBE_RUNTIME_SCHEMA = z.enum(["claude", "codex", "grok"]);

export function registerProbeTools(mcp: McpServer, deps: BridgeDeps): void {

  // ---- spec 257 — the captured headless A2A probe lane ----
  if (deps.probe) {
    const probe = deps.probe;
    const SYNC_CAP_MS = deps.probeSyncCapMs ?? 120_000; // OQ1 — a sync call holds at most this long, then hands back a runId
    const INLINE_MSG_CAP = 8000; // D9 — summary inline; the full text stays in the store
    const trim = (env: ProbeEnvelope): ProbeEnvelope => {
      if (env.result && env.result.lastMessage.length > INLINE_MSG_CAP) {
        // Honest pointer (codex review #35): both tools trim, so the ONLY full copy is the stored
        // artifact — name its on-disk path rather than promising a tool path that also truncates.
        return {
          ...env,
          result: { ...env.result, lastMessage: `${env.result.lastMessage.slice(0, INLINE_MSG_CAP)}\n…[truncated — full message in .tachyon/probes/${env.runId}/result.json]` },
        };
      }
      return env;
    };

    mcp.registerTool(
      "probe_agent",
      {
        description:
          "Run a bounded, HEADLESS second-model PROBE — a captured A2A duet that returns a clean structured " +
          "result, NOT a persistent pane you watch (that is spawn_agent). Pick an archetype: " +
          "adversarial-review (a skeptical critique with anti-bias built in) / factual-verify (a fact-check) / " +
          "freeform. Returns {runId,status,result?}: a sync call holds up to ~120s, then returns status:running " +
          "+ runId to poll via read_probe_result. Use this for 'review this', 'is this claim true', 'second opinion'.",
        inputSchema: {
          runtime: PROBE_RUNTIME_SCHEMA,
          archetype: z.enum(["adversarial-review", "factual-verify", "freeform"]).default("adversarial-review"),
          task: z.string().min(1).describe("what to ask the probed model — one substantive directive"),
          context: z.string().optional(),
          constraints: z.string().optional(),
          model: z.string().optional(),
          timeoutSec: z.number().int().min(1).max(600).optional(),
          budgetUsd: z.number().positive().finite().optional(), // reject NaN/Infinity (codex review #43)
          write: z.boolean().default(false).describe("a write-capable probe runs in a separate worktree (not a write sandbox); default read-only"),
          wait: z.enum(["sync", "async"]).default("sync"),
          caller: z.string().optional().describe("your agent name (lineage/authorization) — it's the value of your $TACHYON_AGENT_NAME env var; never guess it"),
        },
      },
      async (a) => {
        try {
          // spec 351 — probes are first-class callers (dueto F11): the resolved caller wins here too.
          const callerActor = resolveDeclaredActor(deps, a.caller);
          if (!callerActor.ok) return fail(new Error(callerActor.message));
          const { runId, done } = await probe.launch({
            runtime: a.runtime,
            archetype: a.archetype,
            brief: { task: a.task, context: a.context, constraints: a.constraints },
            model: a.model,
            cwd: deps.probeCwd?.() ?? process.cwd(),
            timeoutMs: a.timeoutSec ? a.timeoutSec * 1000 : undefined,
            budgetUsd: a.budgetUsd,
            write: a.write,
            caller: callerActor.name,
          });
          if (a.wait === "async") return ok(JSON.stringify(runningEnvelope(runId), null, 2));
          let timer: NodeJS.Timeout | undefined;
          const capped = new Promise<null>((res) => (timer = setTimeout(() => res(null), SYNC_CAP_MS)));
          const raced = await Promise.race([done, capped]);
          if (timer) clearTimeout(timer);
          return ok(JSON.stringify(raced ? trim(raced) : runningEnvelope(runId), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "read_probe_result",
      {
        description:
          "Read a probe's captured result by runId — the async/poll companion to probe_agent. Returns " +
          "{runId,status,result?}; status:running means it hasn't finished — poll again.",
        inputSchema: { runId: z.string().min(1) },
      },
      async ({ runId }) => {
        try {
          const env = await probe.read(runId);
          if (env) return ok(JSON.stringify(trim(env), null, 2));
          // Not stored: only call it "running" if it's genuinely in-flight — a bogus/typo runId is a
          // not-found error, never an eternal "running" lie (codex review #2).
          if (probe.hasInFlight(runId)) return ok(JSON.stringify(runningEnvelope(runId), null, 2));
          return fail(new Error(`no probe with runId '${runId}' (not in-flight, not stored)`));
        } catch (err) {
          return fail(err);
        }
      },
    );
  }
}
