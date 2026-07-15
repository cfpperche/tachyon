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

export interface PersistenceHookFailureRow {
  agent: string;
  event: string;
  script: string;
  path: string;
  reason: string;
  ts: string;
}

export const PERSISTENCE_LEDGER_MAX_ROWS = 2000;
export const PERSISTENCE_LEDGER_MAX_BYTES = 256 * 1024;

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

/** Remove the per-agent per-spawn settings file. Best-effort; never throws. */
export function removeSpawnSettings(workspaceRoot: string, agent: string): void {
  try {
    fs.rmSync(spawnSettingsPath(workspaceRoot, agent), { force: true });
  } catch {
    /* best-effort: spawn-settings cleanup must never block agent removal */
  }
}

/** Drop per-agent spawn settings for agents no longer known to the workspace. Best-effort; never throws. */
export function compactSpawnSettings(workspaceRoot: string, knownAgents: Iterable<string>): void {
  try {
    const known = new Set(knownAgents);
    const dir = path.join(workspaceRoot, ".tachyon", "spawn-settings");
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
      const agent = ent.name.slice(0, -".json".length);
      if (!known.has(agent)) fs.rmSync(path.join(dir, ent.name), { force: true });
    }
  } catch {
    /* best-effort: stale spawn-settings files are harmless */
  }
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

/** Append-only failure ledger for Tachyon-owned persistence hook scripts (spec 317). */
export function persistenceHookFailureFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "activity", "persistence-hooks-failures.jsonl");
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

/** Append one ownership row directly to the ledger (e.g. a resolver-minted "rotation-follow" row, t-9f2641).
 *  Mirrors the SessionStart hook recorder's own append so the durable ledger stays the single source of
 *  truth for "who owns which session now" regardless of whether a hook or the resolver wrote the row. */
export function appendOwnerRow(file: string, row: OwnerRow): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

/**
 * t-9f2641 — mid-run transcript rotation follow. A harness-driven resume (or any rotation that keeps the
 * process alive) can mint a NEW transcript file while the ownership ledger's last row for this agent still
 * names the OLD one; if the old file is still readable on disk, `latestOwnerFor`'s row looks "valid" forever
 * and the resolver stays pinned to a dead file. This is the disk-side half of the fix: given the CALLER has
 * already decided the currently-resolved transcript is DEAD (no growth for its own threshold — that requires
 * multi-poll state the caller holds, not this pure-ish helper), find an unambiguous newer sibling to follow.
 *
 * Ambiguity discipline (reused from resume-ownership refresh, spec 243/244): a transcript directory is a
 * function of (cwd, config home) — two agents sharing BOTH land their sessions in the SAME directory, while
 * an isolated home (or a different worktree's cwd) is its own namespace. So "is this directory ambiguous"
 * reduces to "does any OTHER agent's current owned row live in this same directory" — no config-home plumbing
 * needed. If so, NEVER follow (stay pinned) — this is the never-guess invariant; a fixture must prove two
 * same-cwd agents can never steal each other's rotation.
 *
 * Returns undefined (never a guess) when ambiguous, the dead file itself is unreadable, or no STRICTLY newer
 * sibling `.jsonl` exists in the directory.
 *
 * Review correction round (t-9f2641): `rows` alone is a TOCTOU gap — a sibling agent's brand-new first
 * session can land on disk (newest mtime) before its own SessionStart hook has appended ITS owner row, so
 * a row-only ambiguity check can momentarily see "no other agent here yet" and steal the sibling's session.
 * `opts.liveTranscriptDirs` closes this: the caller passes the transcript directories of every OTHER
 * currently-declared agent (from the in-memory ledger, race-free within one tick — no extra I/O), and any
 * match makes the dir ambiguous exactly like a historical row would. `opts.deadMtimeBaseline` handles the
 * dead file being fully GONE (rotated AND pruned): with no mtime of its own to compare against, the resolver
 * would otherwise freeze forever; given the caller's last-known mtime for it, we follow ONLY when exactly
 * ONE sibling `.jsonl` is strictly newer (never a guess among several candidates).
 */
export function resolveRotationFollow(
  rows: OwnerRow[],
  agent: string,
  deadTranscriptPath: string,
  opts: {
    listDir?: (dir: string) => string[];
    mtimeMs?: (file: string) => number | undefined;
    liveTranscriptDirs?: Iterable<string>;
    deadMtimeBaseline?: number;
  } = {},
): { transcriptPath: string; sessionId: string } | undefined {
  const dir = path.resolve(path.dirname(deadTranscriptPath));
  // Latest row per agent (append order ⇒ last write wins), mirroring latestOwnerFor's own selection.
  const latestByAgent = new Map<string, OwnerRow>();
  for (const r of rows) latestByAgent.set(r.agent, r);
  for (const [otherAgent, r] of latestByAgent) {
    if (otherAgent === agent) continue;
    if (r.transcriptPath && path.resolve(path.dirname(r.transcriptPath)) === dir) return undefined; // shared dir ⇒ ambiguous
  }
  for (const liveDir of opts.liveTranscriptDirs ?? []) {
    if (path.resolve(liveDir) === dir) return undefined; // a live sibling's OWN session lives here — never guess
  }

  const listDir = opts.listDir ?? defaultListDir;
  const mtimeMs = opts.mtimeMs ?? defaultMtimeMs;
  const deadMtime = mtimeMs(deadTranscriptPath);

  if (deadMtime === undefined) {
    if (opts.deadMtimeBaseline === undefined) return undefined; // no evidence at all — stay pinned
    const baseline = opts.deadMtimeBaseline;
    let only: { file: string; mtime: number } | undefined;
    let count = 0;
    for (const entry of listDir(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const file = path.join(dir, entry);
      if (path.resolve(file) === path.resolve(deadTranscriptPath)) continue;
      const mtime = mtimeMs(file);
      if (mtime === undefined || mtime <= baseline) continue; // must be STRICTLY newer than the last-known mtime
      count++;
      only = { file, mtime };
    }
    if (count !== 1 || !only) return undefined; // none, or more than one candidate — ambiguous, stay pinned
    return { transcriptPath: only.file, sessionId: path.basename(only.file, ".jsonl") };
  }

  let newest: { file: string; mtime: number } | undefined;
  for (const entry of listDir(dir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const file = path.join(dir, entry);
    if (path.resolve(file) === path.resolve(deadTranscriptPath)) continue;
    const mtime = mtimeMs(file);
    if (mtime === undefined || mtime <= deadMtime) continue; // must be STRICTLY newer
    if (!newest || mtime > newest.mtime) newest = { file, mtime };
  }
  if (!newest) return undefined;
  return { transcriptPath: newest.file, sessionId: path.basename(newest.file, ".jsonl") };
}

function defaultListDir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function defaultMtimeMs(file: string): number | undefined {
  try { return fs.statSync(file).mtimeMs; } catch { return undefined; }
}

/** Remove all ownership rows for one agent when its ledger row is truly deleted. Best-effort; never throws. */
export function removeSessionOwnerRows(file: string, agent: string): void {
  try {
    const keep = parseOwnerRows(fs.readFileSync(file, "utf8")).filter((r) => r.agent !== agent);
    atomicWriteText(file, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""));
  } catch {
    /* best-effort: ownership cleanup must never block agent removal */
  }
}

/** Drop ownership rows for agents that are no longer known to the workspace. Best-effort; never throws. */
export function compactSessionOwnerRows(file: string, knownAgents: Iterable<string>): void {
  try {
    const known = new Set(knownAgents);
    const keep = parseOwnerRows(fs.readFileSync(file, "utf8")).filter((r) => known.has(r.agent));
    atomicWriteText(file, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""));
  } catch {
    /* best-effort: ownership cleanup must never block workspace activation */
  }
}

export function parsePersistenceHookFailureRows(text: string): PersistenceHookFailureRow[] {
  const out: PersistenceHookFailureRow[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s) as Partial<PersistenceHookFailureRow>;
      if (typeof r.agent === "string" && typeof r.event === "string" && typeof r.script === "string" && typeof r.ts === "string") {
        out.push({
          agent: r.agent,
          event: r.event,
          script: r.script,
          path: typeof r.path === "string" ? r.path : "",
          reason: typeof r.reason === "string" ? r.reason : "",
          ts: r.ts,
        });
      }
    } catch { /* skip malformed/partial lines */ }
  }
  return out;
}

export function readPersistenceHookFailures(file: string): PersistenceHookFailureRow[] {
  try { return parsePersistenceHookFailureRows(fs.readFileSync(file, "utf8")); } catch { return []; }
}

/** Best-effort retention for local persistence hook ledgers. Keeps recent valid rows plus the newest row per key. */
export function prunePersistenceLedger(
  file: string,
  opts: { maxRows?: number; maxBytes?: number } = {},
): void {
  const maxRows = opts.maxRows ?? PERSISTENCE_LEDGER_MAX_ROWS;
  const maxBytes = opts.maxBytes ?? PERSISTENCE_LEDGER_MAX_BYTES;
  try {
    const stat = fs.statSync(file);
    if (stat.size <= maxBytes) {
      const lineCount = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
      if (lineCount <= maxRows) return;
    }
    const raw = fs.readFileSync(file, "utf8");
    const parsed: Array<{ line: string; row: Record<string, unknown> }> = [];
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const row = JSON.parse(s) as Record<string, unknown>;
        parsed.push({ line: JSON.stringify(row), row });
      } catch { /* drop malformed/partial lines during retention */ }
    }
    if (parsed.length <= maxRows && Buffer.byteLength(raw, "utf8") <= maxBytes) return;
    let keep = selectPersistenceLedgerRows(parsed, maxRows);
    while (keep.length > 1 && Buffer.byteLength(keep.map((p) => p.line).join("\n") + "\n", "utf8") > maxBytes) {
      keep = keep.slice(1);
    }
    const out = keep.map((p) => p.line).join("\n");
    atomicWriteText(file, out ? `${out}\n` : "");
  } catch { /* best-effort: retention must never block hook/runtime work */ }
}

function selectPersistenceLedgerRows<T extends { row: Record<string, unknown> }>(parsed: T[], maxRows: number): T[] {
  const keep = new Set<number>();
  const seenKeys = new Set<string>();
  for (let i = parsed.length - 1; i >= 0 && keep.size < maxRows; i--) {
    const key = persistenceLedgerKey(parsed[i]!.row);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    keep.add(i);
  }
  for (let i = parsed.length - 1; i >= 0 && keep.size < maxRows; i--) keep.add(i);
  return parsed.filter((_p, i) => keep.has(i));
}

function persistenceLedgerKey(row: Record<string, unknown>): string {
  return [
    typeof row.agent === "string" ? row.agent : "",
    typeof row.event === "string" ? row.event : "",
    typeof row.script === "string" ? row.script : "",
  ].join("\0");
}

function atomicWriteText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/** POSIX single-quote a token for the hook command string (the recorder + args are absolute paths Tachyon
 *  controls; agent names are NAME_RE-safe). Matches the spawn command's shell (tmux/POSIX). */
function q(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const PERSISTENCE_LEDGER_RETENTION_SOURCE = `const PERSISTENCE_LEDGER_MAX_ROWS = 2000;
const PERSISTENCE_LEDGER_MAX_BYTES = 256 * 1024;
function persistenceLedgerKey(row) {
  return [
    typeof row.agent === "string" ? row.agent : "",
    typeof row.event === "string" ? row.event : "",
    typeof row.script === "string" ? row.script : "",
  ].join("\\u0000");
}
function prunePersistenceLedger(file) {
  try {
    const stat = fs.statSync(file);
    const rawForCount = stat.size <= PERSISTENCE_LEDGER_MAX_BYTES ? fs.readFileSync(file, "utf8") : "";
    if (stat.size <= PERSISTENCE_LEDGER_MAX_BYTES && rawForCount.split("\\n").filter(Boolean).length <= PERSISTENCE_LEDGER_MAX_ROWS) return;
    const raw = rawForCount || fs.readFileSync(file, "utf8");
    const parsed = [];
    for (const line of raw.split("\\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const row = JSON.parse(s);
        parsed.push({ line: JSON.stringify(row), row });
      } catch (_e) {}
    }
    if (parsed.length <= PERSISTENCE_LEDGER_MAX_ROWS && Buffer.byteLength(raw, "utf8") <= PERSISTENCE_LEDGER_MAX_BYTES) return;
    let keep = selectPersistenceLedgerRows(parsed, PERSISTENCE_LEDGER_MAX_ROWS);
    while (keep.length > 1 && Buffer.byteLength(keep.map((p) => p.line).join("\\n") + "\\n", "utf8") > PERSISTENCE_LEDGER_MAX_BYTES) {
      keep = keep.slice(1);
    }
    const out = keep.map((p) => p.line).join("\\n");
    atomicWriteText(file, out ? out + "\\n" : "");
  } catch (_e) {}
}
function selectPersistenceLedgerRows(parsed, maxRows) {
  const keep = new Set();
  const seenKeys = new Set();
  for (let i = parsed.length - 1; i >= 0 && keep.size < maxRows; i--) {
    const key = persistenceLedgerKey(parsed[i].row);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    keep.add(i);
  }
  for (let i = parsed.length - 1; i >= 0 && keep.size < maxRows; i--) keep.add(i);
  return parsed.filter((_p, i) => keep.has(i));
}
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}
`;

/** Build the per-spawn settings object: a SessionStart hook that records ownership on every session start.
 *  `--settings` is ADDITIVE over user/project/global settings (claude merges), so existing hooks still run.
 *  PURE — HarnessManager writes the returned object + the recorder to disk. */
export function buildOwnershipSettings(
  recorderPath: string,
  agent: string,
  ownersFile: string,
  pointer?: { pointerPath: string; handoffPath: string },
  persistence?: { continuityPointerPath: string; continuityPath: string; stopRecorderPath: string; stopFile: string; failureFile: string },
  opts: {
    skipDangerousModePermissionPrompt?: boolean;
    statusLine?: { type: "command"; command: string; padding?: number };
  } = {},
): {
  hooks: { SessionStart: { matcher?: string; hooks: { type: string; command: string }[] }[]; Stop?: { matcher?: string; hooks: { type: string; command: string }[] }[] };
  skipDangerousModePermissionPrompt?: boolean;
  statusLine?: { type: "command"; command: string; padding?: number };
} {
  const failureArg = persistence ? ` ${q(persistence.failureFile)}` : "";
  const pointerFailureArgs = persistence ? ` ${q(persistence.failureFile)} ${q(agent)}` : "";
  const hooks = [{ type: "command", command: `node ${q(recorderPath)} ${q(agent)} ${q(ownersFile)}${failureArg}` }];
  // spec 245 — a SECOND SessionStart command emits a one-line pointer (additionalContext) to the project
  // handoff when one exists. Additive; claude unions additionalContext across hooks. Never dumps content.
  if (pointer) hooks.push({ type: "command", command: `node ${q(pointer.pointerPath)} ${q(pointer.handoffPath)}${pointerFailureArgs}` });
  if (persistence) hooks.push({ type: "command", command: `node ${q(persistence.continuityPointerPath)} ${q(agent)} ${q(persistence.continuityPath)} ${q(persistence.failureFile)}` });
  const settings: {
    hooks: { SessionStart: { matcher?: string; hooks: { type: string; command: string }[] }[]; Stop?: { matcher?: string; hooks: { type: string; command: string }[] }[] };
    skipDangerousModePermissionPrompt?: boolean;
    statusLine?: { type: "command"; command: string; padding?: number };
  } = { hooks: { SessionStart: [{ matcher: "startup|resume|clear|compact", hooks }] } };
  if (opts.skipDangerousModePermissionPrompt) settings.skipDangerousModePermissionPrompt = true;
  if (opts.statusLine) settings.statusLine = { ...opts.statusLine };
  if (persistence) {
    settings.hooks.Stop = [{ hooks: [{ type: "command", command: `node ${q(persistence.stopRecorderPath)} ${q(agent)} ${q(persistence.stopFile)} ${q(persistence.failureFile)}` }] }];
  }
  return settings;
}

/** Build Codex `-c key=value` override values carrying the same Tachyon lifecycle hooks.
 *  Codex merges this session-scoped override with workspace/user hooks; the agent identity rides in an env var
 *  so the hook command string stays stable across agents in the same workspace. */
export function buildCodexSessionStartHookConfig(
  recorderPath: string,
  ownersFile: string,
  pointer?: { pointerPath: string; handoffPath: string },
  persistence?: { continuityPointerPath: string; continuityPath: string; stopRecorderPath: string; stopFile: string; failureFile: string },
): string | string[] {
  const ownershipHooks = [
    `{type="command",command=${tomlString(`node ${q(recorderPath)} "$TACHYON_AGENT_NAME" ${q(ownersFile)}${persistence ? ` ${q(persistence.failureFile)}` : ""}`)},statusMessage="Recording Tachyon session ownership"}`,
  ];
  const pointerHooks: string[] = [];
  if (pointer) {
    pointerHooks.push(`{type="command",command=${tomlString(`node ${q(pointer.pointerPath)} ${q(pointer.handoffPath)}${persistence ? ` ${q(persistence.failureFile)} "$TACHYON_AGENT_NAME"` : ""}`)},statusMessage="Checking Tachyon project handoff"}`);
  }
  if (persistence) {
    pointerHooks.push(`{type="command",command=${tomlString(`node ${q(persistence.continuityPointerPath)} "$TACHYON_AGENT_NAME" ${q(persistence.continuityPath)} ${q(persistence.failureFile)}`)},statusMessage="Checking Tachyon continuity"}`);
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
  const stop = `hooks.Stop=[{hooks=[{type="command",command=${tomlString(`node ${q(persistence.stopRecorderPath)} "$TACHYON_AGENT_NAME" ${q(persistence.stopFile)} ${q(persistence.failureFile)}`)},statusMessage="Recording Tachyon persistence stop"}]}]`;
  return [start, stop];
}

/** The standalone recorder. Reads the SessionStart hook payload on stdin and appends ONE ownership row.
 *  Self-contained (no Tachyon imports) — run as `node <this> <agent> <ownersFile>` by the injected hook.
 *  Best-effort: any failure is swallowed so a hook error can never block the claude session. */
export const SESSION_OWNER_RECORDER_SOURCE = `// Tachyon session-ownership recorder (spec 243) — materialized; do not edit.
// Invoked by a per-spawn claude SessionStart --settings hook: node <this> <agent> <ownersFile>
const fs = require("fs");
const path = require("path");
let raw = "";
${PERSISTENCE_LEDGER_RETENTION_SOURCE}
function sanitizeReason(e) {
  if (e && e.name === "SyntaxError") return "syntax-error";
  const msg = e && typeof e.message === "string" ? e.message : String(e || "unknown error");
  return msg.replace(/[\\r\\n\\t]+/g, " ").slice(0, 240);
}
function logFailure(file, row) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...row, ts: new Date().toISOString() }) + "\\n");
    prunePersistenceLedger(file);
  } catch (_e) {}
}
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const agent = process.argv[2] || "";
  const out = process.argv[3] || "";
  const failureFile = process.argv[4] || "";
  try {
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
  } catch (e) {
    logFailure(failureFile, { agent, event: "SessionStart", script: "session-owner-record", path: out, reason: sanitizeReason(e) });
    /* best-effort: never block the session on a hook failure */
  }
});
`;

/** The standalone SessionStart handoff-pointer (spec 245). Run as \`node <this> <handoffPath>\`. If a non-trivial
 *  project handoff exists, prints a ONE-LINE additionalContext pointer (NOT the content) so a resuming agent reads
 *  it via get_project_handoff. Silent (no output) when there is no handoff — additive, never a context dump. */
export const SESSION_HANDOFF_POINTER_SOURCE = `// Tachyon project-handoff SessionStart pointer (spec 245) — materialized; do not edit.
// Invoked by a per-spawn claude SessionStart --settings hook: node <this> <handoffPath>
const fs = require("fs");
const path = require("path");
${PERSISTENCE_LEDGER_RETENTION_SOURCE}
function sanitizeReason(e) {
  if (e && e.name === "SyntaxError") return "syntax-error";
  const msg = e && typeof e.message === "string" ? e.message : String(e || "unknown error");
  return msg.replace(/[\\r\\n\\t]+/g, " ").slice(0, 240);
}
function logFailure(file, row) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...row, ts: new Date().toISOString() }) + "\\n");
    prunePersistenceLedger(file);
  } catch (_e) {}
}
try {
  const p = process.argv[2];
  const failureFile = process.argv[3] || "";
  const agent = process.argv[4] || "";
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
} catch (e) {
  if (e && e.code === "ENOENT") process.exit(0);
  logFailure(process.argv[3] || "", { agent: process.argv[4] || "", event: "SessionStart", script: "handoff-pointer", path: process.argv[2] || "", reason: sanitizeReason(e) });
  /* no handoff / unreadable → no pointer */
}
`;

/** SessionStart continuity pointer (spec 312). It is intentionally a pointer, not a context dump: the current
 *  brief remains agent-authored and is read via get_continuity when useful. */
export const SESSION_CONTINUITY_POINTER_SOURCE = `// Tachyon continuity SessionStart pointer (spec 312) — materialized; do not edit.
// Invoked by a per-spawn SessionStart hook: node <this> <agent> <continuityFile>
const fs = require("fs");
const path = require("path");
${PERSISTENCE_LEDGER_RETENTION_SOURCE}
function sanitizeReason(e) {
  if (e && e.name === "SyntaxError") return "syntax-error";
  const msg = e && typeof e.message === "string" ? e.message : String(e || "unknown error");
  return msg.replace(/[\\r\\n\\t]+/g, " ").slice(0, 240);
}
function logFailure(file, row) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...row, ts: new Date().toISOString() }) + "\\n");
    prunePersistenceLedger(file);
  } catch (_e) {}
}
try {
  const agent = process.argv[2];
  const p = process.argv[3];
  const failureFile = process.argv[4] || "";
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
} catch (e) {
  logFailure(process.argv[4] || "", { agent: process.argv[2] || "", event: "SessionStart", script: "continuity-pointer", path: process.argv[3] || "", reason: sanitizeReason(e) });
  /* no continuity / unreadable → no pointer */
}
`;

/** Stop-hook health/cursor recorder (spec 312). It records lifecycle evidence only; it never writes semantic
 *  project-handoff notes and never emits context that would ask the model to continue. */
export const PERSISTENCE_STOP_RECORDER_SOURCE = `// Tachyon persistence Stop recorder (spec 312) — materialized; do not edit.
const fs = require("fs");
const path = require("path");
let raw = "";
${PERSISTENCE_LEDGER_RETENTION_SOURCE}
function sanitizeReason(e) {
  if (e && e.name === "SyntaxError") return "syntax-error";
  const msg = e && typeof e.message === "string" ? e.message : String(e || "unknown error");
  return msg.replace(/[\\r\\n\\t]+/g, " ").slice(0, 240);
}
function logFailure(file, row) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...row, ts: new Date().toISOString() }) + "\\n");
    prunePersistenceLedger(file);
  } catch (_e) {}
}
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const agent = process.argv[2] || "";
  const out = process.argv[3] || "";
  const failureFile = process.argv[4] || "";
  try {
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
    prunePersistenceLedger(out);
  } catch (e) {
    logFailure(failureFile, { agent, event: "Stop", script: "persistence-stop-record", path: out, reason: sanitizeReason(e) });
    /* best-effort: never block the runtime on hook bookkeeping */
  }
});
`;
