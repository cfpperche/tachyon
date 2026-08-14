/**
 * SDD 476 — Codex's effective-model evidence, and the private home that makes collecting it safe.
 *
 * `codex exec --json` prints no model identity (measured on codex-cli 0.145.0; see the spec's notes).
 * The identity Codex *does* record is `turn_context.payload.model`, inside the session rollout at
 * `$CODEX_HOME/sessions/**​/rollout-<ts>-<session_id>.jsonl`. The probe used to pass `--ephemeral`
 * precisely so no rollout was written, trading provenance for isolation. This module buys both: the
 * probe gets its OWN Codex home under the run's scratch dir, so nothing is written to the human's
 * `~/.codex`, and the rollout it does write is correlated to this exact run before being deleted.
 *
 * The correlation is exact or absent — never a heuristic. `thread.started` gives the session id; the
 * rollout filename must end in that id; the file's own `session_meta` must repeat it. Zero matches,
 * two matches, two different ids, or a file that disagrees with its own name all mean NO evidence, so
 * the run reads `unproven` under SDD 473 rather than borrowing a model from a neighbouring file. That
 * is the whole point: inferring the model from the newest rollout, the cost, or the requested name
 * would reintroduce the silent fallback SDD 473 exists to catch.
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** The per-run private home's directory name — also the guard that keeps teardown from deleting anything else. */
export const PRIVATE_HOME_DIRNAME = "codex-home";

/** A session id has to be usable as a filename suffix; anything else is refused rather than globbed. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
/** `sessions/<year>/<month>/<day>/rollout-*.jsonl` is three levels; allow a little slack, not a full tree walk. */
const MAX_SESSION_DEPTH = 6;
/** Bound the directory walk so a surprising tree can't turn interpretation into a filesystem crawl. */
const MAX_SESSION_ENTRIES = 2000;
/**
 * A probe rollout is a handful of KB. Past this we refuse rather than read a prefix: a partial read
 * could miss a later turn that switched models, and half the turns is not evidence about the run.
 */
const MAX_ROLLOUT_BYTES = 8 * 1024 * 1024;

/** What the rollout could be made to say about this run — or precisely why it could not. */
export interface CodexSessionEvidence {
  /** the session/thread id the stream reported, when exactly one was reported. */
  sessionId?: string;
  /** every distinct model the correlated rollout recorded across its turns, sorted. */
  models?: string[];
  /** why there is no usable evidence; recorded so an `unproven` run can say what was missing. */
  unavailable?: string;
}

/**
 * The single `thread_id` this run's stdout reported. Absent, malformed, or more than one distinct id
 * are all the same answer — we do not know which session is ours, so we have no evidence.
 */
export function parseThreadId(stdout: string): { sessionId?: string; unavailable?: string } {
  const ids = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes("thread.started")) continue;
    let rec: { type?: unknown; thread_id?: unknown };
    try {
      rec = JSON.parse(trimmed) as typeof rec;
    } catch {
      continue; // a truncated or interleaved line is not a claim about the session id
    }
    if (rec.type !== "thread.started") continue;
    if (typeof rec.thread_id === "string" && rec.thread_id.trim()) ids.add(rec.thread_id.trim());
  }
  if (ids.size === 0) return { unavailable: "codex reported no thread.started event, so no session could be correlated" };
  if (ids.size > 1) {
    return { unavailable: `codex reported ${ids.size} distinct thread ids, so no single session could be correlated` };
  }
  const sessionId = [...ids][0]!;
  if (!SAFE_SESSION_ID.test(sessionId)) {
    return { unavailable: "codex reported a thread id that is not a safe session identifier" };
  }
  return { sessionId };
}

/**
 * Every model the rollout recorded for this session, in sorted order.
 *
 * The file must identify itself as the expected session — the filename is a convenience, not the
 * proof — and every `turn_context` counts. A session whose second turn ran a different model reports
 * both, which {@link resolveModelProof} then reads as a mismatch: a run that used the requested model
 * AND another one is not clean proof that the requested one produced the answer.
 */
export function modelsFromRollout(text: string, expectedSessionId: string): { models?: string[]; unavailable?: string } {
  let sawMeta = false;
  const models = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: { type?: unknown; payload?: unknown };
    try {
      rec = JSON.parse(trimmed) as typeof rec;
    } catch {
      continue; // a partial trailing line never invalidates records already read
    }
    const payload = (rec.payload ?? {}) as Record<string, unknown>;
    if (rec.type === "session_meta") {
      const id = typeof payload.session_id === "string" ? payload.session_id : typeof payload.id === "string" ? payload.id : "";
      if (id !== expectedSessionId) {
        return { unavailable: "the correlated rollout identifies a different session than the run reported" };
      }
      sawMeta = true;
      continue;
    }
    if (rec.type === "turn_context" && typeof payload.model === "string" && payload.model.trim()) {
      models.add(payload.model.trim());
    }
  }
  if (!sawMeta) return { unavailable: "the correlated rollout carries no session_meta, so it cannot confirm it is this run" };
  if (models.size === 0) return { unavailable: "the correlated rollout recorded no turn_context model" };
  return { models: [...models].sort() };
}

/** Recursively list rollout files under a sessions root, bounded in depth and count. */
async function listRollouts(root: string, depth = 0, budget = { left: MAX_SESSION_ENTRIES }): Promise<string[]> {
  if (depth > MAX_SESSION_DEPTH || budget.left <= 0) return [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return []; // no sessions tree at all is an ordinary "no evidence", not an error
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (budget.left-- <= 0) break;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listRollouts(full, depth + 1, budget)));
    } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * The one rollout belonging to this session. Two candidates is as unusable as none: picking either
 * would be a guess, and a guess is what this whole path exists to avoid.
 */
export async function findRolloutFile(sessionsRoot: string, sessionId: string): Promise<{ file?: string; unavailable?: string }> {
  const suffix = `-${sessionId}.jsonl`;
  const matches = (await listRollouts(sessionsRoot)).filter((file) => path.basename(file).endsWith(suffix));
  if (matches.length === 0) return { unavailable: "no session rollout was written for this run's thread id" };
  if (matches.length > 1) return { unavailable: `${matches.length} rollouts claim this run's thread id, so none can be trusted` };
  return { file: matches[0]! };
}

/**
 * Correlate the run's stdout to the rollout inside its private home and read the models out of it.
 * Never throws: every failure becomes an `unavailable` reason, because a probe result must survive
 * the absence of its own provenance — it just must not be readable as proven.
 */
export async function collectCodexSessionEvidence(codexHome: string, stdout: string): Promise<CodexSessionEvidence> {
  const { sessionId, unavailable } = parseThreadId(stdout);
  if (!sessionId) return { unavailable };
  const located = await findRolloutFile(path.join(codexHome, "sessions"), sessionId);
  if (!located.file) return { sessionId, unavailable: located.unavailable };
  let text: string;
  try {
    const stat = await fs.stat(located.file);
    if (stat.size > MAX_ROLLOUT_BYTES) {
      return { sessionId, unavailable: "the correlated rollout is too large to read exhaustively, so its turns cannot all be checked" };
    }
    text = await fs.readFile(located.file, "utf8");
  } catch {
    return { sessionId, unavailable: "the correlated rollout could not be read" };
  }
  const parsed = modelsFromRollout(text, sessionId);
  return parsed.models ? { sessionId, models: parsed.models } : { sessionId, unavailable: parsed.unavailable };
}

/** The Codex home the HUMAN uses — the source of the credential, and the tree we must never write to. */
export function humanCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  return configured ? configured : path.join(os.homedir(), ".codex");
}

/**
 * Create this run's private Codex home and make the credential reachable inside it.
 *
 * `codex exec --help`: "`--ignore-user-config` — Do not load `$CODEX_HOME/config.toml`; auth still
 * uses `CODEX_HOME`". So a relocated home needs `auth.json`, and it gets a SYMLINK rather than a
 * copy: no secret bytes are duplicated, and a token refresh writes through to the real file. A
 * missing `auth.json` is not an error — an API-key setup authenticates from the inherited env.
 */
export async function prepareCodexHome(scratchDir: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const home = path.join(scratchDir, PRIVATE_HOME_DIRNAME);
  await fs.mkdir(home, { recursive: true });
  const source = path.join(humanCodexHome(env), "auth.json");
  try {
    await fs.access(source);
    await fs.symlink(source, path.join(home, "auth.json"));
  } catch {
    /* no credential file to link (API-key auth, or a link that already exists) — proceed */
  }
  return home;
}

/**
 * Remove a private home. Guarded on the directory NAME rather than trusting the path handed in, so a
 * tampered or unexpected `CODEX_HOME` can never turn teardown into deleting someone's real home.
 */
export async function removeCodexHome(home: string | undefined): Promise<void> {
  if (!home || path.basename(home) !== PRIVATE_HOME_DIRNAME) return;
  await fs.rm(home, { recursive: true, force: true });
}
