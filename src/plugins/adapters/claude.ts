/**
 * spec 250 Step 2 — the claude runtime adapter (pure logic half). Merges a plugin's claude hooks block
 * into the workspace `.claude/settings.json` `hooks` map, idempotently, and removes EXACTLY what it wrote.
 * Pure (no fs) so the merge/un-merge invariants are unit-testable; the Step-3 engine supplies/writes the
 * on-disk settings + persists the returned `owned` groups into the lockfile.
 *
 * Un-merge strategy = CONTENT-BASED via the lockfile, NOT an inline marker. materialize() returns the exact
 * groups it wrote (`owned`); the engine stores them in the lockfile target's `removal`. un-merge removes the
 * groups that deep-equal those recorded groups (count-aware, order-preserving). Consequences:
 *  - Tachyon writes PURE claude hook groups (no extra field) → no dependency on claude tolerating a marker.
 *  - A group the user has since hand-edited no longer matches → it is left as a conservative orphan, never
 *    deleted. Tachyon never removes a hook it did not write verbatim.
 *
 * v1 scope = HOOKS (`claude/hooks.json`, the INNER event→groups map — documented + tested as intentional,
 * not the full settings block). Skills (dir copy) + MCP (`.mcp.json` merge) are the next increments here.
 */

import { isSafePluginRoot } from "../paths.js";

/** The placeholder a plugin author writes in a hook command; rewritten to the plugin's materialized
 *  payload root. Authors MUST quote it (`"${TACHYON_PLUGIN_ROOT}"/x.sh`); Tachyon generates a metachar-free
 *  root, but quoting is the contract so a future root change can't break the shell. */
export const PLUGIN_ROOT_PLACEHOLDER = "${TACHYON_PLUGIN_ROOT}";

/** Claude hook events this adapter accepts in a plugin block. Unknown keys fail closed (typo-catching). */
export const CLAUDE_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "UserPromptSubmit",
  "SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
]);

const MAX_BLOCK_BYTES = 64 * 1024;
const MAX_GROUPS_PER_EVENT = 64;
const MAX_CMDS_PER_GROUP = 32;
const MAX_STR = 4096;

export interface HookCommand {
  type: "command";
  command: string;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

/** A validated claude hooks block: event → groups (the INNER map of `claude/hooks.json`). */
export type ClaudeHooksBlock = Record<string, HookGroup[]>;

/** The exact groups Tachyon wrote, per event — returned by merge, persisted to the lockfile, replayed to un-merge. */
export type OwnedHooks = Record<string, HookGroup[]>;

/**
 * The subset of `.claude/settings.json` this adapter touches. Hook-group elements are kept OPAQUE (`unknown`)
 * so the user's arbitrary-but-claude-valid groups (e.g. with extra fields) are preserved byte-for-byte; only
 * Tachyon's own groups (which we know the shape of) are matched for removal. Other settings keys pass through.
 */
export interface ClaudeSettings {
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Stable, key-sorted serialization for structural deep-equality (independent of key order). */
function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export interface BlockParseResult {
  hooks?: ClaudeHooksBlock;
  errors: string[];
}

/**
 * Parse + validate a plugin's `claude/hooks.json` (UNTRUSTED): the inner event→groups map. Fail-closed,
 * error-accumulating; rejects unknown events, malformed groups/commands, and oversized input. Never throws.
 */
export function parseClaudeHooksBlock(rawJson: string): BlockParseResult {
  if (typeof rawJson !== "string" || Buffer.byteLength(rawJson, "utf8") > MAX_BLOCK_BYTES) {
    return { errors: [`hooks block: empty or exceeds ${MAX_BLOCK_BYTES} bytes`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return { errors: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!isPlainObject(parsed)) return { errors: ["hooks block: must be a JSON object of event → groups"] };

  const errors: string[] = [];
  const out: ClaudeHooksBlock = Object.create(null);

  for (const [event, groupsRaw] of Object.entries(parsed)) {
    if (!CLAUDE_HOOK_EVENTS.has(event)) {
      errors.push(`hooks: '${event}' is not a known claude hook event`);
      continue;
    }
    if (!Array.isArray(groupsRaw) || groupsRaw.length === 0) {
      errors.push(`hooks.${event}: must be a non-empty list of hook groups`);
      continue;
    }
    if (groupsRaw.length > MAX_GROUPS_PER_EVENT) {
      errors.push(`hooks.${event}: too many groups`);
      continue;
    }
    const groups: HookGroup[] = [];
    groupsRaw.forEach((g, gi) => {
      if (!isPlainObject(g)) {
        errors.push(`hooks.${event}[${gi}]: must be an object`);
        return;
      }
      const group: HookGroup = { hooks: [] };
      if (g.matcher !== undefined) {
        if (typeof g.matcher !== "string" || g.matcher.length > MAX_STR) {
          errors.push(`hooks.${event}[${gi}].matcher: must be a string`);
          return;
        }
        group.matcher = g.matcher;
      }
      if (!Array.isArray(g.hooks) || g.hooks.length === 0 || g.hooks.length > MAX_CMDS_PER_GROUP) {
        errors.push(`hooks.${event}[${gi}].hooks: must be a non-empty list of commands`);
        return;
      }
      let cmdOk = true;
      g.hooks.forEach((h, hi) => {
        if (!isPlainObject(h) || h.type !== "command" || typeof h.command !== "string" || h.command.trim().length === 0 || h.command.length > MAX_STR) {
          errors.push(`hooks.${event}[${gi}].hooks[${hi}]: must be { type: "command", command: <non-empty string> }`);
          cmdOk = false;
          return;
        }
        group.hooks.push({ type: "command", command: h.command });
      });
      if (cmdOk) groups.push(group);
    });
    if (groups.length > 0) out[event] = groups;
  }

  if (errors.length > 0) return { errors };
  return { hooks: { ...out }, errors: [] };
}

export interface SettingsParseResult {
  settings?: ClaudeSettings;
  errors: string[];
}

/**
 * Validate the on-disk `.claude/settings.json` shape THIS adapter relies on, without touching group
 * internals (the user's groups stay opaque/preserved). Fail-closed: a `hooks` that isn't an object, or a
 * `hooks[event]` that isn't an array, is a real corruption the engine must surface — not silently overwrite.
 * `undefined`/`null` (no settings file yet) normalizes to `{}`.
 */
export function normalizeClaudeSettings(raw: unknown): SettingsParseResult {
  if (raw === undefined || raw === null) return { settings: {}, errors: [] };
  if (!isPlainObject(raw)) return { errors: ["settings: must be a JSON object"] };
  if (raw.hooks !== undefined) {
    if (!isPlainObject(raw.hooks)) return { errors: ["settings.hooks: must be an object"] };
    for (const [event, groups] of Object.entries(raw.hooks)) {
      if (!Array.isArray(groups)) return { errors: [`settings.hooks.${event}: must be an array`] };
    }
  }
  // structural clone so callers never mutate the input (settings is JSON-compatible by construction).
  return { settings: JSON.parse(JSON.stringify(raw)) as ClaudeSettings, errors: [] };
}

/** Rewrite the ${TACHYON_PLUGIN_ROOT} placeholder in a command to the plugin's materialized payload root. */
function resolveCommand(command: string, pluginRoot: string): string {
  return command.split(PLUGIN_ROOT_PLACEHOLDER).join(pluginRoot);
}

/**
 * Remove, from `arr`, the elements that deep-equal a group in `toRemove`, count-aware (each recorded group
 * consumes at most one array element) and order-preserving. Returns the surviving elements + the index where
 * the first removal happened (the insertion point for an in-place re-apply; `kept.length` if none removed).
 */
function removeMatching(arr: unknown[], toRemove: HookGroup[]): { kept: unknown[]; insertAt: number; removed: number } {
  const budget = new Map<string, number>();
  for (const g of toRemove) budget.set(canon(g), (budget.get(canon(g)) ?? 0) + 1);
  const kept: unknown[] = [];
  let insertAt = -1;
  let removed = 0;
  for (const el of arr) {
    const c = canon(el);
    const left = budget.get(c) ?? 0;
    if (left > 0) {
      budget.set(c, left - 1);
      if (insertAt === -1) insertAt = kept.length;
      removed++;
    } else {
      kept.push(el);
    }
  }
  if (insertAt === -1) insertAt = kept.length; // nothing removed → append position
  return { kept, insertAt, removed };
}

function pruneHooks(settings: ClaudeSettings): ClaudeSettings {
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

export interface MergeResult {
  settings?: ClaudeSettings;
  /** the exact groups written, per event — persist to the lockfile target's `removal` for un-merge. */
  owned?: OwnedHooks;
  /** the hook events touched (lockfile target refs). */
  events?: string[];
  errors: string[];
}

/**
 * Merge a plugin's validated claude hooks block into a settings object, idempotently. Removes the plugin's
 * PRIOR groups (passed from the lockfile) in place, then inserts the freshly root-resolved groups at the same
 * position — preserving the user's surrounding hook order. Pure + fail-closed (returns errors on a malformed
 * settings object or an unsafe plugin root); never mutates the input.
 */
export function mergePluginHooks(rawSettings: unknown, block: ClaudeHooksBlock, pluginRoot: string, prior?: OwnedHooks): MergeResult {
  if (!isSafePluginRoot(pluginRoot)) return { errors: [`pluginRoot '${pluginRoot}' is not a safe contained path`] };
  const norm = normalizeClaudeSettings(rawSettings);
  if (!norm.settings) return { errors: norm.errors };
  const settings = norm.settings;
  const hooks: Record<string, unknown[]> = isPlainObject(settings.hooks) ? (settings.hooks as Record<string, unknown[]>) : {};

  // owned = the resolved groups we will write, per event.
  const owned: OwnedHooks = {};
  for (const [event, groups] of Object.entries(block)) {
    owned[event] = groups.map((g) => ({
      ...(g.matcher !== undefined ? { matcher: g.matcher } : {}),
      hooks: g.hooks.map((h) => ({ type: "command" as const, command: resolveCommand(h.command, pluginRoot) })),
    }));
  }

  // process every event that the prior install OR the new block touches (an updated plugin may drop an event).
  const events = new Set<string>([...Object.keys(prior ?? {}), ...Object.keys(owned)]);
  for (const event of events) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    const { kept, insertAt } = removeMatching(current, prior?.[event] ?? []);
    const toInsert = owned[event] ?? [];
    if (toInsert.length > 0) kept.splice(insertAt, 0, ...toInsert);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }

  settings.hooks = hooks;
  return { settings: pruneHooks(settings), owned, events: Object.keys(owned), errors: [] };
}

export interface RemoveResult {
  settings?: ClaudeSettings;
  removed?: number;
  errors: string[];
}

/**
 * Remove the groups recorded in `owned` (from the lockfile) from a settings object — content-based,
 * count-aware, order-preserving. Never touches a group the user has since edited (it no longer matches).
 * Pure + fail-closed.
 */
export function removePluginHooks(rawSettings: unknown, owned: OwnedHooks): RemoveResult {
  const norm = normalizeClaudeSettings(rawSettings);
  if (!norm.settings) return { errors: norm.errors };
  const settings = norm.settings;
  if (!isPlainObject(settings.hooks)) return { settings, removed: 0, errors: [] };
  const hooks = settings.hooks as Record<string, unknown[]>;

  let removed = 0;
  for (const [event, groups] of Object.entries(owned)) {
    if (!Array.isArray(hooks[event])) continue;
    const r = removeMatching(hooks[event], groups);
    removed += r.removed;
    if (r.kept.length > 0) hooks[event] = r.kept;
    else delete hooks[event];
  }
  return { settings: pruneHooks(settings), removed, errors: [] };
}
