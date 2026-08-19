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
import { AGENT_TOKEN_ENV_VAR, URL_ENV_VAR } from "@tachyon/shared/bridge/env.js";

/**
 * One hook group as both runtimes model it. Shaped identically to `plugins/adapters/hooks.ts`'s
 * `HookGroup` on purpose — that module owns validation of untrusted blocks, this one only renders what
 * has already been validated, and duplicating the field list here keeps the activity layer from
 * importing the plugin engine.
 */
export interface OwnershipHookGroup {
  matcher?: string;
  hooks: { type: string; command: string; statusMessage?: string }[];
}

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

/** The materialized recorder the SessionStart hook invokes (`node <recorder> '<json config>'`). */
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

/** The materialized Stop hook recorder (spec 312) — records that a runtime Stop hook fired without fabricating
 *  semantic handoff content or forcing another model turn. */
export function persistenceStopRecorderPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "activity", "persistence-stop-record.cjs");
}

export function runtimeStatusPublisherPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "activity", "runtime-status-publish.cjs");
}

/** Append-only health/cursor ledger for persistence Stop hooks. It is machine-local activity state. */
export function persistenceStopFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "activity", "persistence-stop.jsonl");
}

/** Codex TUI `update_plan` matcher. Regex dialect matches the projected secrets-guard `^Bash$`. */
export const CODEX_UPDATE_PLAN_HOOK_MATCHER = "^update_plan$";

/** Materialized PreToolUse/PostToolUse recorder for Codex TUI plan events (t-17b510). */
export function codexToolHookRecorderPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "activity", "codex-tool-hook-record.cjs");
}

/** Append-only ledger of Codex tool-hook stdin. `toolInput.plan` is kept whole when present. */
export function codexToolHookFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "activity", "codex-tool-hooks.jsonl");
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

function jsonArg(value: unknown): string {
  return q(JSON.stringify(value));
}

/**
 * A TOML basic string. Control characters are ESCAPED rather than passed through: a `-c key=value`
 * override is parsed as TOML, and a raw newline inside a quoted value would end the value and hand the
 * remainder to Codex as config of its own. Tachyon's own commands never contain one; a projected plugin
 * hook command (t-09edf2) comes from the lockfile, so this is the boundary that must not assume.
 */
function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
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
  persistence?: { stopRecorderPath: string; stopFile: string; failureFile: string },
  opts: {
    skipDangerousModePermissionPrompt?: boolean;
    statusLine?: { type: "command"; command: string; padding?: number };
    /** Failure ledger for lifecycle hooks that exist independently of silent persistence. */
    failureFile?: string;
    /**
     * t-09edf2 — event → groups the workspace deliberately projects into THIS session (an installed
     * plugin's `enforcement` gate hook). Merged alongside the lifecycle hooks rather than through them:
     * `--settings` is an additive layer, so this is the one channel every Claude agent reads on every
     * door — including a delegated worktree whose cwd has no `.claude/` tree at all.
     */
    projectedHooks?: Record<string, OwnershipHookGroup[]>;
    /**
     * t-b47fb2 — the end-of-turn notice drain, on the SAME lifecycle Stop channel as the persistence
     * recorder and the runtime-status publisher. It cannot ride `projectedHooks`: that channel skips
     * Stop by design, precisely so a policy change cannot displace the hooks below.
     */
    noticeDrain?: OwnershipHookGroup;
  } = {},
  runtimeStatus?: { publisherPath: string; runtime: "claude" | "grok" },
): {
  hooks: { SessionStart: OwnershipHookGroup[]; Stop?: OwnershipHookGroup[]; [event: string]: OwnershipHookGroup[] | undefined };
  skipDangerousModePermissionPrompt?: boolean;
  statusLine?: { type: "command"; command: string; padding?: number };
} {
  const failureFile = persistence?.failureFile ?? opts.failureFile;
  const hooks = [{ type: "command", command: `node ${q(recorderPath)} ${jsonArg({ agent, out: ownersFile, failureFile: failureFile ?? "" })}` }];
  // spec 245 — a SECOND SessionStart command emits a one-line pointer (additionalContext) to the project
  // handoff when one exists. Additive; claude unions additionalContext across hooks. Never dumps content.
  if (pointer) hooks.push({ type: "command", command: `node ${q(pointer.pointerPath)} ${jsonArg({ path: pointer.handoffPath, failureFile: failureFile ?? "", agent })}` });
  const settings: {
    hooks: { SessionStart: OwnershipHookGroup[]; Stop?: OwnershipHookGroup[]; [event: string]: OwnershipHookGroup[] | undefined };
    skipDangerousModePermissionPrompt?: boolean;
    statusLine?: { type: "command"; command: string; padding?: number };
  } = { hooks: { SessionStart: [{ matcher: "startup|resume|clear|compact", hooks }] } };
  if (opts.skipDangerousModePermissionPrompt) settings.skipDangerousModePermissionPrompt = true;
  if (opts.statusLine) settings.statusLine = { ...opts.statusLine };
  const stopHooks: OwnershipHookGroup["hooks"] = [];
  if (persistence) {
    stopHooks.push({ type: "command", command: `node ${q(persistence.stopRecorderPath)} ${jsonArg({ agent, out: persistence.stopFile, failureFile: persistence.failureFile })}` });
  }
  if (runtimeStatus) {
    stopHooks.push({ type: "command", command: `node ${q(runtimeStatus.publisherPath)} ${q(JSON.stringify({ runtime: runtimeStatus.runtime, failureFile: failureFile ?? "", agent }))}` });
  }
  if (stopHooks.length > 0) {
    settings.hooks.Stop = [{ hooks: stopHooks }];
  }
  // t-b47fb2 — its OWN group rather than another command in the one above, because the two have
  // opposite contracts: everything in `stopHooks` is bookkeeping that must never block, and this one
  // refuses (exit 2) whenever a notice is pending. Keeping them apart means a drain that exits 2 can
  // never be read as the recorder having failed.
  if (opts.noticeDrain) {
    settings.hooks.Stop = [...(settings.hooks.Stop ?? []), opts.noticeDrain];
  }
  // t-09edf2 — projected gate hooks land on their OWN events; SessionStart/Stop are Tachyon's lifecycle
  // channel and are never merged into, so a policy change can neither displace nor duplicate ownership.
  for (const [event, groups] of Object.entries(opts.projectedHooks ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (event === "SessionStart" || event === "Stop" || groups.length === 0) continue;
    settings.hooks[event] = [...(settings.hooks[event] ?? []), ...groups];
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
  persistence?: { stopRecorderPath: string; stopFile: string; failureFile: string },
  /**
   * t-09edf2 — event → groups the workspace deliberately projects into THIS session. Codex has no
   * `--settings` layer, so its equivalent channel is one more `-c hooks.<Event>=[…]` override on the
   * same argv that already carries the lifecycle hooks (and is already covered by the scoped
   * `--dangerously-bypass-hook-trust`). Reaches a delegated worktree, which has no `.codex/hooks.json`.
   */
  projectedHooks?: Record<string, OwnershipHookGroup[]>,
  runtimeStatusPublisher?: string,
  /**
   * t-17b510 — Codex TUI plan channel. Stop closes the window; the plan is on
   * PreToolUse/PostToolUse `tool_name: "update_plan"`. Merged into the same
   * `-c hooks.<Event>=` override as projected gates so a second `-c` cannot
   * replace secrets-guard (or vice versa).
   */
  toolHooks?: { recorderPath: string; file: string; failureFile: string },
  /** t-b47fb2 — the end-of-turn notice drain group, on codex's own `-c hooks.Stop=` lifecycle key. */
  noticeDrain?: OwnershipHookGroup,
): string | string[] {
  const ownershipHooks = [
    `{type="command",command=${tomlString(`node ${q(recorderPath)} ${jsonArg({ agent: "$TACHYON_AGENT_NAME", out: ownersFile, failureFile: persistence?.failureFile ?? "" })}`)},statusMessage="Recording Tachyon session ownership"}`,
  ];
  const pointerHooks: string[] = [];
  if (pointer) {
    pointerHooks.push(`{type="command",command=${tomlString(`node ${q(pointer.pointerPath)} ${jsonArg({ path: pointer.handoffPath, failureFile: persistence?.failureFile ?? "", agent: "$TACHYON_AGENT_NAME" })}`)},statusMessage="Checking Tachyon project handoff"}`);
  }
  const startEntries = [
    `{matcher="startup|resume|clear|compact",hooks=[${ownershipHooks.join(",")}]}`,
  ];
  if (pointerHooks.length > 0) {
    // Codex renders additionalContext in the human-visible pane. Keep ownership on compact, but only emit
    // Handoff pointers appear only at true session boundaries so compaction cannot interrupt the user mid-turn.
    startEntries.push(`{matcher="startup|resume|clear",hooks=[${pointerHooks.join(",")}]}`);
  }
  const start = `hooks.SessionStart=[${startEntries.join(",")}]`;
  const projected = renderCodexProjectedHookConfig(mergeCodexPlanToolHooks(projectedHooks, toolHooks));
  const stopHooks: string[] = [];
  if (persistence) stopHooks.push(`{type="command",command=${tomlString(`node ${q(persistence.stopRecorderPath)} ${jsonArg({ agent: "$TACHYON_AGENT_NAME", out: persistence.stopFile, failureFile: persistence.failureFile })}`)},statusMessage="Recording Tachyon persistence stop"}`);
  if (runtimeStatusPublisher) stopHooks.push(`{type="command",command=${tomlString(`node ${q(runtimeStatusPublisher)} ${q(JSON.stringify({ runtime: "codex", failureFile: "", agent: "$TACHYON_AGENT_NAME" }))}`)},statusMessage="Publishing Tachyon runtime status"}`);
  const drainEntry = noticeDrain
    ? `{hooks=[${noticeDrain.hooks.map((hook) =>
      `{type=${tomlString(hook.type)},command=${tomlString(hook.command)}${hook.statusMessage === undefined ? "" : `,statusMessage=${tomlString(hook.statusMessage)}`}}`).join(",")}]}`
    : undefined;
  if (stopHooks.length === 0 && !drainEntry) return projected.length > 0 ? [start, ...projected] : start;
  // ONE `-c hooks.Stop=` override carries both groups: a second `-c` for the same key REPLACES the
  // first, which is how installing one Stop hook would silently turn the other one off.
  const stopEntries = [
    ...(stopHooks.length > 0 ? [`{hooks=[${stopHooks.join(",")}]}`] : []),
    ...(drainEntry ? [drainEntry] : []),
  ];
  const stop = `hooks.Stop=[${stopEntries.join(",")}]`;
  return [start, stop, ...projected];
}

/**
 * Render each projected event as its own `-c hooks.<Event>=[…]` override.
 *
 * SessionStart/Stop are skipped for the same reason they are on the Claude side: those two are
 * Tachyon's lifecycle channel, and a `-c` override of the same key would REPLACE the ownership hooks
 * rather than join them, silently turning Activity off to install a gate.
 */
function mergeCodexPlanToolHooks(
  projectedHooks: Record<string, OwnershipHookGroup[]> | undefined,
  toolHooks?: { recorderPath: string; file: string; failureFile: string },
): Record<string, OwnershipHookGroup[]> | undefined {
  if (!toolHooks) return projectedHooks;
  const command = `node ${q(toolHooks.recorderPath)} ${jsonArg({ agent: "$TACHYON_AGENT_NAME", out: toolHooks.file, failureFile: toolHooks.failureFile })}`;
  const merged: Record<string, OwnershipHookGroup[]> = { ...(projectedHooks ?? {}) };
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    merged[event] = [
      ...(merged[event] ?? []),
      {
        matcher: CODEX_UPDATE_PLAN_HOOK_MATCHER,
        hooks: [{ type: "command", command, statusMessage: "Recording Tachyon Codex plan" }],
      },
    ];
  }
  return merged;
}

function renderCodexProjectedHookConfig(projectedHooks?: Record<string, OwnershipHookGroup[]>): string[] {
  const out: string[] = [];
  for (const [event, groups] of Object.entries(projectedHooks ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (event === "SessionStart" || event === "Stop" || groups.length === 0) continue;
    const rendered = groups.map((group) => {
      const commands = group.hooks.map((hook) =>
        `{type=${tomlString(hook.type)},command=${tomlString(hook.command)}${hook.statusMessage === undefined ? "" : `,statusMessage=${tomlString(hook.statusMessage)}`}}`);
      const matcher = group.matcher === undefined ? "" : `matcher=${tomlString(group.matcher)},`;
      return `{${matcher}hooks=[${commands.join(",")}]}`;
    });
    out.push(`hooks.${event}=[${rendered.join(",")}]`);
  }
  return out;
}

/** The standalone recorder. Reads the SessionStart hook payload on stdin and appends ONE ownership row.
 *  Self-contained (no Tachyon imports) — run as `node <this> '<json config>'` by the injected hook.
 *  Best-effort: any failure is swallowed so a hook error can never block the claude session. */
export const SESSION_OWNER_RECORDER_SOURCE = `// Tachyon session-ownership recorder (spec 243) — materialized; do not edit.
// Invoked by a per-spawn claude SessionStart --settings hook: node <this> '<json config>'
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
  let config = {};
  try { config = JSON.parse(process.argv[2] || "{}"); } catch (_e) {}
  const agent = config.agent === "$TACHYON_AGENT_NAME"
    ? process.env.TACHYON_AGENT_NAME || ""
    : config.agent || "";
  const out = config.out || process.argv[3] || "";
  const failureFile = config.failureFile || process.argv[4] || "";
  try {
    if (!agent || !out) return;
    const p = JSON.parse(raw || "{}");
    // Claude and Codex use snake_case hook fields. Grok's native hook contract uses camelCase
    // (sessionId, cwd) and does not provide a transcript path. Keep one ledger shape while
    // deriving Grok's deterministic Activity path from its private GROK_HOME.
    const sessionId = p.session_id || p.sessionId || "";
    if (!sessionId) return;
    const cwd = p.cwd || "";
    const transcriptPath = p.transcript_path || p.transcriptPath || (
      process.env.GROK_HOME && cwd
        ? path.join(process.env.GROK_HOME, "sessions", encodeURIComponent(cwd), sessionId, "chat_history.jsonl")
        : ""
    );
    const row = JSON.stringify({
      agent: agent,
      sessionId: sessionId,
      transcriptPath: transcriptPath,
      cwd: cwd,
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

/** The standalone SessionStart handoff-pointer (spec 245). Run as \`node <this> '<json config>'\`. If a non-trivial
 *  project handoff exists, prints a ONE-LINE additionalContext pointer (NOT the content) so a resuming agent reads
 *  it via get_project_handoff. Silent (no output) when there is no handoff — additive, never a context dump. */
export const SESSION_HANDOFF_POINTER_SOURCE = `// Tachyon project-handoff SessionStart pointer (spec 245) — materialized; do not edit.
// Invoked by a per-spawn claude SessionStart --settings hook: node <this> '<json config>'
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
let config = {};
let agent = "";
try {
  try { config = JSON.parse(process.argv[2] || "{}"); } catch (_e) {}
  const p = config.path || process.argv[2];
  const failureFile = config.failureFile || process.argv[3] || "";
  agent = config.agent === "$TACHYON_AGENT_NAME" ? process.env.TACHYON_AGENT_NAME || "" : config.agent || "";
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
  logFailure(config.failureFile || process.argv[3] || "", { agent, event: "SessionStart", script: "handoff-pointer", path: config.path || process.argv[2] || "", reason: sanitizeReason(e) });
  /* no handoff / unreadable → no pointer */
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
  let config = {};
  try { config = JSON.parse(process.argv[2] || "{}"); } catch (_e) {}
  const agent = config.agent === "$TACHYON_AGENT_NAME"
    ? process.env.TACHYON_AGENT_NAME || ""
    : config.agent || "";
  const out = config.out || process.argv[3] || "";
  const failureFile = config.failureFile || process.argv[4] || "";
  try {
    if (!agent || !out) return;
    let payload = {};
    try { payload = JSON.parse(raw || "{}"); } catch (_e) {}
    const row = JSON.stringify({
      agent,
      event: "Stop",
      sessionId: payload.session_id || payload.sessionId || "",
      turnId: payload.turn_id || payload.turnId || "",
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

/** Codex TUI PreToolUse/PostToolUse recorder (t-17b510). Keeps turn_id and the complete
 *  `tool_input` for `update_plan`. Other tools are named only. Observational — no additionalContext. */
export const CODEX_TOOL_HOOK_RECORDER_SOURCE = `// Tachyon Codex tool-hook recorder (t-17b510) — materialized; do not edit.
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
  let config = {};
  try { config = JSON.parse(process.argv[2] || "{}"); } catch (_e) {}
  const agent = config.agent === "$TACHYON_AGENT_NAME"
    ? process.env.TACHYON_AGENT_NAME || ""
    : config.agent || "";
  const out = config.out || process.argv[3] || "";
  const failureFile = config.failureFile || process.argv[4] || "";
  try {
    if (!agent || !out) return;
    let payload = {};
    try { payload = JSON.parse(raw || "{}"); } catch (_e) {}
    const hookEvent = payload.hook_event_name || payload.hook_event || "";
    const toolName = payload.tool_name || payload.toolName || "";
    const toolInput = payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input)
      ? payload.tool_input
      : undefined;
    const row = {
      agent,
      event: hookEvent || "tool",
      sessionId: payload.session_id || payload.sessionId || "",
      turnId: payload.turn_id || payload.turnId || "",
      toolName,
      ts: new Date().toISOString(),
    };
    if (toolName === "update_plan" && toolInput) row.toolInput = toolInput;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.appendFileSync(out, JSON.stringify(row) + "\\n");
    prunePersistenceLedger(out);
  } catch (e) {
    logFailure(failureFile, { agent, event: "tool", script: "codex-tool-hook-record", path: out, reason: sanitizeReason(e) });
    /* best-effort: never block the runtime on hook bookkeeping */
  }
});
`;

/** Best-effort MCP client used by Tachyon-owned native lifecycle hooks. Authentication and agent
 * identity come from the current spawn's environment; the Bridge rejects superseded credentials. */
export const RUNTIME_STATUS_PUBLISHER_SOURCE = `// Tachyon runtime status publisher (t-6b3a0d) — materialized; do not edit.
const fs = require("fs");
const path = require("path");
const url = process.env.${URL_ENV_VAR} || "";
const token = process.env.${AGENT_TOKEN_ENV_VAR} || "";
let config = {};
try { config = JSON.parse(process.argv[2] || "{}"); } catch (_e) {}
const runtime = config.runtime || process.argv[2] || "";
const failureFile = config.failureFile || process.argv[3] || "";
const agent = (config.agent === "$TACHYON_AGENT_NAME" ? process.env.TACHYON_AGENT_NAME : config.agent) || process.argv[4] || "";
${PERSISTENCE_LEDGER_RETENTION_SOURCE}
function sanitizeReason(e) {
  const msg = e && typeof e.message === "string" ? e.message : String(e || "unknown error");
  return msg.replace(/[\\r\\n\\t]+/g, " ").slice(0, 240);
}
function logFailure(reason) {
  if (!failureFile) return;
  try {
    fs.mkdirSync(path.dirname(failureFile), { recursive: true });
    fs.appendFileSync(failureFile, JSON.stringify({ agent, event: "Stop", script: "runtime-status-publish", path: url, reason: sanitizeReason(reason), ts: new Date().toISOString() }) + "\\n");
    prunePersistenceLedger(failureFile);
  } catch (_e) {}
}
const baseHeaders = { "content-type": "application/json", "accept": "application/json, text/event-stream", "authorization": "Bearer " + token };
async function post(body, sessionId) {
  const headers = sessionId ? { ...baseHeaders, "mcp-session-id": sessionId } : baseHeaders;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
}
(async () => {
  if (!url || !token || !["claude", "codex", "grok"].includes(runtime)) throw new Error("runtime status hook environment is incomplete");
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "tachyon-runtime-hook", version: "1" } } });
  const sessionId = init.headers.get("mcp-session-id") || "";
  if (!init.ok) {
    let body = "";
    try { body = await init.text(); } catch (_e) {}
    throw new Error("runtime status hook initialize HTTP failed: " + init.status + " " + init.statusText + (body ? "; body=" + body : ""));
  }
  if (!sessionId) throw new Error("runtime status hook initialize succeeded without mcp-session-id: " + init.status + " " + init.statusText);
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  const publish = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "runtime_status_publish", arguments: { event: "stopped", runtime } } }, sessionId);
  if (!publish.ok) throw new Error("runtime status hook publish failed");
})().catch(logFailure);
`;
