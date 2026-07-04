import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentManager } from "../agents/AgentManager.js";
import type { TmuxService } from "../tmux/TmuxService.js";
import type { PinStore, TiptapJSON } from "../pins/PinStore.js";
import { taskSummary, type TaskStore } from "../tasks/TaskStore.js";
import type { ContinuityStore } from "../continuity/ContinuityStore.js";
import type { ProjectHandoffStore } from "../handoff/ProjectHandoffStore.js";
import { validationSummary, type ValidationStore } from "../validations/ValidationStore.js";
import { nextValidation } from "../validations/nextValidation.js";
import { discoverValidationCandidates } from "../validations/discovery.js";
import type { Waiters, WaitCondition } from "./Waiters.js";
import type { CommandRunner } from "../commands/CommandRunner.js";
import type { RunbookRunner } from "../commands/RunbookRunner.js";
import type { Scheduler } from "../schedule/Scheduler.js";
import type { ProposalStore } from "../schedule/ProposalStore.js";
import { parseEvery, parseAt, inferKind, type ScheduleDef } from "../config/loadConfig.js";
import type { Severity, EvidenceSummary, EvidenceView } from "../worktree/evidence.js";
import { validateSpawnContract, composeSpawnContractBrief, notifyParentGuidance, normalizeField, type SpawnContract } from "./spawnContract.js";
import type { ProbeService } from "../probe/ProbeService.js";
import { runningEnvelope, type ProbeEnvelope } from "../probe/taxonomy.js";
import { composeAgentNotice, prepareAgentSummary } from "./notifyAgent.js";

export type NotifyLevel = "info" | "warn" | "error";
export type NoticeDeliveryResult = { status: "notified" | "queued"; dropped?: number; queued?: number };

export interface BridgeDeps {
  /** Workspace root used by best-effort local discovery tools. */
  workspaceRoot: string;
  manager: AgentManager;
  tmux: TmuxService;
  /** Shared human↔agent project checklist (.tachyon/pins.json). */
  pins: PinStore;
  /** spec 325 — project work queue entity (.tachyon/tasks/*.json). */
  tasks: TaskStore;
  /** spec 344 — project validation queue entity (.tachyon/validations/*.json), independent from SDD. */
  validations: ValidationStore;
  /** spec 241 — per-agent continuity briefs (.tachyon/continuity/<agent>.md). Enables get/set/status_continuity. */
  continuity?: ContinuityStore;
  /** spec 241 — current activity seq for an agent (the freshness anchor); undefined when unknown. */
  currentActivitySeq?: (agent: string) => number | undefined;
  /** spec 241 — fired after a continuity mutation — wired to the sidebar badge refresh. */
  onContinuityChanged?: (agent: string) => void;
  /** spec 245 — the shared per-project handoff (.tachyon/HANDOFF.md + handoff-notes.jsonl). Enables the 3 handoff tools. */
  handoff?: ProjectHandoffStore;
  /** spec 245 — last project activity timestamp (ISO) for handoff staleness; null/undefined when unknown. */
  lastActivityAt?: () => string | null;
  /** spec 245 — fired after a handoff mutation — wired to the sidebar panel refresh. `agent` is set when an agent
   *  APPENDED a note (inc F: the host anchors the append-nudge to that agent's activity seq); absent on an owner rewrite. */
  onHandoffChanged?: (agent?: string) => void;
  /** Surfaces a message to the human — wired to vscode.window.show*Message in the extension. */
  notify: (message: string, level: NotifyLevel) => void;
  /** spec 257 — the captured headless A2A probe lane. Enables probe_agent + read_probe_result. */
  probe?: ProbeService;
  /** spec 257 — the cwd probes run in (the workspace root); falls back to process.cwd(). */
  probeCwd?: () => string;
  /** spec 257 — how long a sync probe_agent call holds before handing back a runId (default 120_000). */
  probeSyncCapMs?: number;
  /** Attention state of an agent ("working" | "idle" | "needs-input"), when monitoring is active. */
  attentionOf?: (agent: string) => string | undefined;
  /** spec 341 — semantic agent notice delivery; queues unsafe recipients instead of raw pane submit. */
  deliverNotice?: (target: string, line: string) => Promise<NoticeDeliveryResult>;
  /** Fired after any pin mutation — wired to the sidebar refresh. */
  onPinsChanged?: () => void;
  /** Fired after any task mutation — wired to the future Mission Control/task view refresh. */
  onTasksChanged?: () => void;
  /** Fired after any validation mutation — wired to Mission Control refresh. */
  onValidationsChanged?: () => void;
  /** Event-driven waiter registry — enables wait_for_agent (absent = tool returns an error). */
  waiters?: Waiters;
  /** One-shot command runner — enables run_command/list_commands. */
  commands?: CommandRunner;
  /** Step-by-step runbook runner — enables run_runbook. */
  runbooks?: RunbookRunner;
  /** Schedule engine — enables list_schedules (active timers). */
  scheduler?: Scheduler;
  /** Pending agent-proposed schedules — enables propose_schedule. */
  proposals?: ProposalStore;
  /** Fired after a proposal is created — wired to the sidebar refresh + a human toast. */
  onScheduleProposed?: (name: string, by: string) => void;
  /** spec 214 — verify-gate handoff: the recorded result + freshly-computed staleness for an agent (undefined → no verify/worktree). Enables verify state in list_agents. */
  verifyInfo?: (agent: string) => Promise<VerifyHandoff | undefined>;
  /** spec 214 — run an agent's declared verify-gate in its worktree, returning the result. Enables verify_agent. */
  runVerify?: (agent: string) => Promise<VerifyHandoff>;
  /** spec 273 — attach one non-binary evidence record to a worktree agent. Enables attach_evidence. */
  attachEvidence?: (input: AttachEvidenceInput) => Promise<{ ok: boolean; id?: string; reason?: string }>;
  /** spec 273 — read a worktree agent's evidence records (fresh + stale-flagged). Enables list_evidence. */
  listEvidence?: (agent: string) => Promise<EvidenceView[]>;
  /** spec 216 — re-anchor an agent to its role (rewrite its role doc + type a reminder). Enables reanchor_agent. */
  reanchor?: (agent: string) => Promise<void>;
  /** spec 230 — validate + apply a pipeline node's complete_node signal (per-node nonce auth, codex M1). */
  completeNode?: (input: { runId: string; nodeId: string; nonce: string; summary?: string }) => Promise<{ ok: boolean; reason?: string }>;
}

/** The verify-gate view exposed over MCP — the validated-handoff payload a parent gates on. */
export interface VerifyHandoff {
  /** the verify command/runbook name (or inline) that applies */
  command: string;
  /** last run passed (exit 0); undefined when never run */
  passed?: boolean;
  /** the worktree HEAD the verdict was recorded against; undefined when never run */
  atCommit?: string;
  /** ISO timestamp of the last run; undefined when never run */
  ranAt?: string;
  /** the recorded verdict no longer reflects the worktree (HEAD moved or dirty) — re-verify */
  stale: boolean;
  /** spec 273 — a compact, mechanical summary of the worktree's NON-BINARY evidence (additive; never gates) */
  evidence?: EvidenceSummary;
}

/** spec 273 — the input to attach_evidence (producer is self-declared, per the bridge's caller model). */
export interface AttachEvidenceInput {
  targetAgent: string;
  producer: string;
  kind: string;
  severity: Severity;
  summary: string;
  detail?: string;
  data?: Record<string, unknown>;
  artifacts?: string[];
  onBehalfOf?: string;
  sourceRunId?: string;
}

/** Validates a proposed schedule (same rules as config) before storing it. */
export function validateProposedSchedule(s: ScheduleDef): string | null {
  const hasEvery = s.every !== undefined;
  const hasAt = s.at !== undefined;
  if (hasEvery === hasAt) return "exactly one of 'every' or 'at' is required";
  if (hasEvery && parseEvery(s.every as string) === null) return "every must be like '30m', '1h', '2h'";
  if (hasAt && parseAt(s.at as string) === null) return "at must be 'HH:MM' (24h)";
  const hasRun = s.run !== undefined;
  const hasSpawn = s.spawn !== undefined;
  if (hasRun === hasSpawn) return "exactly one of 'run' or 'spawn' is required";
  return null;
}

/** Waiter key namespace for command completions (no clash with agent names). */
export const CMD_WAIT_PREFIX = "cmd:";

/** Shared by the MCP tool and the extension's internal command — one wait semantics. */
export async function executeWait(
  deps: Pick<BridgeDeps, "manager" | "attentionOf" | "waiters">,
  name: string,
  until: WaitCondition,
  timeoutSec: number,
): Promise<{ met: boolean; state: string; exitCode?: number; waitedMs: number }> {
  const states = await deps.manager.agentStates();
  const current = states.get(name);
  if (!current) return { met: until === "dead", state: "gone", waitedMs: 0 };
  if (current.dead) return { met: until === "dead", state: "dead", exitCode: current.exitCode, waitedMs: 0 };
  const attention = deps.attentionOf?.(name);
  if (attention === until) return { met: true, state: attention, waitedMs: 0 };
  if (!deps.waiters) throw new Error("waiting is not available on this Bridge");
  const result = await deps.waiters.wait(name, until, timeoutSec * 1000);
  if (result.state === "timeout") {
    // report the live state at timeout so the caller can decide (and call again)
    return { ...result, state: deps.attentionOf?.(name) ?? "working" };
  }
  return result;
}

const AGENT_NAME = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "agent name must start with a letter and use [a-zA-Z0-9_-]");
const TASK_ID = z.string().regex(/^t-[0-9a-f]{6}$/, "task id must be t-<6hex>");
const TASK_STATUS = z.enum(["inbox", "triaged", "active", "done", "dropped"]);
const TASK_PRIORITY = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const TASK_ARTIFACT_REF = z.object({
  type: z.string().min(1).max(64),
  ref: z.string().min(1).max(500),
});
const TASK_EXPECT = z.object({
  assignee: z.string().min(1).max(64).nullable().optional(),
  status: TASK_STATUS.optional(),
  updatedAt: z.string().min(1).optional(),
}).optional();
const VALIDATION_ID = z.string().regex(/^v-[0-9a-f]{6}$/, "validation id must be v-<6hex>");
const VALIDATION_STATUS = z.enum(["pending", "triaged", "running", "closed"]);
const VALIDATION_EXECUTOR = z.enum(["human", "agent", "either"]);
const VALIDATION_OUTCOME = z.enum(["passed", "failed", "skipped"]);
const VALIDATION_EXPECT = z.object({
  assignee: z.string().min(1).max(64).nullable().optional(),
  status: VALIDATION_STATUS.optional(),
  updatedAt: z.string().min(1).optional(),
}).optional();

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

const MAX_PIN_TITLE_CHARS = 120;

function normalizeCreatePinInput(input: { title?: string; text?: string; detail?: string }): { title: string; detail?: string } {
  const explicitTitle = collapseWhitespace(input.title);
  const rawText = trimText(input.text);
  const rawDetail = trimText(input.detail);
  const source = rawDetail || rawText || explicitTitle;
  if (!source) throw new Error("create_pin requires title, text, or detail");

  const title = explicitTitle ? truncatePinTitle(explicitTitle) : derivePinTitle(source);
  const detail = rawDetail || (shouldKeepPinDetail(rawText, title) ? rawText : "");
  return detail && collapseWhitespace(detail) !== title ? { title, detail } : { title };
}

function derivePinTitle(text: string): string {
  const firstLine = text.split(/\r?\n/).map((line) => collapseWhitespace(line)).find(Boolean) ?? collapseWhitespace(text);
  const firstSentence = firstLine.match(/^.{20,}?[.!?](?:\s|$)/)?.[0]?.trim() ?? firstLine;
  return truncatePinTitle(firstSentence || "Untitled pin");
}

function shouldKeepPinDetail(text: string, title: string): boolean {
  if (!text) return false;
  if (collapseWhitespace(text) === title) return false;
  return text.includes("\n") || collapseWhitespace(text).length > MAX_PIN_TITLE_CHARS;
}

function truncatePinTitle(text: string): string {
  const compact = collapseWhitespace(text);
  if (compact.length <= MAX_PIN_TITLE_CHARS) return compact;
  return `${compact.slice(0, MAX_PIN_TITLE_CHARS - 3).trimEnd()}...`;
}

function trimText(value: string | undefined): string {
  return value?.trim() ?? "";
}

function collapseWhitespace(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function plainTextDoc(text: string): TiptapJSON {
  const paragraphs = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return {
    type: "doc",
    content: paragraphs.length > 0 ? paragraphs.map((block) => ({ type: "paragraph", content: inlineTextNodes(block) })) : [{ type: "paragraph" }],
  };
}

function inlineTextNodes(block: string): TiptapJSON[] {
  const lines = block.split(/\r?\n/);
  const nodes: TiptapJSON[] = [];
  lines.forEach((line, index) => {
    if (index > 0) nodes.push({ type: "hardBreak" });
    if (line) nodes.push({ type: "text", text: line });
  });
  return nodes.length > 0 ? nodes : [{ type: "text", text: "" }];
}

function definedPatch<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

async function managedEntry(deps: Pick<BridgeDeps, "manager">, name: string) {
  return (await deps.manager.list()).find((a) => a.name === name);
}

function outputCapabilities(info: Awaited<ReturnType<BridgeDeps["manager"]["list"]>>[number], deps: Pick<BridgeDeps, "manager">) {
  const retained = deps.manager.postmortemTail(info.name);
  const canReadOutput = info.running || info.dead || !!retained;
  const readOutputState = info.running ? "live" : info.dead || retained ? "postmortem" : "unavailable";
  const canDismiss = !info.declared && !info.running;
  return {
    canReadOutput,
    readOutputState,
    ...(!canReadOutput ? { readOutputReason: "no live pane or retained postmortem output is available" } : {}),
    canDismiss,
    ...(!canDismiss ? { dismissReason: info.declared ? "declared tachyon.yml agents must be deleted from config" : "agent is still running" } : {}),
  };
}

function limitText(text: string, maxLines: number, maxBytes: number, alreadyTruncated = false) {
  const originalText = text;
  const lines = text.split("\n");
  let output = lines.length > maxLines ? lines.slice(-maxLines).join("\n") : text;
  let truncated = alreadyTruncated || output !== originalText;
  if (Buffer.byteLength(output, "utf8") > maxBytes) {
    output = Buffer.from(output, "utf8").subarray(-maxBytes).toString("utf8");
    truncated = true;
  }
  return { output, truncated, maxLines, maxBytes };
}

async function postmortemTailFor(deps: Pick<BridgeDeps, "manager" | "tmux">, name: string, lines: number) {
  const retained = deps.manager.postmortemTail(name, lines);
  if (retained) return { ...retained, source: "retained" };
  const session = deps.manager.session(name);
  if (await deps.tmux.hasSession(session)) {
    try {
      const output = await deps.tmux.capturePane(session, lines);
      const limited = limitText(output, lines, AgentManager.POSTMORTEM_MAX_BYTES);
      return { text: limited.output, truncated: limited.truncated, maxLines: limited.maxLines, maxBytes: limited.maxBytes, source: "tmux" };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function deliverNoticeFallback(deps: BridgeDeps, session: string, line: string): Promise<NoticeDeliveryResult> {
  if (typeof deps.tmux.sendSubmittedLine === "function") {
    await deps.tmux.sendSubmittedLine(session, line);
  } else {
    await deps.tmux.sendKeys(session, line, true);
  }
  return { status: "notified" };
}

/**
 * t-ea86e6 — best-effort notice fired from update_task when a patch assigns a task to a live agent.
 * Same liveness gate notify_agent uses (kindOf === "agent" + hasSession); silently skips a terminal,
 * unknown, or stopped target — assignment must not depend on whether the assignee happens to be online.
 * Never throws: a delivery failure must not surface as an update_task error.
 */
async function notifyTaskAssignee(deps: BridgeDeps, assignee: string, task: { id: string; title: string }): Promise<void> {
  try {
    if (deps.manager.kindOf(assignee) !== "agent") return;
    const session = deps.manager.session(assignee);
    if (!(await deps.tmux.hasSession(session))) return;
    const line = `[tachyon] task ${task.id} assigned to you: ${task.title}`;
    if (deps.deliverNotice) {
      await deps.deliverNotice(assignee, line);
    } else {
      await deliverNoticeFallback(deps, session, line);
    }
  } catch {
    // best-effort — assigning a task must never fail because notifying the assignee did.
  }
}

/** The Bridge tools. Schema-validated MCP handlers over AgentManager and workspace services. */
export function registerTools(mcp: McpServer, deps: BridgeDeps): void {
  mcp.registerTool(
    "spawn_agent",
    {
      description:
        "Compatibility name: start a managed entry in this workspace. With only a name, spawns the entry declared in tachyon.yml; " +
        "pass cmd to spawn an ad-hoc sub-agent (e.g. a fresh AI CLI for a delegated task). " +
        "ALWAYS pass parent=<your own agent name> so the sidebar shows lineage. " +
        "DELEGATION CONTRACT (spec 246): when you spawn an ad-hoc AI agent (cmd is an AI CLI), you MUST hand it a " +
        "structured brief — task + context + constraints + (deliverable OR done_when) — or the call is rejected. " +
        "The contract is delivered to the child as its opening brief, so fill it with real substance. " +
        "Pass skip_contract_reason=<why, ≥10 chars> ONLY for a genuinely trivial spawn (recorded, surfaced to the human). " +
        "With parent set, the child's brief already teaches it to call notify_agent(to: \"<your name>\", summary: ...) when the " +
        "deliverable/done_when is met, so YOU get woken up — no need to tell it separately. " +
        "Subject to the maxAgents guardrail.",
      inputSchema: {
        name: AGENT_NAME.describe("managed entry name (becomes part of the tmux session name)"),
        cmd: z.string().min(1).optional().describe("shell command for an ad-hoc managed entry; omit to use tachyon.yml"),
        cwd: z.string().optional().describe("working directory for an ad-hoc agent"),
        instructions: z
          .string()
          .max(2000)
          .optional()
          .describe("extra free-form prose appended AFTER the delegation contract in the child's brief (optional)"),
        parent: AGENT_NAME.optional().describe("YOUR agent name — records who spawned this agent (lineage)"),
        worktree: z
          .boolean()
          .optional()
          .describe(
            "isolate this agent in its own git worktree + branch (top-level only; ignored for a sub-agent, which shares the parent's worktree). Spawn top-level to isolate.",
          ),
        // spec 246 — the delegation contract (required for an ad-hoc AI agent unless skip_contract_reason is given).
        task: z.string().optional().describe("what the child must do — one substantive directive"),
        context: z.string().optional().describe("the situation/files/background the child needs to start"),
        constraints: z.string().optional().describe("what NOT to do; scope guardrails; budgets; style"),
        deliverable: z.string().optional().describe("the concrete artifact expected (use this OR done_when)"),
        done_when: z.string().optional().describe("the verifiable done condition (use this OR deliverable)"),
        skip_contract_reason: z
          .string()
          .optional()
          .describe("bypass the contract gate for a trivial spawn — ≥10 chars explaining why; recorded + surfaced to the human"),
      },
    },
    async ({ name, cmd, cwd, instructions, parent, worktree, task, context, constraints, deliverable, done_when, skip_contract_reason }) => {
      try {
        // spec 246 — the contract gate fires only for an ad-hoc AI-agent spawn (the genuine "delegate a fresh
        // task to a new CLI" case). A declared agent (no cmd, carries config intent) and a terminal child
        // (can't act on a handoff — D7) are not gated. Enforced HERE at the agent-facing Bridge surface so it
        // is runtime-neutral (claude/codex/gemini/opencode alike) and never re-fires on restart/resume/fork.
        const isAdhocAiAgent = !!cmd && inferKind(cmd) === "agent";
        let brief = instructions;
        let contract: SpawnContract | undefined;
        if (isAdhocAiAgent) {
          if (skip_contract_reason !== undefined) {
            if (normalizeField(skip_contract_reason).length < 10) {
              return fail(new Error("skip_contract_reason must be ≥10 chars explaining why this delegation needs no contract"));
            }
            deps.notify(`agent '${parent ?? "?"}' spawned '${name}' WITHOUT a delegation contract — reason: ${normalizeField(skip_contract_reason)}`, "warn");
            // spec 332 — the skip-reason path bypasses the full contract, but a delegated child with a
            // parent still gets taught to notify_agent(<parent>) on completion (dueto: the guidance is
            // orthogonal to whether the FULL contract was given).
            if (parent) brief = brief ? `${brief}\n\n${notifyParentGuidance(parent)}` : notifyParentGuidance(parent);
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
            brief = composeSpawnContractBrief(contract, instructions, parent);
          }
        }
        // reveal:false — spawning a child must not steal the human's editor focus (F3);
        // the child shows in the tree (nested under parent), opened on demand.
        await deps.manager.spawn(name, { cmd, cwd, instructions: brief, parent, worktree, reveal: false, contract, contractSkipReason: skip_contract_reason });
        return ok(`agent '${name}' spawned (session ${deps.manager.session(name)})`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "kill_agent",
    {
      description: "Compatibility name: stop a running managed entry (kills its tmux session).",
      inputSchema: { name: AGENT_NAME },
    },
    async ({ name }) => {
      try {
        await deps.manager.kill(name);
        return ok(`agent '${name}' killed`);
      } catch (err) {
        const info = await managedEntry(deps, name);
        if (info && !info.declared && !info.running) {
          return fail(new Error(`agent '${name}' is not running; use dismiss_agent to remove the stopped ad-hoc entry`));
        }
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "dismiss_agent",
    {
      description:
        "Dismiss a stopped ad-hoc managed entry from this workspace. This removes the ephemeral row and its durable " +
        "ad-hoc footprint; it is only valid for ad-hoc entries that are no longer running. Use kill_agent first for " +
        "a running ad-hoc agent. Declared tachyon.yml agents cannot be dismissed through the Bridge.",
      inputSchema: { name: AGENT_NAME },
    },
    async ({ name }) => {
      try {
        const info = await managedEntry(deps, name);
        if (!info) return fail(new Error(`agent '${name}' not found`));
        if (info.declared) return fail(new Error(`agent '${name}' is declared in tachyon.yml and cannot be dismissed through the Bridge`));
        if (info.running) return fail(new Error(`agent '${name}' is still running; use kill_agent first, then dismiss_agent if it remains listed`));
        if (info.dead) {
          await deps.manager.kill(name);
          return ok(`agent '${name}' dismissed`);
        }
        deps.manager.dismissAdhoc(name);
        return ok(`agent '${name}' dismissed`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "restart_agent",
    {
      description: "Compatibility name: restart a managed entry (kill + spawn with the same definition).",
      inputSchema: { name: AGENT_NAME },
    },
    async ({ name }) => {
      try {
        await deps.manager.restart(name);
        return ok(`agent '${name}' restarted`);
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
        "Rows include advisory capabilities for output reading and stopped ad-hoc dismissal; action tools still re-check state.",
      inputSchema: {},
    },
    async () => {
      try {
        const agents = await deps.manager.list();
        const enriched = await Promise.all(
          agents.map(async (a) => {
            // spec 214 — surface the verify-gate state so a parent can read "child done AND green".
            const verify = deps.verifyInfo ? await deps.verifyInfo(a.name) : undefined;
            return {
              ...a,
              capabilities: outputCapabilities(a, deps),
              ...(a.running && deps.attentionOf?.(a.name) ? { attention: deps.attentionOf(a.name) } : {}),
              ...(verify ? { verify } : {}),
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
    "verify_agent",
    {
      description:
        "Run a worktree agent's declared verify-gate (verify: in tachyon.yml) IN its worktree and " +
        "return {command, passed, atCommit, ranAt, stale}. The validated-handoff primitive: call this " +
        "BEFORE you accept a delegated child's handoff (not only at merge) and gate on 'passed' — a child " +
        "going idle or saying it's done is NOT evidence its gate is green; run this to get the evidence. " +
        "Advisory — it never merges, PRs, or blocks; it returns evidence. Errors if the agent has no " +
        "worktree or no verify declared.",
      inputSchema: { name: AGENT_NAME.describe("the worktree agent to verify") },
    },
    async ({ name }) => {
      try {
        if (!deps.runVerify) return fail(new Error("verify is not available on this Bridge"));
        return ok(JSON.stringify(await deps.runVerify(name)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "attach_evidence",
    {
      description:
        "Attach ONE non-binary EVIDENCE record to a worktree agent (spec 273) — the home for things the binary " +
        "verify gate can't hold: an advisory, a review judgment, a Visual-QA verdict + screenshot refs, a note. " +
        "Evidence INFORMS a parent reading the handoff; it NEVER gates/blocks (the verify badge stays the gate). " +
        "Provide targetAgent, kind (free label e.g. 'judgment'|'advisory'), severity (info|warn|error), a one-line " +
        "summary, and optionally detail, data (structured), artifacts (worktree-relative refs), producer (your " +
        "agent name — provenance, not authentication). Tachyon stamps id/time/commit. Errors if the target has no " +
        "worktree or an artifact ref escapes the worktree.",
      inputSchema: {
        targetAgent: AGENT_NAME.describe("the worktree agent the evidence is about"),
        kind: z.string().min(1).describe("neutral label, e.g. 'judgment' | 'advisory' | 'artifact'"),
        severity: z.enum(["info", "warn", "error"]).describe("advisory severity — never gates"),
        summary: z.string().min(1).describe("one-line, human/agent-readable"),
        detail: z.string().optional().describe("optional durable text/log"),
        data: z.record(z.unknown()).optional().describe("optional structured payload"),
        artifacts: z.array(z.string()).optional().describe("worktree-relative refs (e.g. screenshots); no traversal"),
        producer: z.string().optional().describe("your agent name (provenance, not authentication)"),
        onBehalfOf: z.string().optional(),
        sourceRunId: z.string().optional(),
      },
    },
    async ({ targetAgent, kind, severity, summary, detail, data, artifacts, producer, onBehalfOf, sourceRunId }) => {
      try {
        if (!deps.attachEvidence) return fail(new Error("evidence is not available on this Bridge"));
        const r = await deps.attachEvidence({
          targetAgent,
          producer: producer ?? "unknown",
          kind,
          severity: severity as Severity,
          summary,
          detail,
          data,
          artifacts,
          onBehalfOf,
          sourceRunId,
        });
        return r.ok ? ok(`evidence attached to '${targetAgent}' (id ${r.id})`) : fail(new Error(r.reason ?? "rejected"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_evidence",
    {
      description:
        "Read a worktree agent's non-binary EVIDENCE records (spec 273), newest-first, each flagged fresh/stale " +
        "(stale = the worktree HEAD moved past the commit it was produced against). Use it to read advisories, " +
        "per-step verify details, and review judgments a child produced — context the binary verify gate omits.",
      inputSchema: { name: AGENT_NAME.describe("the worktree agent whose evidence to read") },
    },
    async ({ name }) => {
      try {
        if (!deps.listEvidence) return fail(new Error("evidence is not available on this Bridge"));
        return ok(JSON.stringify(await deps.listEvidence(name)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "complete_node",
    {
      description:
        "Signal that THIS pipeline node's task is finished (spec 230). Pass runId, nodeId, and nonce " +
        "from your environment (TACHYON_RUN_ID / TACHYON_NODE_ID / TACHYON_NODE_NONCE). The node is " +
        "authenticated by its nonce, not by identity. After a valid signal Tachyon runs the node's " +
        "verify gate if its done-contract requires it. Errors on a bad token, a non-running node, a " +
        "duplicate signal, or an unknown/closed run. Optionally pass a short `summary` of what you did " +
        "and where (e.g. 'plan in docs/plan.md; chose CSS vars') — it is handed to the next node as " +
        "context.",
      inputSchema: {
        runId: z.string().describe("TACHYON_RUN_ID from your environment"),
        nodeId: z.string().describe("TACHYON_NODE_ID from your environment"),
        nonce: z.string().describe("TACHYON_NODE_NONCE from your environment"),
        summary: z
          .string()
          .optional()
          .describe("optional short handoff for the next node: what you did + where (files, decisions)"),
      },
    },
    async ({ runId, nodeId, nonce, summary }) => {
      try {
        if (!deps.completeNode) return fail(new Error("pipelines are not available on this Bridge"));
        const r = await deps.completeNode({ runId, nodeId, nonce, summary });
        return r.ok ? ok(`node '${nodeId}' completion accepted`) : fail(new Error(r.reason ?? "completion rejected"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "reanchor_agent",
    {
      description:
        "Re-anchor an agent to its role (spec 216): rewrite its durable role doc (.tachyon/roles/" +
        "<agent>.md) and type a compact reminder into its terminal. Use when a sub-agent has drifted " +
        "from its task after its CLI compacted/summarized. Types into the live pane — prefer it when " +
        "the agent is idle. The same thing happens automatically if settings.anchor.auto is on.",
      inputSchema: { name: AGENT_NAME.describe("the agent to re-anchor") },
    },
    async ({ name }) => {
      try {
        if (!deps.reanchor) return fail(new Error("re-anchoring is not available on this Bridge"));
        await deps.reanchor(name);
        return ok(`re-anchored '${name}' to its role`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "read_output",
    {
      description:
        "Read another managed entry's terminal output. Live rows return the visible pane by default " +
        "(what a human looking at that entry's terminal sees); pass lines to reach into scrollback. " +
        "Stopped rows return bounded postmortem output when Tachyon retained it; otherwise the error distinguishes stopped-without-output from unknown.",
      inputSchema: {
        name: AGENT_NAME,
        lines: z.number().int().min(1).max(10000).optional().describe("how many lines of scrollback to include"),
      },
    },
    async ({ name, lines }) => {
      try {
        const session = deps.manager.session(name);
        const info = await managedEntry(deps, name);
        if (await deps.tmux.hasSession(session)) {
          if (info?.dead) {
            const output = await deps.tmux.capturePane(session, lines ?? AgentManager.POSTMORTEM_MAX_LINES);
            const limited = limitText(output, lines ?? AgentManager.POSTMORTEM_MAX_LINES, AgentManager.POSTMORTEM_MAX_BYTES);
            return ok(JSON.stringify({ output: limited.output, postmortem: true, truncated: limited.truncated, source: "tmux", maxLines: limited.maxLines, maxBytes: limited.maxBytes }, null, 2));
          }
          const output = await deps.tmux.capturePane(session, lines);
          return ok(output);
        }
        if (!info) return fail(new Error(`agent '${name}' not found`));
        const retained = deps.manager.postmortemTail(name, lines);
        if (retained) {
          return ok(
            JSON.stringify(
              { output: retained.text, postmortem: true, truncated: retained.truncated, source: "retained", maxLines: retained.maxLines, maxBytes: retained.maxBytes },
              null,
              2,
            ),
          );
        }
        return fail(new Error(`agent '${name}' is stopped and no postmortem output is available`));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "write_input",
    {
      description:
        "Type into another managed entry's terminal. Text is sent literally. submit=true (default) routes " +
        "through the same hardened submit path notify_agent uses and is REFUSED with a structured error " +
        "(receipt: refused-busy) if the recipient is working/throttled/needs-input — write_input is a direct " +
        "command gesture, so a busy recipient is never queued silently; use notify_agent or wait for idle instead. " +
        "submit=false only types the text with no Enter — raw, unsubmitted keystrokes can land in or concatenate " +
        "with whatever the recipient's composer already holds, so the caller should know the recipient's state.",
      inputSchema: {
        name: AGENT_NAME,
        text: z.string().describe("text to type into the agent's terminal"),
        submit: z.boolean().default(true).describe("press Enter after the text"),
      },
    },
    async ({ name, text, submit }) => {
      try {
        const session = deps.manager.session(name);
        if (!(await deps.tmux.hasSession(session))) {
          return fail(new Error(`agent '${name}' is not running`));
        }
        if (!submit) {
          await deps.tmux.sendKeys(session, text, false);
          return ok(`input typed into '${name}' without submitting (receipt: typed-unsubmitted)`);
        }
        // t-12ec8a — same busy gate as notify_agent's queue check, but write_input REFUSES instead of
        // queueing: it is a direct command gesture, so silently changing when it lands would be worse
        // than today's blind paste (spec 348). Untracked (`undefined`) is treated as safe, matching
        // Workspace.deliverNotice's own idle/untracked branch.
        const state = deps.attentionOf?.(name);
        if (state === "working" || state === "throttled" || state === "needs-input") {
          return fail(new Error(`recipient '${name}' is busy (${state}) — refused-busy: use notify_agent or wait for idle`));
        }
        if (typeof deps.tmux.sendSubmittedLine === "function") {
          await deps.tmux.sendSubmittedLine(session, text);
        } else {
          await deps.tmux.sendKeys(session, text, true);
        }
        return ok(`input submitted to '${name}' (receipt: submitted)`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "notify_agent",
    {
      description:
        "Wake another agent with a one-line message — the completion signal for delegation " +
        '(call notify_agent(to: "<parent>", summary: ...) when a delegated task is done — the spawn brief ' +
        "already teaches this to a child spawned with parent set), or any agent→agent nudge by name (parent, " +
        "sibling, anyone in the fleet). NOT a chat channel: it types ONE sanitized, single-line, provenance-" +
        "prefixed message into the recipient's terminal and submits it when the recipient appears idle — a waiting agent " +
        "only wakes on input that starts a turn. Busy recipients may be queued until idle. Targets must be running AGENTS " +
        "(not terminals) and not yourself. Best-effort pane input, not durable history, and still unsafe for a recipient " +
        "actively being typed into by a human.",
      inputSchema: {
        to: AGENT_NAME.describe("the recipient agent's name"),
        summary: z.string().min(1).max(4000).describe("one-line completion/status message — sanitized to a single printable line and capped at 500 chars"),
        agent: AGENT_NAME.describe("YOUR agent name — the Bridge-resolved sender (unspoofable provenance)"),
      },
    },
    async ({ to, summary, agent }) => {
      try {
        if (to === agent) return fail(new Error("cannot notify_agent yourself — self-notify is rejected"));
        if (deps.manager.kindOf(to) !== "agent") {
          return fail(new Error(`'${to}' is not an agent — notify_agent targets running agents only, not terminals`));
        }
        const session = deps.manager.session(to);
        if (!(await deps.tmux.hasSession(session))) {
          return fail(new Error(`agent '${to}' is not running`));
        }
        if (!prepareAgentSummary(summary)) {
          return fail(new Error("summary must not be empty after sanitizing"));
        }
        const line = composeAgentNotice(agent, to, summary);
        const result = deps.deliverNotice ? await deps.deliverNotice(to, line) : await deliverNoticeFallback(deps, session, line);
        const suffix = result.dropped ? ` (${result.dropped} older notice${result.dropped === 1 ? "" : "s"} dropped)` : "";
        return ok(result.status === "queued" ? `queued '${to}' for idle delivery${suffix}` : `notified '${to}'${suffix}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "create_pin",
    {
      description:
        "Pin a finding to the project's shared checklist (visible to the human in the sidebar and " +
        "to every agent via list_pins). Use for discoveries worth keeping: bugs found out of scope, " +
        "constraints learned the hard way, decisions other agents must know.",
      inputSchema: {
        title: z.string().min(1).max(200).optional().describe("short sidebar title; prefer this when the finding needs a longer detail body"),
        text: z.string().min(1).max(8000).optional().describe("legacy/full finding text; if long or multiline, Tachyon derives a short title and stores the full text as detail"),
        detail: z.string().min(1).max(8000).optional().describe("optional rich detail body; when set, the sidebar title stays short"),
        tags: z.array(z.string()).max(12).optional().describe("optional classification tags for filtering pins"),
        agent: AGENT_NAME.optional().describe("your agent name (authorship shown in the sidebar)"),
      },
    },
    async ({ title, text, detail, tags, agent }) => {
      try {
        const input = normalizeCreatePinInput({ title, text, detail });
        const pin = input.detail
          ? deps.pins.createRich(input.title, agent ?? "agent", { doc: plainTextDoc(input.detail), attachments: [], tags })
          : deps.pins.create(input.title, agent ?? "agent", { tags });
        deps.onPinsChanged?.();
        return ok(`pinned as ${pin.id}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_pins",
    {
      description: "Read the project's shared checklist — check it before starting work to avoid re-discovering what's already known.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(JSON.stringify(deps.pins.list(), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "get_pin",
    {
      description:
        "Read one pin's rich local detail when available. Returns summary + Tiptap JSON + attachment metadata/relative paths; never returns image bytes/base64.",
      inputSchema: {
        id: z.string().regex(/^p-[0-9a-f]{6}$/).describe("pin id from list_pins"),
      },
    },
    async ({ id }) => {
      try {
        return ok(JSON.stringify(deps.pins.readDetail(id), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "complete_pin",
    {
      description: "Mark a pin done (or reopen it with done=false).",
      inputSchema: {
        id: z.string().regex(/^p-[0-9a-f]{6}$/).describe("pin id from list_pins"),
        done: z.boolean().default(true),
      },
    },
    async ({ id, done }) => {
      try {
        const pin = deps.pins.setDone(id, done);
        deps.onPinsChanged?.();
        return ok(`pin ${pin.id} ${done ? "completed" : "reopened"}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "update_pin",
    {
      description: "Edit a pin's text and/or tags. Preserves its id, author, created time, and done state.",
      inputSchema: {
        id: z.string().regex(/^p-[0-9a-f]{6}$/).describe("pin id from list_pins"),
        text: z.string().min(1).optional().describe("the new text; omit to retag without changing title"),
        tags: z.array(z.string()).max(12).optional().describe("new complete tag list; [] clears all tags"),
      },
    },
    async ({ id, text, tags }) => {
      try {
        if (text === undefined && tags === undefined) throw new Error("update_pin requires text or tags");
        const pin = deps.pins.update(id, { ...(text !== undefined ? { text } : {}), ...(tags !== undefined ? { tags } : {}) });
        deps.onPinsChanged?.();
        return ok(`pin ${pin.id} updated`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // spec 325 — project task queue (Mission Control entity), independent from pins.
  mcp.registerTool(
    "create_task",
    {
      description:
        "Create a project Task in the shared Mission Control queue. Tasks are work items, not reminders: " +
        "new tasks land in inbox with no priority/assignee so a human or agent can triage them deliberately. " +
        "artifact_refs is optional and open-ended; type:'sdd' enables best-effort local spec enrichment only.",
      inputSchema: {
        title: z.string().min(1).max(300),
        body: z.string().max(4000).optional(),
        kind: z.string().min(1).max(64).optional(),
        artifact_refs: z.array(TASK_ARTIFACT_REF).max(10).optional(),
        deps: z.array(TASK_ID).optional(),
        agent: AGENT_NAME.optional().describe("your agent name; omitted means human-created"),
      },
    },
    async ({ title, body, kind, artifact_refs, deps: taskDeps, agent }) => {
      try {
        const task = await deps.tasks.create({ title, author: agent ?? "human", body, kind, artifact_refs, deps: taskDeps });
        deps.onTasksChanged?.();
        return ok(JSON.stringify(task, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "get_task",
    {
      description: "Read one full Task plus derived attention metadata. The persisted task JSON never stores derived metadata.",
      inputSchema: { id: TASK_ID.describe("task id from list_tasks or next_task") },
    },
    async ({ id }) => {
      try {
        return ok(JSON.stringify(deps.tasks.getView(id), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "update_task",
    {
      description:
        "Patch a Task. Use expect:{assignee:null} when claiming a task returned by next_task; " +
        "precondition failures are structured errors and mean you must re-query.",
      inputSchema: {
        id: TASK_ID,
        title: z.string().min(1).max(300).optional(),
        body: z.string().max(4000).nullable().optional(),
        status: TASK_STATUS.optional(),
        priority: TASK_PRIORITY.nullable().optional(),
        rank: z.string().min(1).max(64).nullable().optional(),
        kind: z.string().min(1).max(64).nullable().optional(),
        assignee: z.string().min(1).max(64).nullable().optional(),
        artifact_refs: z.array(TASK_ARTIFACT_REF).max(10).nullable().optional(),
        deps: z.array(TASK_ID).nullable().optional(),
        expect: TASK_EXPECT,
      },
    },
    async ({ id, title, body, status, priority, rank, kind, assignee, artifact_refs, deps: taskDeps, expect }) => {
      try {
        const patch = definedPatch({ title, body, status, priority, rank, kind, assignee, artifact_refs, deps: taskDeps, expect });
        const changedFields = Object.keys(patch).filter((key) => key !== "expect");
        if (changedFields.length === 0) {
          throw new Error("update_task requires at least one field");
        }
        // t-ea86e6 — capture the PRIOR assignee before the mutation so a no-op re-assign doesn't re-notify.
        const priorAssignee = "assignee" in patch ? deps.tasks.get(id).assignee : undefined;
        const task = await deps.tasks.update(id, patch);
        deps.onTasksChanged?.();
        if (assignee && assignee !== priorAssignee) {
          await notifyTaskAssignee(deps, assignee, task);
        }
        return ok(JSON.stringify(task, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_tasks",
    {
      description: "List bounded Task summaries for Mission Control. Omits body by default; use get_task for one full task.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ limit }) => {
      try {
        return ok(JSON.stringify(deps.tasks.listViews(limit).map(taskSummary), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "next_task",
    {
      description:
        "Return the single best Task for an assignee to work next. Advisory only: claim unassigned work with " +
        "update_task(id, assignee:<you>, expect:{assignee:null}) before editing.",
      inputSchema: {
        agent: z.string().min(1).max(64).describe("assignee asking for work; use 'human' for the human queue"),
      },
    },
    async ({ agent }) => {
      try {
        return ok(JSON.stringify(deps.tasks.next(agent), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // spec 344 — validation queue: verification/dogfood/manual checks are separate from Tasks and SDD.
  mcp.registerTool(
    "create_validation",
    {
      description:
        "Create a project Validation in the shared validation queue. Validations are checks that still need proof " +
        "(dogfood, manual QA, review, external verification). The `type` field is open text, so projects can use " +
        "their own vocabulary; `executor` is closed so Tachyon can route human-only vs agent-capable work.",
      inputSchema: {
        title: z.string().min(1).max(300),
        type: z.string().min(1).max(64).optional(),
        executor: VALIDATION_EXECUTOR.default("either"),
        priority: TASK_PRIORITY.optional(),
        assignee: z.string().min(1).max(64).optional(),
        instructions: z.string().max(4000).optional(),
        source_refs: z.array(TASK_ARTIFACT_REF).max(10).optional(),
        agent: AGENT_NAME.optional().describe("your agent name; omitted means human-created"),
      },
    },
    async ({ title, type, executor, priority, assignee, instructions, source_refs, agent }) => {
      try {
        const validation = await deps.validations.create({ title, author: agent ?? "human", type, executor, priority, assignee, instructions, source_refs });
        deps.onValidationsChanged?.();
        return ok(JSON.stringify(validation, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "get_validation",
    {
      description: "Read one full Validation, including all completed rounds and their proof notes/evidence refs.",
      inputSchema: { id: VALIDATION_ID.describe("validation id from list_validations or next_validation") },
    },
    async ({ id }) => {
      try {
        return ok(JSON.stringify(deps.validations.get(id), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "update_validation",
    {
      description:
        "Patch a Validation. Use expect:{assignee:null} when claiming an unassigned validation returned by " +
        "next_validation; precondition failures are structured errors and mean you must re-query.",
      inputSchema: {
        id: VALIDATION_ID,
        title: z.string().min(1).max(300).optional(),
        type: z.string().min(1).max(64).nullable().optional(),
        status: VALIDATION_STATUS.optional(),
        executor: VALIDATION_EXECUTOR.optional(),
        priority: TASK_PRIORITY.nullable().optional(),
        assignee: z.string().min(1).max(64).nullable().optional(),
        instructions: z.string().max(4000).nullable().optional(),
        source_refs: z.array(TASK_ARTIFACT_REF).max(10).nullable().optional(),
        expect: VALIDATION_EXPECT,
      },
    },
    async ({ id, title, type, status, executor, priority, assignee, instructions, source_refs, expect }) => {
      try {
        const patch = definedPatch({ title, type, status, executor, priority, assignee, instructions, source_refs, expect });
        const changedFields = Object.keys(patch).filter((key) => key !== "expect");
        if (changedFields.length === 0) {
          throw new Error("update_validation requires at least one field");
        }
        const validation = await deps.validations.update(id, patch);
        deps.onValidationsChanged?.();
        return ok(JSON.stringify(validation, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_validations",
    {
      description: "List bounded Validation summaries for Mission Control. Omits instructions; use get_validation for full detail.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ limit }) => {
      try {
        return ok(JSON.stringify(deps.validations.list(limit).map(validationSummary), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "next_validation",
    {
      description:
        "Return the single best Validation for an assignee to run next. Advisory only: claim unassigned work with " +
        "update_validation(id, assignee:<you>, expect:{assignee:null}) before doing the check. Human-only validations are never handed to agents.",
      inputSchema: {
        agent: z.string().min(1).max(64).describe("assignee asking for validation work; use 'human' for the human queue"),
      },
    },
    async ({ agent }) => {
      try {
        return ok(JSON.stringify(nextValidation({ validations: deps.validations.list(500), agent }), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "close_validation",
    {
      description:
        "Close the current Validation round with an outcome. Must include result_note or evidence_refs; Tachyon " +
        "stores failed/skipped rounds so a later rerun can add a new round instead of erasing history.",
      inputSchema: {
        id: VALIDATION_ID,
        outcome: VALIDATION_OUTCOME,
        result_note: z.string().min(1).max(4000).optional(),
        evidence_refs: z.array(TASK_ARTIFACT_REF).max(10).optional(),
        assignee: z.string().min(1).max(64).optional(),
        expect: VALIDATION_EXPECT,
      },
    },
    async ({ id, outcome, result_note, evidence_refs, assignee, expect }) => {
      try {
        const validation = await deps.validations.closeRound(id, { outcome, result_note, evidence_refs, assignee, expect });
        deps.onValidationsChanged?.();
        return ok(JSON.stringify(validation, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "discover_validation_candidates",
    {
      description:
        "Discover likely validation debt from existing local specs, tasks, and pins without creating records. " +
        "This is a review/import aid for existing dogfoods; it is best-effort and SDD-independent.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ limit }) => {
      try {
        return ok(JSON.stringify(discoverValidationCandidates(deps.workspaceRoot, limit), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // spec 241 — per-agent continuity: YOUR private working memory, re-injected when you cross a discontinuity
  // (compaction / clear / new session / restart). Distinct from pins (shared) and the role doc (contract).
  mcp.registerTool(
    "get_continuity",
    {
      description:
        "Read YOUR continuity brief (.tachyon/continuity/<agent>.md) — your saved working state " +
        "(current goal, decisions, next steps, open threads). Call this after a compaction / new session / " +
        "restart to rebuild what you were doing. Returns '(no continuity brief yet)' on a cold start.",
      inputSchema: { agent: AGENT_NAME.describe("your agent name") },
    },
    async ({ agent }) => {
      try {
        if (!deps.continuity) return fail(new Error("continuity is not available"));
        const brief = deps.continuity.read(agent);
        if (!brief) return ok("(no continuity brief yet — create one with set_continuity once your goal/state are clear)");
        return ok(`---\n${JSON.stringify(brief.meta)}\n---\n${brief.body}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "set_continuity",
    {
      description:
        "Checkpoint YOUR working state into your continuity brief (.tachyon/continuity/<agent>.md). REPLACES " +
        "the whole brief — keep it SHORT and current. Use these markdown sections: '# Current Goal' (your " +
        "current execution objective, not your task contract), '# Working State', '# Decisions', '# Next Steps', " +
        "'# Open Threads', '# Files / Artifacts In Play'. Tachyon stamps the metadata. Update it before a likely " +
        "compaction and whenever your plan changes — a stale brief misleads your future self.",
      inputSchema: {
        agent: AGENT_NAME.describe("your EXACT Tachyon agent name (as shown in Tachyon's nudge / the sidebar) — do NOT guess; a wrong name writes the brief to the wrong file"),
        content: z.string().max(20000).describe("the full brief body (markdown sections above)"),
        status: z.enum(["active", "paused", "blocked", "done"]).optional().describe("active (default) | paused | blocked | done"),
        source_activity_seq: z.number().int().nonnegative().optional().describe("usually omit — Tachyon anchors freshness to the current activity seq"),
      },
    },
    async ({ agent, content, status, source_activity_seq }) => {
      try {
        if (!deps.continuity) return fail(new Error("continuity is not available"));
        const res = deps.continuity.write(agent, content, {
          updatedBy: "agent",
          status,
          sourceActivitySeq: source_activity_seq ?? deps.currentActivitySeq?.(agent),
        });
        deps.onContinuityChanged?.(agent);
        return ok(res.warning ? `continuity updated — ${res.warning}` : "continuity updated");
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "continuity_status",
    {
      description:
        "Report the freshness of an agent's continuity brief: whether it exists, its status, when it was last " +
        "updated, and how far behind current activity it is (lag). Use to decide whether to re-read or refresh it.",
      inputSchema: { agent: AGENT_NAME.describe("the agent name") },
    },
    async ({ agent }) => {
      try {
        if (!deps.continuity) return fail(new Error("continuity is not available"));
        const brief = deps.continuity.read(agent);
        if (!brief) return ok(JSON.stringify({ agent, exists: false }));
        const cur = deps.currentActivitySeq?.(agent);
        const seq = typeof brief.meta.source_activity_seq === "number" ? brief.meta.source_activity_seq : undefined;
        const lag = cur !== undefined && seq !== undefined ? Math.max(0, cur - seq) : undefined;
        return ok(
          JSON.stringify({
            agent,
            exists: true,
            status: brief.meta.status,
            updated_at: brief.meta.updated_at,
            updated_by: brief.meta.updated_by,
            source_activity_seq: seq,
            current_activity_seq: cur,
            lag,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "get_project_handoff",
    {
      description:
        "Read the SHARED project handoff (.tachyon/HANDOFF.md) — the curated, project-level state of the WORK " +
        "(current state / active work / next actions / decisions & gotchas), shared by everyone in this workspace. " +
        "This is NOT your per-agent continuity (that is get_continuity). Read it when resuming to learn where the " +
        "project stands. Returns the canonical body + its `revision` (CAS token) + a staleness state + the PENDING " +
        "NOTES (undistilled) + `pending_through` (the distill watermark to echo). To DISTILL: fold `pending` into a " +
        "rewritten body, get the human's OK, then call set_project_handoff(content, expected_revision=revision, " +
        "distilled_through=pending_through). Passing `distilled_through` is what CLEARS the folded notes; a note " +
        "appended after your read stays pending for the next distill (never dropped).",
      inputSchema: { agent: AGENT_NAME.optional().describe("your agent name (optional, for context)") },
    },
    async () => {
      try {
        if (!deps.handoff) return fail(new Error("project handoff is not available"));
        const snap = deps.handoff.snapshot(deps.lastActivityAt?.() ?? null);
        return ok(
          JSON.stringify({
            exists: snap.exists,
            revision: snap.revision,
            pending_notes: snap.pendingCount,
            staleness: snap.staleness,
            body: snap.exists ? snap.body : "(no project handoff yet — append notes, or set_project_handoff to create it)",
            // inc G — the pending note ROWS, so an agent can DISTILL them into the canonical (human curates, agent writes).
            pending: snap.pending.map((n) => ({ ts: n.ts, agent: n.agent, kind: n.kind, summary: n.summary, evidence: n.evidence })),
            // the distill watermark to echo back to set_project_handoff(distilled_through=...): clears exactly the
            // notes you saw here; anything appended after stays pending (codex BLOCK — no concurrent-append loss).
            pending_through: snap.pending.length ? snap.pending[snap.pending.length - 1].ts : "",
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "append_project_handoff_note",
    {
      description:
        "Append ONE structured note to the project handoff's pending lane (.tachyon/handoff-notes.jsonl) — a " +
        "candidate change to the SHARED project state from work you just did. Every agent may append; you do NOT " +
        "rewrite the shared handoff (the human/owner distills notes into it). Use when your work changed project " +
        "state (finished a block, hit a blocker, made a decision, found a gotcha, identified a next step).",
      inputSchema: {
        agent: AGENT_NAME.describe("your EXACT Tachyon agent name"),
        kind: z.enum(["completed", "blocked", "decision", "gotcha", "next"]).describe("what kind of project-state change this note records"),
        summary: z.string().min(1).max(2000).describe("one concise sentence — what changed at the PROJECT level (not your private thread)"),
        evidence: z.array(z.string().max(400)).max(20).optional().describe("optional pointers: files, commands, node ids, commit hashes"),
      },
    },
    async ({ agent, kind, summary, evidence }) => {
      try {
        if (!deps.handoff) return fail(new Error("project handoff is not available"));
        deps.handoff.appendNote({ agent, kind, summary, evidence });
        deps.onHandoffChanged?.(agent); // inc F — anchor the append-nudge to THIS agent's current activity seq
        return ok("handoff note appended (pending distillation by the human/owner)");
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "set_project_handoff",
    {
      description:
        "REWRITE the shared project handoff (.tachyon/HANDOFF.md) in full — reserved for the human/owner (or a " +
        "designated owner agent) distilling pending notes into curated state. Default agents APPEND " +
        "(append_project_handoff_note) instead of calling this. Concurrency-safe: pass `expected_revision` from " +
        "the latest get_project_handoff; if the canonical changed meanwhile the write is REJECTED (re-read + retry). " +
        "Omit expected_revision only for the very first write. When DISTILLING, also pass `distilled_through` = the " +
        "`pending_through` from that same get — it clears exactly the notes you folded in; any note appended after " +
        "your read stays pending for the next distill (never silently dropped).",
      inputSchema: {
        agent: AGENT_NAME.optional().describe("the owner agent name (optional, for attribution)"),
        content: z.string().max(60000).describe("the full canonical handoff body (recommended sections: Current State / Active Work / Next Actions / Decisions & Gotchas)"),
        expected_revision: z.string().optional().describe("the `revision` from your latest get_project_handoff (CAS guard); omit only for the first write"),
        distilled_through: z.string().optional().describe("the `pending_through` from your latest get_project_handoff — advances the distill watermark to clear the notes you folded in. Omit for a non-distilling rewrite (watermark preserved)."),
      },
    },
    async ({ agent, content, expected_revision, distilled_through }) => {
      try {
        if (!deps.handoff) return fail(new Error("project handoff is not available"));
        const res = deps.handoff.setCanonical(content, expected_revision, agent ? "agent" : "human", distilled_through);
        if (!res.ok) {
          return fail(new Error(`rewrite rejected — the handoff changed since you read it (CAS mismatch). Re-read with get_project_handoff and reapply your edit. Current body:\n${res.current}`));
        }
        deps.onHandoffChanged?.();
        return ok(`project handoff updated (revision ${res.revision})`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "run_command",
    {
      description:
        "Run a command from the project's CURATED list (commands: in tachyon.yml) and block until it " +
        "finishes — the safe way to execute project operations (tests, lint, build) instead of typing " +
        "into a shell. Returns {passed, exitCode, durationMs, tail} with the last output lines. " +
        "On timeout the run keeps going; call again with the same name to keep waiting (a finished " +
        "run reports its result; it does NOT re-run — use rerun=true to force a fresh run).",
      inputSchema: {
        name: AGENT_NAME.describe("command name from tachyon.yml's commands: map"),
        timeoutSec: z.number().int().min(1).max(240).default(120),
        rerun: z.boolean().default(false).describe("force a fresh run even if a finished result exists"),
      },
    },
    async ({ name, timeoutSec, rerun }) => {
      try {
        if (!deps.commands) return fail(new Error("commands are not available on this Bridge"));
        const before = await deps.commands.status(name);
        if (!before.declared) return fail(new Error(`unknown command '${name}'`));
        if (before.state === "running") {
          // already in flight — just wait on it
        } else if (before.state === "idle" || rerun) {
          await deps.commands.run(name);
        } else {
          // finished result available and no rerun requested — report it
          const tail = await deps.commands.tail(name);
          return ok(JSON.stringify({ name, passed: before.state === "passed", exitCode: before.exitCode, tail, rerun: false }));
        }
        if (!deps.waiters) return fail(new Error("waiting is not available on this Bridge"));
        const result = await deps.waiters.wait(`${CMD_WAIT_PREFIX}${name}`, "dead", timeoutSec * 1000);
        if (result.state === "timeout") {
          return ok(JSON.stringify({ name, running: true, note: "still running — call again to keep waiting" }));
        }
        const tail = await deps.commands.tail(name);
        return ok(
          JSON.stringify({
            name,
            passed: result.exitCode === 0,
            exitCode: result.exitCode,
            durationMs: result.waitedMs,
            tail,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_commands",
    {
      description: "List the project's curated one-shot commands and their last results.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!deps.commands) return fail(new Error("commands are not available on this Bridge"));
        return ok(JSON.stringify(await deps.commands.list(), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "run_runbook",
    {
      description:
        "Run a step-by-step procedure from the project's runbooks: map (steps are curated commands " +
        "or inline shell, sequential, stopping at the first non-zero exit). Blocks up to timeoutSec; " +
        "if it times out the runbook KEEPS RUNNING — call again with the same name for progress or " +
        "the final result (a finished job is reported, NOT re-run; pass rerun=true for a fresh run). " +
        "Returns the job with per-step exit codes and durations.",
      inputSchema: {
        name: AGENT_NAME.describe("runbook name from tachyon.yml's runbooks: map"),
        timeoutSec: z.number().int().min(1).max(240).default(180),
        rerun: z.boolean().default(false).describe("force a fresh run even if a finished job exists"),
      },
    },
    async ({ name, timeoutSec, rerun }) => {
      try {
        if (!deps.runbooks) return fail(new Error("runbooks are not available on this Bridge"));
        let jobPromise: Promise<unknown> | undefined;
        if (!deps.runbooks.isRunning(name)) {
          const last = deps.runbooks.currentJob(name);
          if (last && !rerun) {
            // finished job available and no rerun requested — report it
            return ok(JSON.stringify(last));
          }
          jobPromise = deps.runbooks.run(name); // rejects on unknown runbook
        }
        const deadline = new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutSec * 1000));
        const settled = await Promise.race([jobPromise ?? deadline, deadline]);
        const job = deps.runbooks.currentJob(name);
        if (settled === "timeout" && deps.runbooks.isRunning(name)) {
          return ok(JSON.stringify({ name, running: true, progress: job, note: "still running — call again for the result" }));
        }
        return ok(JSON.stringify(job));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "wait_for_agent",
    {
      description:
        "Block until another agent reaches a state — the efficient way to wait for a sub-agent " +
        "you spawned: spawn_agent -> wait_for_agent(until=idle) -> read_output -> kill_agent. " +
        "NOTE: this holds YOUR turn; if you have other work (or the human needs you responsive), " +
        "prefer non-blocking delegation: instruct the child to notify when done. " +
        "idle = stopped producing output (likely finished); needs-input = waiting for a prompt; " +
        "dead = process ended. Returns {met, state, exitCode?, waitedMs}; on met=false (timeout) " +
        "the current state is returned — just call again to keep waiting.",
      inputSchema: {
        name: AGENT_NAME,
        until: z.enum(["idle", "needs-input", "dead"]).describe("state to wait for"),
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
    "propose_schedule",
    {
      description:
        "Propose a scheduled action (a cron-like timer). The proposal is INERT — it never fires — " +
        "until the HUMAN approves it in the sidebar; approving writes it into tachyon.yml. Use this " +
        "when you notice something should run regularly (e.g. tests hourly, a daily standup summary). " +
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
        const proposal = deps.proposals.create(name, schedule, "agent", reason);
        deps.onScheduleProposed?.(name, "agent");
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

  mcp.registerTool(
    "notify",
    {
      description: "Show a notification to the human in VSCode (use sparingly — when you need them).",
      inputSchema: {
        message: z.string().min(1),
        level: z.enum(["info", "warn", "error"]).default("info"),
      },
    },
    async ({ message, level }) => {
      try {
        deps.notify(message, level);
        return ok("notification shown");
      } catch (err) {
        return fail(err);
      }
    },
  );

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
          runtime: z.enum(["claude", "codex"]),
          archetype: z.enum(["adversarial-review", "factual-verify", "freeform"]).default("adversarial-review"),
          task: z.string().min(1).describe("what to ask the probed model — one substantive directive"),
          context: z.string().optional(),
          constraints: z.string().optional(),
          model: z.string().optional(),
          timeoutSec: z.number().int().min(1).max(600).optional(),
          budgetUsd: z.number().positive().finite().optional(), // reject NaN/Infinity (codex review #43)
          write: z.boolean().default(false).describe("a write-capable probe runs in an isolated worktree; default read-only"),
          wait: z.enum(["sync", "async"]).default("sync"),
          caller: z.string().optional().describe("your agent name (lineage/authorization)"),
        },
      },
      async (a) => {
        try {
          const { runId, done } = await probe.launch({
            runtime: a.runtime,
            archetype: a.archetype,
            brief: { task: a.task, context: a.context, constraints: a.constraints },
            model: a.model,
            cwd: deps.probeCwd?.() ?? process.cwd(),
            timeoutMs: a.timeoutSec ? a.timeoutSec * 1000 : undefined,
            budgetUsd: a.budgetUsd,
            write: a.write,
            caller: a.caller,
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
