/**
 * Session-ownership ledger (spec 243). The shared-cwd `/clear` problem: when several claude agents share
 * ONE cwd AND config home, their transcripts live in one dir and a `/clear` rotates an agent to a NEW
 * session whose jsonl carries NO Tachyon-minted marker (claude auto-retitles the `customTitle`) and NO
 * parent link — so from disk alone the new session cannot be attributed to the right agent. The activity
 * resolver therefore stayed pinned to the pre-`/clear` transcript and logging froze.
 *
 * The fix is a POSITIVE per-agent signal, not a disk guess: Tachyon spawns each claude agent with a
 * per-spawn `--settings` `SessionStart` hook (materialized in HarnessManager) that appends one row here on
 * every session start (incl. `source:"clear"` / `"resume"`). The hook receives `{session_id,
 * transcript_path, cwd, source}` from claude and the agent identity is baked into the hook command, so the
 * row is exact. The resolver follows the agent's NEWEST row — never another agent's session.
 *
 * This file holds the PURE helpers (parse/select/build) + a thin fs read; the append side is a standalone
 * recorder script (SESSION_OWNER_RECORDER_SOURCE) materialized per workspace and run by claude.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface OwnerRow {
  agent: string;
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  source: string;
  ts: string;
}

/** The append-only ownership ledger for a workspace (one file, all agents). Lives beside the activity logs. */
export function sessionOwnersFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "activity", "session-owners.jsonl");
}

/** The materialized recorder the SessionStart hook invokes (`node <recorder> <agent> <ownersFile>`). */
export function sessionOwnerRecorderPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "activity", "session-owner-record.cjs");
}

/** The per-agent per-spawn `--settings` file carrying the SessionStart ownership hook. */
export function spawnSettingsPath(workspaceRoot: string, agent: string): string {
  return path.join(workspaceRoot, ".tachyon", "spawn-settings", `${agent}.json`);
}

/** The materialized SessionStart handoff-pointer script (spec 245) — emits a ONE-LINE additionalContext pointer
 *  to the project handoff when one exists, so a resuming agent knows to read it (never the content itself). */
export function handoffPointerPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "activity", "handoff-pointer.cjs");
}

/** The materialized SessionStart continuity-pointer script (spec 312) — emits a ONE-LINE additionalContext pointer
 *  to an agent's continuity brief when one exists. It never asks the agent to create/update a brief. */
export function continuityPointerPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "activity", "continuity-pointer.cjs");
}

/** The materialized Stop hook recorder (spec 312) — records that a runtime Stop hook fired without fabricating
 *  semantic handoff content or forcing another model turn. */
export function persistenceStopRecorderPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "activity", "persistence-stop-record.cjs");
}

/** Append-only health/cursor ledger for persistence Stop hooks. It is machine-local activity state. */
export function persistenceStopFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "activity", "persistence-stop.jsonl");
}

/** Parse the JSONL ledger; skip malformed/partial lines (a crash mid-append leaves at most one). PURE. */
export function parseOwnerRows(text: string): OwnerRow[] {
  const out: OwnerRow[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s) as Partial<OwnerRow>;
      if (typeof r.agent === "string" && typeof r.sessionId === "string" && typeof r.transcriptPath === "string") {
        out.push({ agent: r.agent, sessionId: r.sessionId, transcriptPath: r.transcriptPath, cwd: typeof r.cwd === "string" ? r.cwd : "", source: typeof r.source === "string" ? r.source : "", ts: typeof r.ts === "string" ? r.ts : "" });
      }
    } catch { /* skip a non-JSON / partial line */ }
  }
  return out;
}

/** The agent's CURRENT owned session: the LAST row for (agent, canonical cwd). The ledger is append-
 *  ordered, so the last matching row is the newest SessionStart that agent observed (a `/clear` or
 *  `/resume` rotation included). The cwd match is REQUIRED (claude always supplies `cwd` in the hook
 *  payload) — it guards a renamed/relocated agent reusing a name; an empty/foreign-cwd row never matches
 *  (codex review: an accepted empty-cwd row could hand back a stale incarnation). Attribution is per-agent
 *  and positive — it can NEVER return another agent's session. PURE. */
export function latestOwnerFor(rows: OwnerRow[], agent: string, cwd: string): OwnerRow | undefined {
  const want = path.resolve(cwd);
  let hit: OwnerRow | undefined;
  for (const r of rows) {
    if (r.agent === agent && r.cwd !== "" && path.resolve(r.cwd) === want) hit = r;
  }
  return hit;
}

/** Read + parse the ledger (best-effort; missing/empty/unreadable → []). */
export function readSessionOwners(file: string): OwnerRow[] {
  try { return parseOwnerRows(fs.readFileSync(file, "utf8")); } catch { return []; }
}

/** POSIX single-quote a token for the hook command string (the recorder + args are absolute paths Tachyon
 *  controls; agent names are NAME_RE-safe). Matches the spawn command's shell (tmux/POSIX). */
function q(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Build the per-spawn settings object: a SessionStart hook that records ownership on every session start.
 *  `--settings` is ADDITIVE over user/project/global settings (claude merges), so existing hooks still run.
 *  PURE — HarnessManager writes the returned object + the recorder to disk. */
export function buildOwnershipSettings(
  recorderPath: string,
  agent: string,
  ownersFile: string,
  pointer?: { pointerPath: string; handoffPath: string },
  persistence?: { continuityPointerPath: string; continuityPath: string; stopRecorderPath: string; stopFile: string },
): {
  hooks: { SessionStart: { matcher?: string; hooks: { type: string; command: string }[] }[]; Stop?: { matcher?: string; hooks: { type: string; command: string }[] }[] };
} {
  const hooks = [{ type: "command", command: `node ${q(recorderPath)} ${q(agent)} ${q(ownersFile)}` }];
  // spec 245 — a SECOND SessionStart command emits a one-line pointer (additionalContext) to the project
  // handoff when one exists. Additive; claude unions additionalContext across hooks. Never dumps content.
  if (pointer) hooks.push({ type: "command", command: `node ${q(pointer.pointerPath)} ${q(pointer.handoffPath)}` });
  if (persistence) hooks.push({ type: "command", command: `node ${q(persistence.continuityPointerPath)} ${q(agent)} ${q(persistence.continuityPath)}` });
  const settings: { hooks: { SessionStart: { matcher?: string; hooks: { type: string; command: string }[] }[]; Stop?: { matcher?: string; hooks: { type: string; command: string }[] }[] } } = { hooks: { SessionStart: [{ matcher: "startup|resume|clear|compact", hooks }] } };
  if (persistence) {
    settings.hooks.Stop = [{ hooks: [{ type: "command", command: `node ${q(persistence.stopRecorderPath)} ${q(agent)} ${q(persistence.stopFile)}` }] }];
  }
  return settings;
}

/** Build a Codex `-c hooks.SessionStart=...` override value carrying the same Tachyon SessionStart hooks.
 *  Codex merges this session-scoped override with workspace/user hooks; the agent identity rides in an env var
 *  so the hook command string stays stable across agents in the same workspace. */
export function buildCodexSessionStartHookConfig(
  recorderPath: string,
  ownersFile: string,
  pointer?: { pointerPath: string; handoffPath: string },
  persistence?: { continuityPointerPath: string; continuityPath: string; stopRecorderPath: string; stopFile: string },
): string {
  const ownershipHooks = [
    `{type="command",command=${tomlString(`node ${q(recorderPath)} "$TACHYON_AGENT_NAME" ${q(ownersFile)}`)},statusMessage="Recording Tachyon session ownership"}`,
  ];
  const pointerHooks: string[] = [];
  if (pointer) {
    pointerHooks.push(`{type="command",command=${tomlString(`node ${q(pointer.pointerPath)} ${q(pointer.handoffPath)}`)},statusMessage="Checking Tachyon project handoff"}`);
  }
  if (persistence) {
    pointerHooks.push(`{type="command",command=${tomlString(`node ${q(persistence.continuityPointerPath)} "$TACHYON_AGENT_NAME" ${q(persistence.continuityPath)}`)},statusMessage="Checking Tachyon continuity"}`);
  }
  const startEntries = [
    `{matcher="startup|resume|clear|compact",hooks=[${ownershipHooks.join(",")}]}`,
  ];
  if (pointerHooks.length > 0) {
    // Codex renders additionalContext in the human-visible pane. Keep ownership on compact, but only emit
    // handoff/continuity pointers at true session boundaries so compaction cannot interrupt the user mid-turn.
    startEntries.push(`{matcher="startup|resume|clear",hooks=[${pointerHooks.join(",")}]}`);
  }
  const start = `hooks.SessionStart=[${startEntries.join(",")}]`;
  if (!persistence) return start;
  const stop = `hooks.Stop=[{hooks=[{type="command",command=${tomlString(`node ${q(persistence.stopRecorderPath)} "$TACHYON_AGENT_NAME" ${q(persistence.stopFile)}`)},statusMessage="Recording Tachyon persistence stop"}]}]`;
  return `${start}\n${stop}`;
}

/** The standalone recorder. Reads the SessionStart hook payload on stdin and appends ONE ownership row.
 *  Self-contained (no Tachyon imports) — run as `node <this> <agent> <ownersFile>` by the injected hook.
 *  Best-effort: any failure is swallowed so a hook error can never block the claude session. */
export const SESSION_OWNER_RECORDER_SOURCE = `// Tachyon session-ownership recorder (spec 243) — materialized; do not edit.
// Invoked by a per-spawn claude SessionStart --settings hook: node <this> <agent> <ownersFile>
const fs = require("fs");
const path = require("path");
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  try {
    const agent = process.argv[2];
    const out = process.argv[3];
    if (!agent || !out) return;
    const p = JSON.parse(raw || "{}");
    if (!p.session_id) return;
    const row = JSON.stringify({
      agent: agent,
      sessionId: p.session_id,
      transcriptPath: p.transcript_path || "",
      cwd: p.cwd || "",
      source: p.source || "",
      ts: new Date().toISOString(),
    });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.appendFileSync(out, row + "\\n");
  } catch (_e) { /* best-effort: never block the session on a hook failure */ }
});
`;

/** The standalone SessionStart handoff-pointer (spec 245). Run as \`node <this> <handoffPath>\`. If a non-trivial
 *  project handoff exists, prints a ONE-LINE additionalContext pointer (NOT the content) so a resuming agent reads
 *  it via get_project_handoff. Silent (no output) when there is no handoff — additive, never a context dump. */
export const SESSION_HANDOFF_POINTER_SOURCE = `// Tachyon project-handoff SessionStart pointer (spec 245) — materialized; do not edit.
// Invoked by a per-spawn claude SessionStart --settings hook: node <this> <handoffPath>
const fs = require("fs");
try {
  const p = process.argv[2];
  if (p) {
    const raw = fs.readFileSync(p, "utf8");
    const body = raw.replace(/^---[\\s\\S]*?\\n---\\n?/, "").trim();
    if (body.length > 0) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "A shared PROJECT HANDOFF exists for this workspace (" + p + "). If you are resuming or picking up work, read it first with the get_project_handoff tool — it is the curated state of the project. Append project-state changes with append_project_handoff_note (do not rewrite the shared handoff).",
        },
      }));
    }
  }
} catch (_e) { /* no handoff / unreadable → no pointer */ }
`;

/** SessionStart continuity pointer (spec 312). It is intentionally a pointer, not a context dump: the current
 *  brief remains agent-authored and is read via get_continuity when useful. */
export const SESSION_CONTINUITY_POINTER_SOURCE = `// Tachyon continuity SessionStart pointer (spec 312) — materialized; do not edit.
// Invoked by a per-spawn SessionStart hook: node <this> <agent> <continuityFile>
const fs = require("fs");
try {
  const agent = process.argv[2];
  const p = process.argv[3];
  if (agent && p && fs.existsSync(p)) {
    const raw = fs.readFileSync(p, "utf8");
    const body = raw.replace(/^---[\\s\\S]*?\\n---\\n?/, "").trim();
    if (body.length > 0) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "A Tachyon continuity brief exists for agent '" + agent + "'. Read it with get_continuity(agent: \\"" + agent + "\\") before continuing work after startup/resume/clear/compact. Do not create a new brief just because this pointer exists.",
        },
      }));
    }
  }
} catch (_e) { /* no continuity / unreadable → no pointer */ }
`;

/** Stop-hook health/cursor recorder (spec 312). It records lifecycle evidence only; it never writes semantic
 *  project-handoff notes and never emits context that would ask the model to continue. */
export const PERSISTENCE_STOP_RECORDER_SOURCE = `// Tachyon persistence Stop recorder (spec 312) — materialized; do not edit.
const fs = require("fs");
const path = require("path");
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  try {
    const agent = process.argv[2];
    const out = process.argv[3];
    if (!agent || !out) return;
    let payload = {};
    try { payload = JSON.parse(raw || "{}"); } catch (_e) {}
    const row = JSON.stringify({
      agent,
      event: "Stop",
      sessionId: payload.session_id || payload.sessionId || "",
      cwd: payload.cwd || "",
      ts: new Date().toISOString(),
    });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.appendFileSync(out, row + "\\n");
  } catch (_e) { /* best-effort: never block the runtime on hook bookkeeping */ }
});
`;
