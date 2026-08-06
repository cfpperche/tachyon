/**
 * SDD 486 A2 — the APPLIED record: which of an installed plugin's contributions are currently
 * materialized into this workspace.
 *
 * It is a SECOND fact, not a field on the first. `plugins.lock.json` records what was FETCHED — its
 * `integrity.payload` hashes upstream bytes and deliberately drifts once a human edits the payload
 * (spec 270). Applied-state is a human toggle with a different author, a different lifetime and a
 * different reversal (un-apply keeps the payload; uninstall does not). One file answering two
 * questions with two lifetimes is how a reload resurrects a skill somebody switched off, so the two
 * live apart.
 *
 * LOCAL by decision (spec.md, resolved 2026-08-03): Tachyon state does not travel in the repo, so
 * this file sits under `.tachyon/` and a fresh clone applies NOTHING. Note that `.gitignore` closes
 * `.tachyon/` as a directory and re-opens nothing by name — files under it that are in the repo were
 * force-added one at a time by hand. Nothing here relies on a `!` rule, because there is none.
 *
 * ABSENCE IS THE ANSWER, and it is the answer in both directions:
 *  - a contribution recorded here is applied; anything else is not. There is no third "undecided"
 *    state, which is what makes an un-applied contribution impossible to resurrect by reload — the
 *    record is authoritative and never derived from what happens to be on disk.
 *  - a MISSING file means nothing is applied (a fresh clone, or a workspace from before this record
 *    existed). That is the decided default, not a degraded one.
 *
 * A file that is present but unreadable or malformed is an ERROR, never an empty state. Reading a
 * hand-corrupted record as "nothing applied" would tell a human every switch is off while the
 * materializations are still on disk and still reaching every agent — the exact inversion this spec
 * exists to end.
 *
 * Pure parse/serialize plus a small store; the materialization engine (A3/A4) owns the I/O that
 * writes skills and hooks, and reconciles this record against a plugin's manifest when it changes.
 */

import path from "node:path";
import { readFile, atomicWrite } from "./fsx.js";

/** Workspace-relative location. A SIBLING of `.tachyon/plugins/`, never inside it: that directory is
 *  keyed by plugin name, and a file dropped among those entries would be a name a plugin could take. */
export const APPLIED_STATE_REL_PATH = ".tachyon/plugins-applied.json";

/** Bounds on a file a human may hand-edit. Generous against real use, closed against a garbage file. */
const MAX_PLUGINS = 512;
const MAX_CONTRIBUTIONS_PER_PLUGIN = 1024;
const MAX_FILE_BYTES = 1024 * 1024;

/** plugin names: lowercase kebab, as `manifest.ts` validates them. */
const PLUGIN_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** skill contribution names: lowercase kebab — a skill name IS its directory name (`skill.ts`). */
const SKILL_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** hook contribution names: a runtime hook EVENT, e.g. `PreToolUse` (the adapters' PascalCase sets). */
const HOOK_EVENT_RE = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * The two projected kinds Phase A covers. `mcp-server` is Phase C and `view` is out by decision
 * (spec.md § Non-goals), so neither is spellable here — an id naming one fails to parse rather than
 * being recorded as a fact nothing can honour.
 */
export type ContributionKind = "skill" | "hook";

/**
 * One independently applicable thing a plugin ships. Runtime-agnostic ON PURPOSE: `apply` fans out to
 * every runtime the plugin declares (plan.md, key decision), so the human's answer is "this
 * contribution, in this workspace" and never "this contribution, for Codex but not Claude".
 *
 * The granularity matches what a removal can name. A `skill-dir` target is identified by its skill
 * name and a `settings-hook` target by its event (`engine.ts:1248` records `ref: event`), so
 * `{kind, name}` resolves to exactly the lockfile targets an un-apply must undo, in every runtime.
 */
export interface ContributionRef {
  kind: ContributionKind;
  /** a skill's kebab name, or a hook's event name. */
  name: string;
}

export class AppliedStateError extends Error {}

/** The stable string identity used as the on-disk key: `skill:<name>` / `hook:<Event>`. */
export function contributionId(ref: ContributionRef): string {
  return `${ref.kind}:${ref.name}`;
}

/** Parse an on-disk id back to a ref, validating the name against its kind. Null when malformed. */
export function parseContributionId(id: unknown): ContributionRef | null {
  if (typeof id !== "string") return null;
  const sep = id.indexOf(":");
  if (sep < 0) return null;
  const kind = id.slice(0, sep);
  const name = id.slice(sep + 1);
  if (kind === "skill") return SKILL_NAME_RE.test(name) ? { kind: "skill", name } : null;
  if (kind === "hook") return HOOK_EVENT_RE.test(name) ? { kind: "hook", name } : null;
  return null;
}

export function contributionRefsEqual(a: ContributionRef, b: ContributionRef): boolean {
  return a.kind === b.kind && a.name === b.name;
}

export interface AppliedState {
  schemaVersion: 1;
  /** plugin name → the contribution ids currently applied, deduped and sorted. An absent plugin key
   *  and an empty list mean the same thing: nothing of that plugin is applied. */
  plugins: Record<string, string[]>;
}

export function emptyAppliedState(): AppliedState {
  return { schemaVersion: 1, plugins: {} };
}

/** Stable, pretty, newline-terminated JSON. Sorted so repeated writes of the same state are byte-identical. */
export function serializeAppliedState(state: AppliedState): string {
  const plugins: Record<string, string[]> = {};
  for (const name of Object.keys(state.plugins).sort()) {
    plugins[name] = [...state.plugins[name]].sort();
  }
  return `${JSON.stringify({ schemaVersion: 1, plugins }, null, 2)}\n`;
}

export interface AppliedStateParseResult {
  state?: AppliedState;
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse + validate an applied record from raw JSON text. Fail-closed; never throws. */
export function parseAppliedState(rawJson: string): AppliedStateParseResult {
  if (typeof rawJson !== "string" || Buffer.byteLength(rawJson, "utf8") > MAX_FILE_BYTES) {
    return { errors: [`applied record: empty or exceeds ${MAX_FILE_BYTES} bytes`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return { errors: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!isPlainObject(parsed)) return { errors: ["applied record: must be a JSON object"] };
  if (parsed.schemaVersion !== 1) return { errors: ["applied.schemaVersion: must be 1"] };
  if (!isPlainObject(parsed.plugins)) return { errors: ["applied.plugins: must be an object"] };

  const errors: string[] = [];
  const entries = Object.entries(parsed.plugins);
  if (entries.length > MAX_PLUGINS) errors.push(`applied.plugins: at most ${MAX_PLUGINS} plugins`);

  const plugins: Record<string, string[]> = {};
  for (const [name, raw] of entries) {
    if (!PLUGIN_NAME_RE.test(name)) {
      errors.push(`applied.plugins.${name}: not a valid plugin name (lowercase kebab-case)`);
      continue;
    }
    if (!Array.isArray(raw)) {
      errors.push(`applied.plugins.${name}: must be a list of contribution ids`);
      continue;
    }
    if (raw.length > MAX_CONTRIBUTIONS_PER_PLUGIN) {
      errors.push(`applied.plugins.${name}: at most ${MAX_CONTRIBUTIONS_PER_PLUGIN} contributions`);
      continue;
    }
    const seen = new Set<string>();
    raw.forEach((id, i) => {
      const ref = parseContributionId(id);
      if (!ref) {
        errors.push(`applied.plugins.${name}[${i}]: '${String(id)}' is not a contribution id (skill:<kebab> | hook:<Event>)`);
        return;
      }
      seen.add(contributionId(ref));
    });
    plugins[name] = [...seen].sort();
  }

  if (errors.length > 0) return { errors };
  return { state: { schemaVersion: 1, plugins }, errors: [] };
}

/**
 * The workspace's applied record. Every mutation reads, changes and atomically rewrites the whole
 * file — the record is small, and a partial write is the one failure mode that could leave a
 * contribution materialized with nothing claiming it.
 */
export class AppliedStateStore {
  constructor(private readonly workspaceRoot: string) {}

  file(): string {
    return path.join(this.workspaceRoot, APPLIED_STATE_REL_PATH);
  }

  /**
   * Read the record. A genuinely absent file (ENOENT) is the empty state — the decided default for a
   * fresh clone. Anything else — unreadable, malformed, wrong schema — THROWS: an install that cannot
   * read this record must refuse, not proceed as if every switch were off.
   */
  read(): AppliedState {
    const r = readFile(this.file());
    if (r.missing) return emptyAppliedState();
    if (r.error !== undefined) throw new AppliedStateError(`${APPLIED_STATE_REL_PATH}: ${r.error}`);
    const { state, errors } = parseAppliedState(r.text as string);
    if (!state) throw new AppliedStateError(`${APPLIED_STATE_REL_PATH} is corrupt — fix or delete it: ${errors.join("; ")}`);
    return state;
  }

  write(state: AppliedState): void {
    atomicWrite(this.file(), serializeAppliedState(state));
  }

  isApplied(plugin: string, ref: ContributionRef): boolean {
    return (this.read().plugins[plugin] ?? []).includes(contributionId(ref));
  }

  /** Everything currently applied for one plugin, sorted. Empty for an unknown plugin. */
  appliedFor(plugin: string): ContributionRef[] {
    return (this.read().plugins[plugin] ?? []).map(parseContributionId).filter((r): r is ContributionRef => r !== null);
  }

  /** Record a contribution as applied. Idempotent — applying twice writes the same bytes. */
  markApplied(plugin: string, ref: ContributionRef): void {
    if (!PLUGIN_NAME_RE.test(plugin)) throw new AppliedStateError(`'${plugin}' is not a valid plugin name`);
    const id = contributionId(ref);
    if (!parseContributionId(id)) throw new AppliedStateError(`'${id}' is not a valid contribution id`);
    const state = this.read();
    const current = state.plugins[plugin] ?? [];
    if (current.includes(id)) return;
    this.write({ ...state, plugins: { ...state.plugins, [plugin]: [...current, id].sort() } });
  }

  /** Record a contribution as no longer applied. Idempotent, and never resurrects on the next read. */
  markUnapplied(plugin: string, ref: ContributionRef): void {
    const id = contributionId(ref);
    const state = this.read();
    const current = state.plugins[plugin];
    if (!current || !current.includes(id)) return;
    const rest = current.filter((x) => x !== id);
    const plugins = { ...state.plugins };
    if (rest.length === 0) delete plugins[plugin]; // an empty list and an absent key mean the same thing
    else plugins[plugin] = rest;
    this.write({ ...state, plugins });
  }

  /**
   * Drop a plugin's whole entry — what UNINSTALL owes this record.
   *
   * Without it the residue has a shape this repo has paid for before (`t-17d885`): the roster entry
   * goes and an authority keyed by the same name stays, so re-installing the plugin later would find
   * its contributions already marked applied and materialize things the human never re-chose.
   */
  forgetPlugin(plugin: string): void {
    const state = this.read();
    if (!(plugin in state.plugins)) return;
    const plugins = { ...state.plugins };
    delete plugins[plugin];
    this.write({ ...state, plugins });
  }
}
