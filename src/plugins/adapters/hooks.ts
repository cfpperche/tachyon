/**
 * spec 250 — the hooks-map core shared by the claude + codex adapters. claude (`.claude/settings.json`) and
 * codex (`.codex/hooks.json`) carry the SAME native hooks structure — `{ hooks: { <Event>: [ { matcher?,
 * hooks: [ { type:"command", command, statusMessage? } ] } ] } }` — so the merge/un-merge logic is genuinely
 * identical and lives here once. This is NOT a cross-runtime abstraction over things that differ; it is the
 * shared parity between two runtimes whose hook config happens to be the same shape. Each adapter parametrizes
 * only what actually differs: its config file, its known event set, and whether it accepts `statusMessage`.
 *
 * Un-merge is CONTENT-BASED via the lockfile (no inline marker): merge returns the exact groups written; the
 * lockfile records them; un-merge removes by count-aware canonical deep-equal, leaving a user-edited group as
 * a conservative orphan. Pure + fail-closed throughout.
 *
 * spec 321 (debate p-763d4b) — ${TACHYON_PLUGIN_ROOT} renders to the plugin's ABSOLUTE materialized root,
 * wrapped for cwd-independence: runtimes run hook commands via `sh -c` in a cwd Tachyon doesn't control, so
 * a relative root silently disarmed gate hooks after a mere `cd` (claude treats exit 127 as non-blocking).
 */

import { isSafeAbsolutePluginRoot } from "../paths.js";

/** The placeholder a plugin author writes in a hook command; rewritten to the plugin's materialized root. */
export const PLUGIN_ROOT_PLACEHOLDER = "${TACHYON_PLUGIN_ROOT}";

/**
 * spec 321 (debate p-763d4b) — hook events that GATE an action: a broken gate must BLOCK (exit 2), never
 * silently pass. Everything else is observational and fails open (a missing plugin must not brick the
 * session). Per-hook `failurePolicy` metadata is a deliberate v2 follow-up; v1 classifies by event.
 */
export const FAIL_CLOSED_HOOK_EVENTS: ReadonlySet<string> = new Set(["PreToolUse"]);

const MAX_BLOCK_BYTES = 64 * 1024;
const MAX_GROUPS_PER_EVENT = 64;
const MAX_CMDS_PER_GROUP = 32;
const MAX_STR = 4096;

export interface HookCommand {
  type: "command";
  command: string;
  /** codex-only optional progress label; preserved verbatim when the adapter allows it. */
  statusMessage?: string;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

/** A validated hooks block: event → groups (the INNER map a plugin's `<runtime>/hooks.json` carries). */
export type HooksBlock = Record<string, HookGroup[]>;

/** The exact groups Tachyon wrote, per event — returned by merge, persisted to the lockfile, replayed to un-merge. */
export type OwnedHooks = Record<string, HookGroup[]>;

/**
 * The subset of a runtime's hook config this core touches. Hook-group elements stay OPAQUE (`unknown`) so a
 * user's arbitrary-but-valid groups are preserved byte-for-byte; only Tachyon's own groups are matched for
 * removal. Other config keys (e.g. claude's `model`) pass through untouched.
 */
export interface HookSettings {
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
  hooks?: HooksBlock;
  errors: string[];
}

export interface BlockParseOptions {
  /** the runtime's known hook events; an unknown event key fails closed. */
  knownEvents: ReadonlySet<string>;
  /** whether a hook command may carry a `statusMessage` (codex yes, claude no). */
  allowStatusMessage: boolean;
  /** label for error messages, e.g. "claude" / "codex". */
  label: string;
}

/**
 * Parse + validate a plugin's `<runtime>/hooks.json` (UNTRUSTED): the inner event→groups map. Fail-closed,
 * error-accumulating; rejects unknown events, malformed groups/commands, and oversized input. Never throws.
 */
export function parseHooksBlock(rawJson: string, opts: BlockParseOptions): BlockParseResult {
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
  const out: HooksBlock = Object.create(null);

  for (const [event, groupsRaw] of Object.entries(parsed)) {
    if (!opts.knownEvents.has(event)) {
      errors.push(`hooks: '${event}' is not a known ${opts.label} hook event`);
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
        const cmd: HookCommand = { type: "command", command: h.command };
        if (h.statusMessage !== undefined) {
          // fail-closed (not lossy-drop): a statusMessage on a runtime that doesn't model it is a likely authoring error.
          if (!opts.allowStatusMessage) {
            errors.push(`hooks.${event}[${gi}].hooks[${hi}].statusMessage: not supported for ${opts.label} hooks`);
            cmdOk = false;
            return;
          }
          if (typeof h.statusMessage !== "string" || h.statusMessage.length > MAX_STR) {
            errors.push(`hooks.${event}[${gi}].hooks[${hi}].statusMessage: must be a string`);
            cmdOk = false;
            return;
          }
          cmd.statusMessage = h.statusMessage;
        }
        group.hooks.push(cmd);
      });
      if (cmdOk) groups.push(group);
    });
    if (groups.length > 0) out[event] = groups;
  }

  if (errors.length > 0) return { errors };
  return { hooks: { ...out }, errors: [] };
}

export interface OwnedHooksParseResult {
  owned?: OwnedHooks;
  errors: string[];
}

/** Validate an `OwnedHooks` record read back from the lockfile target's opaque `removal` (UNTRUSTED w.r.t. a
 *  hand-edited lockfile). Fail-closed so a corrupt lockfile can never make removal iterate a non-array. */
export function parseOwnedHooks(raw: unknown): OwnedHooksParseResult {
  if (!isPlainObject(raw)) return { errors: ["removal: must be an object of event → groups"] };
  const errors: string[] = [];
  const owned: OwnedHooks = Object.create(null);
  for (const [event, groupsRaw] of Object.entries(raw)) {
    if (!Array.isArray(groupsRaw)) {
      errors.push(`removal.${event}: must be an array`);
      continue;
    }
    const groups: HookGroup[] = [];
    groupsRaw.forEach((g, gi) => {
      if (!isPlainObject(g) || !Array.isArray(g.hooks) || g.hooks.length === 0) {
        errors.push(`removal.${event}[${gi}]: must be a group with a non-empty hooks list`);
        return;
      }
      const group: HookGroup = { hooks: [] };
      if (typeof g.matcher === "string") group.matcher = g.matcher;
      let ok = true;
      g.hooks.forEach((h) => {
        if (!isPlainObject(h) || h.type !== "command" || typeof h.command !== "string") { ok = false; return; }
        const cmd: HookCommand = { type: "command", command: h.command };
        if (typeof h.statusMessage === "string") cmd.statusMessage = h.statusMessage;
        group.hooks.push(cmd);
      });
      if (ok) groups.push(group);
    });
    if (groups.length > 0) owned[event] = groups;
  }
  if (errors.length > 0) return { errors };
  return { owned: { ...owned }, errors: [] };
}

export interface SettingsParseResult {
  settings?: HookSettings;
  errors: string[];
}

/** Validate the on-disk hook config shape without touching group internals (preserve the user's groups).
 *  Fail-closed: a `hooks` that isn't an object, or a `hooks[event]` that isn't an array, is corruption. */
export function normalizeHookSettings(raw: unknown): SettingsParseResult {
  if (raw === undefined || raw === null) return { settings: {}, errors: [] };
  if (!isPlainObject(raw)) return { errors: ["settings: must be a JSON object"] };
  if (raw.hooks !== undefined) {
    if (!isPlainObject(raw.hooks)) return { errors: ["settings.hooks: must be an object"] };
    for (const [event, groups] of Object.entries(raw.hooks)) {
      if (!Array.isArray(groups)) return { errors: [`settings.hooks.${event}: must be an array`] };
    }
  }
  return { settings: JSON.parse(JSON.stringify(raw)) as HookSettings, errors: [] };
}

function resolveCommand(command: string, pluginRoot: string): string {
  return command.split(PLUGIN_ROOT_PLACEHOLDER).join(pluginRoot);
}

/**
 * spec 321 — render a placeholder-using hook command with its cwd-independence wrapper. The runtime already
 * executes hook commands via `sh -c`, so the wrapper is a flat multi-statement string (no extra shell layer):
 * a missing plugin root blocks (gate) or skips (observational) with a clear stderr note, and on gates an
 * inner exit 127 ("command not found" — claude treats it as a NON-blocking hook error, the exact silent-pass
 * hole this spec closes) is remapped to the blocking 2 while every other inner exit code passes through.
 * `absRoot` is safe to embed by construction (isSafeAbsolutePluginRoot — no whitespace/quotes/metachars).
 */
function wrapResolved(event: string, resolved: string, absRoot: string): string {
  const missing = `[tachyon] plugin hook root missing: ${absRoot}`;
  if (FAIL_CLOSED_HOOK_EVENTS.has(event)) {
    return (
      `if [ ! -d "${absRoot}" ]; then echo "${missing} — blocking (fail-closed gate hook)" >&2; exit 2; fi; ` +
      `${resolved}; rc=$?; ` +
      `if [ "$rc" -eq 127 ]; then echo "[tachyon] plugin hook command not found (exit 127) — blocking (fail-closed gate hook)" >&2; exit 2; fi; exit "$rc"`
    );
  }
  return `if [ ! -d "${absRoot}" ]; then echo "${missing} — skipping (fail-open hook)" >&2; exit 0; fi; ${resolved}`;
}

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
  if (insertAt === -1) insertAt = kept.length;
  return { kept, insertAt, removed };
}

function pruneHooks(settings: HookSettings): HookSettings {
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

export interface MergeResult {
  settings?: HookSettings;
  owned?: OwnedHooks;
  events?: string[];
  errors: string[];
}

/** Merge a validated hooks block into a settings object, idempotently + order-preserving (see file header).
 *  spec 321 — `pluginRoot` is the plugin's ABSOLUTE materialized root; placeholder-using commands render
 *  through the cwd-independence wrapper (fail-closed for gate events, fail-open otherwise). */
export function mergeHooks(rawSettings: unknown, block: HooksBlock, pluginRoot: string, prior?: OwnedHooks): MergeResult {
  if (!isSafeAbsolutePluginRoot(pluginRoot)) return { errors: [`pluginRoot '${pluginRoot}' is not a safe absolute path`] };
  const norm = normalizeHookSettings(rawSettings);
  if (!norm.settings) return { errors: norm.errors };
  const settings = norm.settings;
  const hooks: Record<string, unknown[]> = isPlainObject(settings.hooks) ? (settings.hooks as Record<string, unknown[]>) : {};

  const owned: OwnedHooks = {};
  for (const [event, groups] of Object.entries(block)) {
    owned[event] = groups.map((g) => ({
      ...(g.matcher !== undefined ? { matcher: g.matcher } : {}),
      hooks: g.hooks.map((h) => ({
        type: "command" as const,
        // A command that never references the plugin root has no root dependency — written verbatim.
        command: h.command.includes(PLUGIN_ROOT_PLACEHOLDER)
          ? wrapResolved(event, resolveCommand(h.command, pluginRoot), pluginRoot)
          : h.command,
        ...(h.statusMessage !== undefined ? { statusMessage: h.statusMessage } : {}),
      })),
    }));
  }

  const events = new Set<string>([...Object.keys(prior ?? {}), ...Object.keys(owned)]);
  for (const event of events) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    const priorGroups = Array.isArray(prior?.[event]) ? (prior![event] as HookGroup[]) : [];
    const { kept, insertAt } = removeMatching(current, priorGroups);
    const toInsert = owned[event] ?? [];
    if (toInsert.length > 0) kept.splice(insertAt, 0, ...toInsert);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }

  settings.hooks = hooks;
  return { settings: pruneHooks(settings), owned, events: Object.keys(owned), errors: [] };
}

export interface RemoveResult {
  settings?: HookSettings;
  removed?: number;
  expected?: number;
  errors: string[];
}

/** Remove the groups recorded in `owned` (from the lockfile) — content-based, count-aware, order-preserving.
 *  `removed < expected` signals conservative orphans (user-edited groups left, never deleted). */
export function removeHooks(rawSettings: unknown, owned: OwnedHooks): RemoveResult {
  const norm = normalizeHookSettings(rawSettings);
  if (!norm.settings) return { errors: norm.errors };
  const settings = norm.settings;
  let expected = 0;
  for (const groups of Object.values(owned)) if (Array.isArray(groups)) expected += groups.length;
  if (!isPlainObject(settings.hooks)) return { settings, removed: 0, expected, errors: [] };
  const hooks = settings.hooks as Record<string, unknown[]>;

  let removed = 0;
  for (const [event, groups] of Object.entries(owned)) {
    if (!Array.isArray(hooks[event]) || !Array.isArray(groups)) continue;
    const r = removeMatching(hooks[event], groups);
    removed += r.removed;
    if (r.kept.length > 0) hooks[event] = r.kept;
    else delete hooks[event];
  }
  return { settings: pruneHooks(settings), removed, expected, errors: [] };
}
