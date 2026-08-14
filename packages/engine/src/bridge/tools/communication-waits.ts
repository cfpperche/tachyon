import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { waitForOutput, inWaitOutputScope, WAIT_OUTPUT_DEFAULT_TIMEOUT_SEC, WAIT_OUTPUT_MAX_TIMEOUT_SEC, WAIT_OUTPUT_MAX_PATTERN_LENGTH, waitOutputConcurrencyRefusalMessage } from "../waitForOutput.js";
import { redactSecrets } from "../redact.js";
import { executeWait } from "../../workspace/Waiters.js";
import { type BridgeDeps, AGENT_NAME, fail, ok, postmortemTailFor, resolveDeclaredActor, waitOutputGateFor } from "./shared.js";

export function registerWaitTools(mcp: McpServer, deps: BridgeDeps): void {



  mcp.registerTool(
    "wait_for_agent",
    {
      description:
        "Block until another agent reaches a state — the efficient way to wait for a sub-agent " +
        "you spawned: spawn_agent -> wait_for_agent(until=idle) -> read_output -> kill_agent. " +
        "NOTE: this holds YOUR turn; if you have other work (or the human needs you responsive), " +
        "prefer non-blocking delegation: instruct the child to notify when done. " +
        "idle = stopped producing output (likely finished); needs-input = waiting for a prompt; " +
        "dead = process ended; change = WATCH mode, wait for the target's next attention/death transition. " +
        "Returns {met, state, exitCode?, waitedMs}; on met=false (timeout) " +
        "the current state is returned — just call again to keep waiting.",
      inputSchema: {
        name: AGENT_NAME,
        until: z.enum(["idle", "needs-input", "dead", "change"]).describe("state to wait for; change watches for the next transition"),
        timeoutSec: z
          .number()
          .int()
          .min(1)
          .max(240)
          .default(45)
          .describe("max seconds to hold this call (your MCP client may impose its own limit)"),
        tailLines: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("when waiting for dead, include up to this many final postmortem lines; server also clamps by bytes"),
      },
    },
    async ({ name, until, timeoutSec, tailLines }) => {
      try {
        const result: Record<string, unknown> = await executeWait(deps, name, until, timeoutSec);
        if (tailLines !== undefined && result.met === true && result.state === "dead") {
          const retained = await postmortemTailFor(deps, name, tailLines);
          if (retained) {
            result.tail = retained.text;
            result.tailTruncated = retained.truncated;
            result.tailMaxLines = retained.maxLines;
            result.tailMaxBytes = retained.maxBytes;
            result.tailSource = retained.source;
          } else {
            result.tailUnavailableReason = "no retained postmortem output is available";
          }
        }
        return ok(JSON.stringify(result));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "wait_for_output",
    {
      description:
        "Block until NEW output in another agent's pane matches — the content-match analogue of " +
        "wait_for_agent (herdr's `wait output --match`, governed): a coordinator waiting for a specific " +
        "completion marker, or a fixer round waiting for a sibling's test-summary line, without burning " +
        "turns on read_output poll loops. Matching is LITERAL SUBSTRING only (no regex — a caller-supplied " +
        "regex engine on the extension host's single event loop is a ReDoS/hang risk, so it isn't offered " +
        "here), optionally case-insensitive. Matches against UNWRAPPED text (capture-pane -J semantics) " +
        "captured strictly AFTER this call started — pane width/soft-wrap can't break a match, and " +
        "content already on screen before the call does NOT match (use read_output for that). Returns " +
        "{met, excerpt, waitedMs} on a hit — excerpt is the matching line plus a few lines of context, " +
        "never the whole screen, with any known Bridge secrets redacted; on met=false (timeout) returns " +
        "{met, state, tail, waitedMs} with a bounded, redacted current tail, the same contract shape as " +
        "wait_for_agent. GOVERNANCE (herdr has none): you may wait only on yourself, an agent you spawned, " +
        "or a sibling sharing your own parent — an out-of-scope target is refused with a structured error, " +
        "never a hang.",
      inputSchema: z
        .object({
          name: AGENT_NAME.describe("the agent whose pane to watch"),
          match: z.string().min(1).max(WAIT_OUTPUT_MAX_PATTERN_LENGTH).describe("literal substring to match against NEW pane output"),
          caseInsensitive: z.boolean().optional().describe("match without regard to case (plain lowercasing, not a regex flag)"),
          timeoutSec: z
            .number()
            .int()
            .min(1)
            .max(WAIT_OUTPUT_MAX_TIMEOUT_SEC)
            .default(WAIT_OUTPUT_DEFAULT_TIMEOUT_SEC)
            .describe("max seconds to hold this call (your MCP client may impose its own limit)"),
          agent: AGENT_NAME.describe(
            "YOUR agent name — resolved against the Bridge-authenticated caller, not trusted verbatim. " +
              "It's the value of your $TACHYON_AGENT_NAME env var; never guess it.",
          ),
        })
        .strict(),
    },
    async ({ name, match, caseInsensitive, timeoutSec, agent }) => {
      try {
        const callerActor = resolveDeclaredActor(deps, agent);
        if (!callerActor.ok) return fail(new Error(callerActor.message));
        const callerName = callerActor.name ?? agent;
        if (!inWaitOutputScope(callerName, name, deps.manager)) {
          return fail(
            new Error(
              `wait_for_output refused: caller '${callerName}' may wait only on itself, an agent it spawned, or a sibling sharing its own parent ` +
                `(policy: lineage-scoped, t-fe5dbe) — '${name}' is out of scope`,
            ),
          );
        }
        const gate = waitOutputGateFor(deps.manager);
        if (!gate.tryAcquire()) return fail(new Error(waitOutputConcurrencyRefusalMessage(gate.capacity)));
        try {
          const session = deps.manager.session(name);
          if (!(await deps.tmux.hasSession(session))) return fail(new Error(`agent '${name}' is not running`));
          const result = await waitForOutput(deps.tmux, session, { match, caseInsensitive, timeoutSec });
          const redacted =
            result.met ? { ...result, excerpt: redactSecrets(result.excerpt, deps.knownSecrets?.()) } : { ...result, tail: redactSecrets(result.tail, deps.knownSecrets?.()) };
          return ok(JSON.stringify(redacted));
        } finally {
          // Runs on every exit — normal return, timeout, AND a thrown error (tmux failure mid-poll) —
          // so the slot can never leak (t-384a3f case d).
          gate.release();
        }
      } catch (err) {
        return fail(err);
      }
    },
  );
}
