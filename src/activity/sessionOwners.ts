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

/** Build the per-spawn settings object: a SessionStart hook that records ownership on every session start.
 *  `--settings` is ADDITIVE over user/project/global settings (claude merges), so existing hooks still run.
 *  PURE — HarnessManager writes the returned object + the recorder to disk. */
export function buildOwnershipSettings(recorderPath: string, agent: string, ownersFile: string): {
  hooks: { SessionStart: { hooks: { type: string; command: string }[] }[] };
} {
  const command = `node ${q(recorderPath)} ${q(agent)} ${q(ownersFile)}`;
  return { hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } };
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
