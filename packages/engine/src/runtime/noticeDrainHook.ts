/**
 * t-b47fb2 fatia 2, second half — the end-of-turn hook that DUMPS pending notices into the agent's
 * own session.
 *
 * ## Why this exists even though the queue now survives a restart
 *
 * The reconstitution half attacks the CAUSE (a queue that lived only in memory). This half is the
 * difference between best-effort and guaranteed delivery, and it is the owner's idea. Pane delivery
 * waits for a working→idle edge that the recipient may never open: measured on 2026-08-13 (`t-747369`)
 * four of seven notices arrived 8–13 minutes late because the recipient was busy, and the whole
 * reason `read_notices` exists is that a coordinator can stay busy indefinitely. A Stop hook fires on
 * the one moment that is guaranteed to arrive at the end of every turn.
 *
 * ## Measured, on this host, before projecting anything (docs/project-guidance.md)
 *
 * The delivery contract is the same on all three runtimes: a `Stop` hook that exits 2 puts its first
 * stderr line into the model's context and continues the turn. Measured 2026-08-18 with a probe hook
 * that emitted one token and then exited 0:
 *
 *  - **claude 2.1.235** — the text arrives as a user-role turn labelled `Stop hook feedback:`, the
 *    model answers it, and the second Stop invocation ends the session. 2 hook invocations.
 *  - **codex 0.147.0** (`-c hooks.Stop=[…] --dangerously-bypass-hook-trust`) — a second
 *    `agent_message` carrying the token, then `turn.completed`. 2 hook invocations.
 *  - **grok 1.0.5** (`$GROK_HOME/hooks/stop.json`, `-p --yolo`) — `num_turns: 2`, the token in the
 *    answer. **3** hook invocations, which is why the cursor MUST advance before the emit rather than
 *    after: an emit that did not move the cursor first would re-fire on every one of those.
 *
 * Every other runtime (pi, opencode, hermes, gemini, qwen) is out, named rather than silently missing:
 * Tachyon owns no measured per-spawn Stop channel for them. `t-09edf2`/`t-685a0c` reached exactly
 * these same three for exactly this reason.
 *
 * ## One line, on purpose
 *
 * Grok keeps only the FIRST stderr line of a hook refusal (measured under `t-685a0c`). A design that
 * emitted one line per notice would therefore deliver the first notice and silently drop the rest on
 * one of the three runtimes — the exact defect shape this task exists to remove. So the dump is one
 * bounded line whatever the runtime, and what does not fit is NAMED with the count and the door that
 * still has it (`read_notices` reads the same durable trail, and never loses).
 *
 * ## Who else can reach this? (docs/project-guidance.md)
 *
 *  - *Agent claude / codex / grok × create, restart, resume, fork* — the lifecycle Stop channel each
 *    spawn door already writes (`buildOwnershipSettings`, `buildCodexSessionStartHookConfig`,
 *    `materializeGrokLifecycleHooks`). The projected-plugin channel deliberately refuses Stop, so this
 *    could not ride there.
 *  - *Tachyon × crash-recovery* — same spawn doors, re-derived; nothing is imported from the
 *    environment the session woke in.
 *  - *Tachyon × engine boot / working→idle edge* — the OTHER writer of the same cursor. Both doors
 *    keep one hand-over record, so whichever reaches the agent first wins and the other stands down
 *    (`Workspace.noticeAlreadyHandedOver`).
 *  - *Interface × reading the pane* — unaffected; the dump is hook feedback into the model's context,
 *    not a line typed into the composer.
 */

import path from "node:path";
import type { OwnershipHookGroup } from "../activity/sessionOwners.js";

/** Runtimes with a Tachyon-owned per-spawn Stop channel MEASURED to reach the model. */
export const NOTICE_DRAIN_RUNTIMES = ["claude", "codex", "grok"] as const;
export type NoticeDrainRuntime = (typeof NOTICE_DRAIN_RUNTIMES)[number];

export function isNoticeDrainRuntime(runtime: string): runtime is NoticeDrainRuntime {
  return (NOTICE_DRAIN_RUNTIMES as readonly string[]).includes(runtime);
}

/**
 * How many notices one dump carries, and how long the line may be.
 *
 * Configured numbers rather than a policy that computes them (docs/project-guidance.md § "Prefer a
 * configured number to a system that computes it"). The count matches `NoticeQueue`'s own
 * `maxPerTarget` so the two doors cannot disagree about how deep a backlog is; the byte cap is what
 * keeps one turn's context from being eaten by a backlog, and whatever it cuts is named, not dropped.
 */
export const NOTICE_DRAIN_MAX_NOTICES = 20;
export const NOTICE_DRAIN_MAX_CHARS = 4000;

/** Where the materialized drain script lives. Beside the other Tachyon-owned hook scripts. */
export function noticeDrainScriptPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "activity", "notice-drain.cjs");
}

export interface NoticeDrainHookInput {
  /** Absolute path of the materialized drain script. */
  scriptPath: string;
  /** The workspace root the durable trail and the cursor live under. */
  workspaceRoot: string;
  /** The shared Tachyon hook-failure ledger, so a drain that throws is visible rather than silent. */
  failureFile?: string;
  /**
   * How the hook command names the agent. Claude and grok bake the resolved name at spawn; codex keeps
   * one command string for every agent in the workspace and reads `$TACHYON_AGENT_NAME` instead —
   * the same split `buildCodexSessionStartHookConfig` already makes for the ownership recorder.
   */
  agentArg: string;
}

/** Shell-quote a resolved agent name for the claude/grok form of the command. */
export function noticeDrainAgentArg(agent: string): string {
  return shellQuote(agent);
}

/** The codex form: one command string for every agent in the workspace, resolved at hook run time. */
export const NOTICE_DRAIN_CODEX_AGENT_ARG = '"$TACHYON_AGENT_NAME"';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The one command string, so claude, codex and grok cannot drift in how they invoke the same script. */
export function noticeDrainHookCommand(input: NoticeDrainHookInput): string {
  const q = shellQuote;
  const agent = input.agentArg === NOTICE_DRAIN_CODEX_AGENT_ARG
    ? "$TACHYON_AGENT_NAME"
    : input.agentArg.startsWith("'") && input.agentArg.endsWith("'")
      ? input.agentArg.slice(1, -1).replace(/'\\''/g, "'")
      : input.agentArg;
  const config = JSON.stringify({
    agent,
    workspaceRoot: input.workspaceRoot,
    failureFile: input.failureFile ?? "",
    maxNotices: NOTICE_DRAIN_MAX_NOTICES,
    maxChars: NOTICE_DRAIN_MAX_CHARS,
  });
  return (
    `node ${q(input.scriptPath)} ${q(config)}`
  );
}

/** The Stop group to append to a runtime's lifecycle channel, or `undefined` for an unmeasured one. */
export function planNoticeDrainHook(runtime: string, input: NoticeDrainHookInput): OwnershipHookGroup | undefined {
  if (!isNoticeDrainRuntime(runtime)) return undefined;
  if (!input.scriptPath) return undefined;
  return {
    hooks: [
      {
        type: "command",
        command: noticeDrainHookCommand(input),
        // Only codex renders a statusMessage; the grok adapter parser rejects the key outright.
        ...(runtime === "codex" ? { statusMessage: "Draining Tachyon notices" } : {}),
      },
    ],
  };
}

/**
 * Compose the one line an agent reads. Exported so a test can pin the exact text and so the CJS script
 * below can be checked against it — the script is self-contained (no Tachyon imports, because a hook
 * runs as a bare `node <file>`), and this is the only thing standing between that and a silent drift.
 */
export function composeNoticeDrainLine(lines: readonly string[], maxChars: number): string {
  const header = `[tachyon] ${lines.length} notice(s) arrived during your turn: `;
  const kept: string[] = [];
  let used = header.length;
  for (const line of lines) {
    const cost = (kept.length > 0 ? 3 : 0) + line.length;
    if (used + cost > maxChars) break;
    kept.push(line);
    used += cost;
  }
  const dropped = lines.length - kept.length;
  // Never a silent cut: what did not fit is counted and pointed at the door that still holds it. The
  // separator is conditional because a cap tight enough to keep NOTHING would otherwise open the line
  // with a dangling " · " — the pathological case, but the one a reader would report as a bug.
  const tail = dropped > 0 ? `${kept.length > 0 ? " · " : ""}(+${dropped} more — read them with read_notices)` : "";
  return `${header}${kept.join(" · ")}${tail}`;
}

/**
 * The materialized drain. Self-contained CommonJS, run as
 * `node <this> '<json config>'` with the Stop payload on
 * stdin. Exit 2 emits the first stderr line into the model's context; every other exit is silent.
 *
 * Two rules decide whether this helps or loops:
 *
 * 1. **The cursor advances BEFORE the emit**, which is the owner's custody decision made mechanical.
 *    An agent that dies between the two loses that dump, and `doorbells.jsonl` still has every row.
 * 2. **If the cursor cannot be written, nothing is emitted.** Emitting without advancing would re-fire
 *    on the next Stop, forever — and grok fires Stop three times per turn. Silence there is today's
 *    behaviour; a loop is worse than the delay this hook exists to remove.
 *
 * Everything else fails open: an unreadable trail, an unparseable cursor, a damaged line, an
 * unresolvable agent name — all exit 0 and let the pane path do what it does today.
 */
export const NOTICE_DRAIN_SCRIPT_SOURCE = `// Tachyon end-of-turn notice drain (t-b47fb2) — materialized; do not edit.
// node <this> '<json config>'; Stop payload on stdin.
// exit 2 = emit the pending notices into the model's context; any other exit is silent.
const fs = require("fs");
const path = require("path");
let config = {};
try { config = JSON.parse(process.argv[2] || "{}"); } catch (_e) {}
const agent = (config.agent === "$TACHYON_AGENT_NAME" ? process.env.TACHYON_AGENT_NAME : config.agent) || "";
const workspaceRoot = config.workspaceRoot || "";
const failureFile = config.failureFile || "";
const maxNotices = Number(config.maxNotices) || ${NOTICE_DRAIN_MAX_NOTICES};
const maxChars = Number(config.maxChars) || ${NOTICE_DRAIN_MAX_CHARS};
let raw = "";

function sanitizeReason(e) {
  const msg = e && typeof e.message === "string" ? e.message : String(e || "unknown error");
  return msg.replace(/[\\r\\n\\t]+/g, " ").slice(0, 240);
}
function logFailure(e) {
  if (!failureFile) return;
  try {
    fs.mkdirSync(path.dirname(failureFile), { recursive: true });
    fs.appendFileSync(failureFile, JSON.stringify({
      agent,
      event: "Stop",
      script: "notice-drain",
      path: workspaceRoot,
      reason: sanitizeReason(e),
      ts: new Date().toISOString(),
    }) + "\\n");
  } catch (_e) {}
}

/** One bounded, single-line envelope — the same shape the pane would have received. */
function compose(from, to, summary, pointer) {
  const clean = (s) => String(s == null ? "" : s).replace(/[\\r\\n\\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  const tail = pointer ? " [details: " + clean(pointer).slice(0, 120) + "]" : "";
  return "[tachyon] " + from + " \\u2192 " + to + ": " + clean(summary).slice(0, 500) + tail;
}

function readCursorFile(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (_e) { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  if (parsed.version !== 1 || typeof parsed.baseline !== "string" || !parsed.baseline) return undefined;
  if (!parsed.cursors || typeof parsed.cursors !== "object" || Array.isArray(parsed.cursors)) return undefined;
  return parsed;
}

function pending(trailFile, since) {
  const out = [];
  let text;
  try { text = fs.readFileSync(trailFile, "utf8"); }
  catch (_e) { return out; }
  const needle = JSON.stringify(agent);
  for (const line of text.split("\\n")) {
    // Cheap pre-filter: the overwhelming majority of a long trail is addressed to somebody else, and
    // JSON.parse on every row of it is the only thing here that grows with workspace age.
    if (!line || line.indexOf(needle) === -1) continue;
    let row;
    try { row = JSON.parse(line); } catch (_e) { continue; }
    if (!row || row.event === "overflow-drop") continue;
    if (row.to !== agent || typeof row.at !== "string") continue;
    if (since !== undefined && row.at <= since) continue;
    if (typeof row.summary !== "string" || !row.summary.trim()) continue;
    out.push(row);
  }
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out;
}

/** Monotonic, atomic, and the ONLY thing that authorises an emit. */
function advance(file, at) {
  const current = readCursorFile(file) || { version: 1, baseline: at, cursors: {} };
  const held = current.cursors[agent];
  if (held !== undefined && held >= at) return true;
  const next = { version: 1, baseline: current.baseline, cursors: Object.assign({}, current.cursors) };
  next.cursors[agent] = at;
  const temp = file + "." + process.pid + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(next, null, 2) + "\\n", "utf8");
  fs.renameSync(temp, file);
  return true;
}

function compose_line(lines) {
  const header = "[tachyon] " + lines.length + " notice(s) arrived during your turn: ";
  const kept = [];
  let used = header.length;
  for (const line of lines) {
    const cost = (kept.length > 0 ? 3 : 0) + line.length;
    if (used + cost > maxChars) break;
    kept.push(line);
    used += cost;
  }
  const dropped = lines.length - kept.length;
  const tail = dropped > 0
    ? (kept.length > 0 ? " \\u00b7 " : "") + "(+" + dropped + " more \\u2014 read them with read_notices)"
    : "";
  return header + kept.join(" \\u00b7 ") + tail;
}

function decide() {
  if (!agent || !workspaceRoot) return "";
  const trailFile = path.join(workspaceRoot, ".tachyon", "doorbells.jsonl");
  const cursorFile = path.join(workspaceRoot, ".tachyon", "notice-cursors.json");
  const cursors = readCursorFile(cursorFile);
  // No cursor file, or one we cannot read, means we cannot tell pending from history. Staying silent
  // is today's behaviour; guessing "everything is pending" would dump the whole trail into a turn.
  if (!cursors) return "";
  const own = cursors.cursors[agent];
  const since = own === undefined || own < cursors.baseline ? cursors.baseline : own;
  const rows = pending(trailFile, since);
  if (rows.length === 0) return "";
  const carried = rows.slice(-maxNotices);
  // Advance past EVERY pending row, not only the ones carried: the overflow is named in the line and
  // still readable through read_notices, so replaying it next turn would be repetition, not rescue.
  if (!advance(cursorFile, rows[rows.length - 1].at)) return "";
  const lines = carried.map((row) => compose(row.from, row.to, row.summary, row.pointer));
  const older = rows.length - carried.length;
  return compose_line(lines) + (older > 0 ? " (" + older + " older notice(s) not carried \\u2014 read_notices)" : "");
}

process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  let text = "";
  try { text = decide(); }
  catch (e) { logFailure(e); text = ""; }
  if (!text) process.exit(0);
  process.stderr.write(text + "\\n");
  process.exit(2);
});
`;
