/**
 * t-685a0c — the PreToolUse gate that makes `settings.checklist.requireIn` a MECHANISM.
 *
 * ## The defect this closes
 *
 * Someone installs Tachyon, writes `settings.checklist.requireIn: [feature]` in `tachyon.yml`, and
 * nothing happens. Measured in `t-cb684f`: `requireIn` was consulted only when the turn judgment read
 * `absent`, which needs a `persistence-stop.jsonl` row, which only a DECLARED agent writes — all 1,461
 * ledger rows belong to Saved agents and none to a Temporary one. So the shipped setting declared a
 * capability the product did not have, which `docs/project-guidance.md` § "A declared capability needs a
 * deterministic mechanism" names as the same defect class as code declaring state it does not hold.
 *
 * That reminder is not replaced. It fires at turn END and never blocks delivery
 * (`INTERNAL_CHECKLIST_GIVE_UP_JOURNAL` still says so). This gate fires at the FIRST CHANGE, which is
 * the moment the owner's decision names: *"OBRIGA a porra do agente escrever o plano antes de
 * implementar a task"*.
 *
 * ## What it is
 *
 * One `PreToolUse` group per runtime, carried on the per-spawn channel Tachyon already owns end to end
 * (`--settings` for claude, `-c hooks.<Event>=` for codex, `$GROK_HOME/hooks/` for grok — the same three
 * channels `agentHookProjection.ts` uses, all three measured to reach a TEMPORARY agent). It refuses the
 * first MUTATING tool call of a session until that session's plan ledger has a plan in it.
 *
 * ## The six locks from the card, and where each one lives
 *
 * 1. **Fail OPEN, always.** The script's every unknown answers `allow`. Three separate levers:
 *    a tool name outside `MUTATING_TOOLS` passes (an allowlist of mutators, so an unrecognized runtime
 *    or an unrecognized tool can only widen the door, never narrow it); a payload with no session id
 *    passes; and `planState` returns `unknown` — which allows — for every read error that is not
 *    "the thing is not there". The command is deliberately NOT wrapped in the `wrapResolved` fail-CLOSED
 *    shell prelude that plugin gates use: if the script is missing, `node` exits 1, and exit 1 blocks
 *    nothing in any of the three runtimes.
 * 2. **Only when `requireIn` covers the task's kind.** Decided at SPAWN, by `planChecklistGateHooks`
 *    returning `undefined`: with no task, an uncovered kind, or an empty list, the hook is never written
 *    into the session's channel at all. The factory default therefore ships zero hook, not a hook that
 *    decides to allow — the negative control can observe the difference.
 * 3. **Once per session, not per turn.** The question asked is "does this SESSION's plan ledger hold a
 *    plan", and a plan never un-writes itself, so the gate stops answering `deny` for good the moment
 *    one exists. Nothing is counted per turn and no state of our own is kept.
 * 4. **The refusal names the way out**, in the runtime's own vocabulary — and on Claude it also says the
 *    tool is deferred and needs `ToolSearch` first, because a refusal an agent cannot act on is a loop.
 *    One LINE, on purpose: grok caps the deny reason at the first stderr line.
 * 5. **It never blocks delivery.** `PreToolUse` on mutating tools only; `Stop` is untouched.
 * 6. **Grok earns its hook by measurement.** Measured 2026-08-18 on grok 1.0.5 (`5115b46bc9`), two real
 *    headless `-p --yolo` turns in a scratch cwd: asked to edit a file with no mention of planning, grok
 *    ran `search_replace` after `grep`/`read_file` and emitted ZERO plan events — no `sessionUpdate:
 *    "plan"`, no `TodosUpdated` — in either the stream or `updates.jsonl`. The positive control (same
 *    edit, plan requested) emitted both, twice, so the channel was alive and the absence is real. Grok
 *    does NOT always plan before mutating, so the hook is not pure cost.
 *
 * ## Who else can reach this? (docs/project-guidance.md)
 *
 * The plan is a pure function of (requireIn, task kind, runtime, paths), recomputed on every door, so no
 * door carries its own copy of the policy:
 *   - *Agent claude / codex / grok × create, restart, resume, fork* — `Workspace.projectedSessionHooks`,
 *     which every one of those doors already calls for plugin gates.
 *   - *Tachyon × crash-recovery* — re-derives from the same config and board, importing nothing from the
 *     environment the session woke in.
 *   - *Interface × edit `tachyon.yml` / retask a LIVE agent* — does NOT reach the running session: its
 *     argv and hook files were written at spawn. The next door picks the change up. Stated rather than
 *     hidden: a mid-session retask onto a covered kind leaves that session ungated, which is the
 *     fail-open direction.
 *   - *every other runtime* (pi, opencode, hermes, …) — `planChecklistGateHooks` returns undefined. No
 *     measured channel means no claim of one.
 */
import path from "node:path";
import { checklistRequiresKind } from "../config/checklistRequireIn.js";
import type { OwnershipHookGroup } from "../activity/sessionOwners.js";

/** Runtimes with a Tachyon-owned per-spawn hook channel measured to reach a Temporary agent. */
export const CHECKLIST_GATE_RUNTIMES = ["claude", "codex", "grok"] as const;
export type ChecklistGateRuntime = (typeof CHECKLIST_GATE_RUNTIMES)[number];

export function isChecklistGateRuntime(runtime: string): runtime is ChecklistGateRuntime {
  return (CHECKLIST_GATE_RUNTIMES as readonly string[]).includes(runtime);
}

/**
 * The matcher each runtime tests against the tool name.
 *
 * Claude and codex take a regex over their own tool names. Grok's matcher tests the real tool name but
 * also maps the Claude-style aliases (`Bash` → `run_terminal_command`, `Edit`/`Write`/`MultiEdit` →
 * `search_replace`) and keeps the original, so the Claude spelling reaches both; the grok-native names
 * are still listed because the alias table in its guide is explicitly "common aliases", not a closed set.
 */
export const CHECKLIST_GATE_MATCHERS: Record<ChecklistGateRuntime, string> = {
  claude: "^(Bash|Edit|MultiEdit|Write|NotebookEdit)$",
  codex: "^(Bash|shell|apply_patch)$",
  grok: "^(Bash|Edit|Write|MultiEdit|search_replace|run_terminal_command|run_terminal_cmd|create_file|delete_file)$",
};

/** How to write the plan, in the runtime's own vocabulary. One line — grok keeps only the first. */
const HOW_TO_WRITE: Record<ChecklistGateRuntime, string> = {
  claude:
    'Call TaskCreate to write it — it is a deferred tool, so load it first with ToolSearch("select:TaskCreate,TaskUpdate,TaskList").',
  codex: "Call update_plan to write it.",
  grok: "Call todo_write to write it.",
};

/** The refusal an agent reads. It must teach the way out, or the refusal becomes a loop. */
export function checklistGateRefusal(runtime: ChecklistGateRuntime): string {
  return (
    "[tachyon] settings.checklist requires a written plan for this task before the first change. " +
    `${HOW_TO_WRITE[runtime]} ` +
    "Shell commands count as changes, including reads; the gate applies whenever the required plan is absent."
  );
}

/** Where the materialized gate script lives. Beside the other Tachyon-owned hook scripts. */
export function checklistGateScriptPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "activity", "checklist-gate.cjs");
}

function q(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * What a spawn door already knows about the session it is creating, and the gate needs to locate that
 * session's plan ledger. Every field is optional: a door that cannot answer omits it, and the script
 * falls back to the runtime's own environment and then to allowing.
 */
export interface ChecklistGateSession {
  /** The private runtime config home Tachyon materialized for this spawn (claude: holds `tasks/`). */
  configHome?: string;
}

export interface ChecklistGatePlanInput {
  runtime: string;
  /** `settings.checklist.requireIn` verbatim. Absent or empty means nobody is required. */
  requireIn: readonly unknown[] | undefined;
  /** The kind of the task currently assigned to this agent, when it has one. */
  taskKind: string | undefined;
  /** Absolute path of the materialized gate script. */
  scriptPath: string;
  /**
   * Where the runtime's OWN plan ledger lives — never a ledger of ours (the card refuses a new one):
   *   claude `<configHome>/tasks`, the TaskCreate store the sidebar already reads;
   *   codex  `<workspaceRoot>/.tachyon/activity/codex-tool-hooks.jsonl`, the update_plan recorder;
   *   grok   `<GROK_HOME>/sessions`, whose `updates.jsonl` carries the todo_write events.
   * Empty is allowed: the script then falls back to the runtime's own env var, and to `unknown`
   * (which allows) when even that is absent.
   */
  planRoot?: string;
  /** The shared Tachyon hook-failure ledger, so a gate that throws is visible rather than silent. */
  failureFile?: string;
}

/**
 * The whole of lock 2: no requirement, no hook. Returns the event→groups block to merge into the
 * runtime's per-spawn channel, or `undefined` when this session must not be gated at all.
 */
export function planChecklistGateHooks(input: ChecklistGatePlanInput): Record<string, OwnershipHookGroup[]> | undefined {
  if (!isChecklistGateRuntime(input.runtime)) return undefined;
  if (!checklistRequiresKind(input.requireIn, input.taskKind)) return undefined;
  if (!input.scriptPath) return undefined;
  const runtime: ChecklistGateRuntime = input.runtime;
  const command = `node ${q(input.scriptPath)} ${q(JSON.stringify({
    runtime,
    planRoot: input.planRoot ?? "",
    failureFile: input.failureFile ?? "",
    reason: checklistGateRefusal(runtime),
  }))}`;
  return {
    PreToolUse: [
      {
        matcher: CHECKLIST_GATE_MATCHERS[runtime],
        hooks: [
          {
            type: "command",
            command,
            // Only codex renders a statusMessage; claude and grok ignore the key, and the grok adapter
            // parser rejects it, so it is not emitted for them.
            ...(runtime === "codex" ? { statusMessage: "Checking Tachyon required plan" } : {}),
          },
        ],
      },
    ],
  };
}

/**
 * The materialized gate. Self-contained CommonJS (no Tachyon imports) so it runs as
 * `node <this> '<json config>'` from a hook, with the PreToolUse payload on
 * stdin. The refusal text is an ARGUMENT rather than a copy inside the script, so `checklistGateRefusal`
 * stays the single place it is written and a test can assert the exact sentence the agent will read.
 *
 * Exit 0 allows, exit 2 refuses with the first stderr line as the reason. All three runtimes agree on
 * that contract for PreToolUse: claude and codex act on exit 2 (proven by the projected `secrets-guard`
 * gate), and grok's own guide states exit 2 is an explicit deny while ANY other exit code fails open.
 *
 * The one rule that decides whether this helps or destroys: "cannot read" is not "is not there". A
 * missing ledger — ENOENT, the shape the runtime leaves when the agent never wrote a plan — is the
 * absence we refuse on. Every OTHER failure (permissions, malformed JSON, a session we cannot even
 * locate, a throw anywhere) answers `unknown` and ALLOWS.
 */
export const CHECKLIST_GATE_SCRIPT_SOURCE = `// Tachyon internal-checklist gate (t-685a0c) — materialized; do not edit.
// node <this> '<json config>'; PreToolUse payload on stdin. exit 2 = refuse.
const fs = require("fs");
const path = require("path");
let config = {};
try { config = JSON.parse(process.argv[2] || "{}"); } catch (_e) {}
const runtime = config.runtime || "";
const planRoot = config.planRoot || "";
const failureFile = config.failureFile || "";
const reason = config.reason || "[tachyon] settings.checklist requires a written plan before the first change.";
let raw = "";

// An ALLOWLIST of mutators, deliberately: a tool this set does not know passes. The union across the
// three runtimes is safe because no entry is read-only anywhere — the matcher already narrowed the call,
// and this second filter exists so a matcher-dialect difference cannot turn a read into a refusal.
const MUTATING_TOOLS = new Set([
  "Bash", "Edit", "MultiEdit", "Write", "NotebookEdit",
  "shell", "apply_patch",
  "search_replace", "run_terminal_command", "run_terminal_cmd", "create_file", "delete_file",
]);

function sanitizeReason(e) {
  const msg = e && typeof e.message === "string" ? e.message : String(e || "unknown error");
  return msg.replace(/[\\r\\n\\t]+/g, " ").slice(0, 240);
}
function logFailure(e) {
  if (!failureFile) return;
  try {
    fs.mkdirSync(path.dirname(failureFile), { recursive: true });
    fs.appendFileSync(failureFile, JSON.stringify({
      agent: process.env.TACHYON_AGENT_NAME || "",
      event: "PreToolUse",
      script: "checklist-gate",
      path: planRoot,
      reason: sanitizeReason(e),
      ts: new Date().toISOString(),
    }) + "\\n");
  } catch (_e) {}
}
function safeSegment(value) {
  return typeof value === "string" && value.length > 0
    && value.indexOf("/") === -1 && value.indexOf("\\\\") === -1 && value !== "." && value !== "..";
}
// "absent" is the only answer that refuses. ENOENT is absence; anything else we cannot read is unknown.
function missingOrUnknown(e) {
  return e && e.code === "ENOENT" ? "absent" : "unknown";
}

function claudePlanState(sessionId) {
  const root = planRoot || (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, "tasks") : "");
  if (!root) return "unknown";
  let entries;
  try { entries = fs.readdirSync(path.join(root, sessionId)); }
  catch (e) { return missingOrUnknown(e); }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const row = JSON.parse(fs.readFileSync(path.join(root, sessionId, name), "utf8"));
      if (row && typeof row.subject === "string" && row.subject.trim()) return "present";
    } catch (_e) { /* one unreadable item is not the whole answer */ }
  }
  return "absent";
}

function codexPlanState(sessionId) {
  if (!planRoot) return "unknown";
  let text;
  try { text = fs.readFileSync(planRoot, "utf8"); }
  catch (e) { return missingOrUnknown(e); }
  for (const line of text.split("\\n")) {
    const s = line.trim();
    if (!s || s.indexOf("update_plan") === -1) continue;
    try {
      const row = JSON.parse(s);
      if (row && row.toolName === "update_plan" && row.sessionId === sessionId) return "present";
    } catch (_e) {}
  }
  return "absent";
}

function grokPlanState(sessionId, payload) {
  const root = planRoot || (process.env.GROK_HOME ? path.join(process.env.GROK_HOME, "sessions") : "");
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : payload.workspaceRoot;
  if (!root || typeof cwd !== "string" || !cwd) return "unknown";
  const dir = path.join(root, encodeURIComponent(cwd), sessionId);
  // The session DIRECTORY is the discriminator. Grok creates it when the session starts, so its absence
  // means we failed to locate the session (another GROK_HOME, another cwd spelling) — never that the
  // agent skipped the plan. Only a located session can be refused.
  try { if (!fs.statSync(dir).isDirectory()) return "unknown"; }
  catch (_e) { return "unknown"; }
  let text;
  try { text = fs.readFileSync(path.join(dir, "updates.jsonl"), "utf8"); }
  catch (e) { return missingOrUnknown(e); }
  for (const line of text.split("\\n")) {
    const s = line.trim();
    if (!s) continue;
    if (s.indexOf("todo_write") === -1 && s.indexOf("TodosUpdated") === -1 && s.indexOf('"plan"') === -1) continue;
    try {
      const row = JSON.parse(s);
      const update = (row && row.params && row.params.update) || (row && row.update) || row;
      if (!update || typeof update !== "object") continue;
      if (update.sessionUpdate === "plan") return "present";
      if (update.toolName === "todo_write" || update.title === "todo_write") return "present";
      const out = update.rawOutput;
      if (out && typeof out === "object" && (out.type === "Todo" || out.TodosUpdated)) return "present";
    } catch (_e) {}
  }
  return "absent";
}

function planState(sessionId, payload) {
  if (runtime === "claude") return claudePlanState(sessionId);
  if (runtime === "codex") return codexPlanState(sessionId);
  if (runtime === "grok") return grokPlanState(sessionId, payload);
  return "unknown";
}

function decide() {
  let payload = {};
  try { payload = JSON.parse(raw || "{}"); } catch (_e) { return 0; }
  if (!payload || typeof payload !== "object") return 0;
  // The checklist is a requirement for the primary agent, which can create the plan. A native
  // subagent is identified by agent_id, but cannot create the plan or see the parent's checklist;
  // requiring inherited session state would make its mutating tools depend on an unsatisfiable gate.
  if (Object.prototype.hasOwnProperty.call(payload, "agent_id")) return 0;
  const toolName = payload.tool_name || payload.toolName || "";
  if (!MUTATING_TOOLS.has(toolName)) return 0;
  const sessionId = payload.session_id || payload.sessionId || "";
  if (!safeSegment(sessionId)) return 0;
  return planState(sessionId, payload) === "absent" ? 2 : 0;
}

process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  let code = 0;
  try { code = decide(); }
  catch (e) { logFailure(e); code = 0; }
  if (code === 2) process.stderr.write(reason + "\\n");
  process.exit(code);
});
`;
