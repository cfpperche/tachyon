import { createHash } from "node:crypto";
import { isAlias, isScalar, parseDocument, stringify, visit, YAMLMap, YAMLSeq } from "yaml";

/**
 * UI-driven mutations over tachyon.yml. The FILE stays the source of truth —
 * these are pure text→text transforms built on yaml's Document API, which
 * preserves the user's comments and formatting everywhere outside the mutated
 * entry. No parallel state, ever: hand-editing and UI editing stay equivalent.
 */

import { AGENT_NAME_PATTERN } from "./nameValidation.js";

export interface EditResult {
  text: string;
  /** human-relevant side effects, e.g. layouts that lost their last agent */
  warnings: string[];
}

function load(text: string) {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(`tachyon.yml is not parseable: ${doc.errors[0].message}`);
  }
  return doc;
}

/** spec 215 — the two blocks that hold managed entries; both merge into one kind-tagged record. */
type Section = "agents" | "terminals";

function mapOf(doc: ReturnType<typeof parseDocument>, section: Section): YAMLMap | undefined {
  const node = doc.get(section);
  return node instanceof YAMLMap ? node : undefined;
}

/** Which block currently holds `name` — for edits/deletes/renames that must act in place. */
function sectionOf(doc: ReturnType<typeof parseDocument>, name: string): Section | undefined {
  if (doc.hasIn(["agents", name])) return "agents";
  if (doc.hasIn(["terminals", name])) return "terminals";
  return undefined;
}

/** Total declared entries across both blocks — the "can't delete the last one" guard. */
function entryCount(doc: ReturnType<typeof parseDocument>): number {
  return (mapOf(doc, "agents")?.items.length ?? 0) + (mapOf(doc, "terminals")?.items.length ?? 0);
}

/** A `terminals:` entry must not carry AI-only fields (kind is implied; no AI) — strip them. */
function sanitizeForSection(section: Section, entry: Record<string, unknown>): Record<string, unknown> {
  if (section !== "terminals") return entry;
  const { kind: _kind, instructions: _instructions, soul: _soul, selfEvolution: _selfEvolution, ...rest } = entry;
  return rest;
}

function assertValidName(name: string): void {
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error(`invalid agent name '${name}' (must match ${AGENT_NAME_PATTERN})`);
  }
}

export function addAgent(
  text: string | undefined,
  name: string,
  cmd: string,
  kind?: "agent" | "terminal",
  instructions?: string,
): EditResult {
  assertValidName(name);
  if (!cmd || cmd.trim().length === 0) throw new Error("cmd must be a non-empty command");
  const entry: Record<string, unknown> = { cmd };
  if (kind) entry.kind = kind;
  if (instructions && instructions.trim().length > 0) entry.instructions = instructions.trim();
  if (text === undefined || text.trim().length === 0) {
    // No tachyon.yml yet — create a minimal one.
    return { text: stringify({ agents: { [name]: entry } }), warnings: [] };
  }
  const doc = load(text);
  if (sectionOf(doc, name)) throw new Error(`agent '${name}' already exists`); // spec 215 — across BOTH blocks (one namespace)
  doc.setIn(["agents", name], doc.createNode(entry));
  return { text: String(doc), warnings: [] };
}

/**
 * Creates or replaces an agent entry with a full definition (the Agent Studio path).
 * `entry` carries only non-default fields — the form decides what's worth writing,
 * keeping ymls clean. On edit (`replaceName`), the entry is rewritten in place;
 * a rename via the form is replaceName + new key (layout refs updated like renameAgent).
 */
export function upsertAgent(
  text: string | undefined,
  name: string,
  entry: Record<string, unknown>,
  replaceName?: string,
  section: Section = "agents",
): EditResult {
  assertValidName(name);
  if (typeof entry.cmd !== "string" || entry.cmd.trim().length === 0) {
    throw new Error("cmd must be a non-empty command");
  }
  if (text === undefined || text.trim().length === 0) {
    return { text: stringify({ [section]: { [name]: sanitizeForSection(section, entry) } }), warnings: [] };
  }
  const doc = load(text);
  const warnings: string[] = [];

  // An EDIT acts in the entry's CURRENT block; a CREATE uses the caller-selected section.
  let target: Section = section;
  if (replaceName !== undefined) {
    const cur = sectionOf(doc, replaceName);
    if (!cur) throw new Error(`agent '${replaceName}' does not exist`);
    target = cur;
  }

  if (replaceName !== undefined && replaceName !== name) {
    // form-driven rename: the new name must be free in BOTH blocks; drop the old key.
    if (sectionOf(doc, name)) throw new Error(`agent '${name}' already exists`);
    doc.deleteIn([target, replaceName]);
    // spec 234 — layout-ref update removed (layouts feature retired).
  } else if (replaceName === undefined && sectionOf(doc, name)) {
    throw new Error(`agent '${name}' already exists`);
  }

  doc.setIn([target, name], doc.createNode(sanitizeForSection(target, entry)));
  return { text: String(doc), warnings };
}

/** Create or replace a one-shot command entry (Agent Studio's Command tab). */
export function upsertCommand(
  text: string | undefined,
  name: string,
  entry: Record<string, unknown>,
  replaceName?: string,
): EditResult {
  assertValidName(name);
  if (typeof entry.cmd !== "string" || entry.cmd.trim().length === 0) {
    throw new Error("cmd must be a non-empty command");
  }
  if (text === undefined || text.trim().length === 0) {
    throw new Error("create an agent first — commands need an existing tachyon.yml");
  }
  const doc = load(text);
  if (replaceName !== undefined && replaceName !== name) {
    if (!doc.hasIn(["commands", replaceName])) throw new Error(`command '${replaceName}' does not exist`);
    if (doc.hasIn(["commands", name])) throw new Error(`command '${name}' already exists`);
    doc.deleteIn(["commands", replaceName]);
  } else if (replaceName === undefined && doc.hasIn(["commands", name])) {
    throw new Error(`command '${name}' already exists`);
  }
  doc.setIn(["commands", name], doc.createNode(entry));
  return { text: String(doc), warnings: [] };
}

/** Removes a command; warns about runbooks that referenced it (they fall back to inline). */
export function deleteCommand(text: string, name: string): EditResult {
  const doc = load(text);
  if (!doc.hasIn(["commands", name])) throw new Error(`command '${name}' does not exist`);
  doc.deleteIn(["commands", name]);
  const warnings: string[] = [];
  const runbooks = doc.get("runbooks");
  if (runbooks instanceof YAMLMap) {
    for (const pair of runbooks.items) {
      const rbName = String((pair.key as { toJSON?: () => unknown }).toJSON?.() ?? pair.key);
      const steps = doc.getIn(["runbooks", rbName, "steps"]);
      if (steps instanceof YAMLSeq && (steps.toJSON() as string[]).includes(name)) {
        warnings.push(`runbook '${rbName}' referenced '${name}' — that step now runs as inline shell`);
      }
    }
  }
  return { text: String(doc), warnings };
}

/** 0-based line of a command's entry. */
export function commandEntryLine(text: string, name: string): number | undefined {
  return entryLineIn(text, "commands", name);
}

/** Create or replace a runbook entry (Agent Studio's Runbook tab). */
export function upsertRunbook(
  text: string | undefined,
  name: string,
  entry: { steps: unknown },
  replaceName?: string,
): EditResult {
  assertValidName(name);
  if (!Array.isArray(entry.steps) || entry.steps.length === 0) {
    throw new Error("steps must be a non-empty list");
  }
  if (text === undefined || text.trim().length === 0) {
    throw new Error("create an agent first — runbooks need an existing tachyon.yml");
  }
  const doc = load(text);
  if (replaceName !== undefined && replaceName !== name) {
    if (!doc.hasIn(["runbooks", replaceName])) throw new Error(`runbook '${replaceName}' does not exist`);
    if (doc.hasIn(["runbooks", name])) throw new Error(`runbook '${name}' already exists`);
    doc.deleteIn(["runbooks", replaceName]);
  } else if (replaceName === undefined && doc.hasIn(["runbooks", name])) {
    throw new Error(`runbook '${name}' already exists`);
  }
  doc.setIn(["runbooks", name], doc.createNode(entry));
  return { text: String(doc), warnings: [] };
}

/** Removes a runbook. Nothing references runbooks, so no cross-warnings. */
export function deleteRunbook(text: string, name: string): EditResult {
  const doc = load(text);
  if (!doc.hasIn(["runbooks", name])) throw new Error(`runbook '${name}' does not exist`);
  doc.deleteIn(["runbooks", name]);
  return { text: String(doc), warnings: [] };
}

/** 0-based line of a runbook's entry. */
export function runbookEntryLine(text: string, name: string): number | undefined {
  return entryLineIn(text, "runbooks", name);
}

/** Create or replace a schedule entry (approving an agent proposal, or the Studio). */
export function upsertSchedule(
  text: string | undefined,
  name: string,
  entry: Record<string, unknown>,
  overwrite = false,
): EditResult {
  assertValidName(name);
  if (text === undefined || text.trim().length === 0) {
    throw new Error("create an agent first — schedules need an existing tachyon.yml");
  }
  const doc = load(text);
  if (!overwrite && doc.hasIn(["schedules", name])) throw new Error(`schedule '${name}' already exists`);
  doc.setIn(["schedules", name], doc.createNode(entry));
  return { text: String(doc), warnings: [] };
}

/** Removes a schedule. */
export function deleteSchedule(text: string, name: string): EditResult {
  const doc = load(text);
  if (!doc.hasIn(["schedules", name])) throw new Error(`schedule '${name}' does not exist`);
  doc.deleteIn(["schedules", name]);
  return { text: String(doc), warnings: [] };
}

/**
 * SDD 414 — set settings.companion.tabTools (human Control toggle).
 * Requires an existing tachyon.yml (agents already declared).
 * Persists explicit true/false so the opt-in is visible in the file.
 */
export function setCompanionTabTools(text: string | undefined, enabled: boolean): EditResult {
  if (text === undefined || text.trim().length === 0) {
    throw new Error("create an agent first — Companion settings need an existing tachyon.yml");
  }
  const doc = load(text);
  doc.setIn(["settings", "companion", "tabTools"], enabled);
  return { text: String(doc), warnings: [] };
}

/**
 * SDD 422 — set settings.companion.lanAccess (mobile Companion via Tailscale).
 * Persists explicit true/false so the opt-in is visible in tachyon.yml.
 */
export function setCompanionLanAccess(text: string | undefined, enabled: boolean): EditResult {
  if (text === undefined || text.trim().length === 0) {
    throw new Error("create an agent first — Companion settings need an existing tachyon.yml");
  }
  const doc = load(text);
  doc.setIn(["settings", "companion", "lanAccess"], enabled);
  return { text: String(doc), warnings: [] };
}

/**
 * SDD 420 — set settings.companion.allowedHosts (Control Settings).
 * Empty list removes the key (all hosts still under confirm rules).
 * Hosts are trimmed, de-duped; invalid empty entries dropped.
 */
export function setCompanionAllowedHosts(text: string | undefined, hosts: string[]): EditResult {
  if (text === undefined || text.trim().length === 0) {
    throw new Error("create an agent first — Companion settings need an existing tachyon.yml");
  }
  const cleaned = [
    ...new Set(
      hosts
        .map((h) => h.trim())
        .filter((h) => h.length > 0 && h.length <= 253),
    ),
  ];
  const doc = load(text);
  if (cleaned.length === 0) {
    if (doc.hasIn(["settings", "companion", "allowedHosts"])) {
      doc.deleteIn(["settings", "companion", "allowedHosts"]);
    }
  } else {
    doc.setIn(["settings", "companion", "allowedHosts"], cleaned);
  }
  return { text: String(doc), warnings: [] };
}

/**
 * t-585d5c — write `settings.agentNotifications.idleAfterMinutes` from Control → Settings.
 *
 * `undefined` REMOVES the key instead of writing the default number, so a workspace reset to the
 * default is indistinguishable from one that never configured it. That is what lets the UI honestly
 * say "using the default" rather than show a number nobody chose.
 *
 * Validation is deliberately NOT repeated here: the runtime-api operation that reaches this is the
 * gate, and a second rule at this layer is how two validators come to disagree.
 */
export function setIdleAfterMinutes(text: string | undefined, minutes: number | "never" | undefined): EditResult {
  if (text === undefined || text.trim().length === 0) {
    throw new Error("create an agent first — notification settings need an existing tachyon.yml");
  }
  const doc = load(text);
  if (minutes === undefined) {
    if (doc.hasIn(["settings", "agentNotifications", "idleAfterMinutes"])) {
      doc.deleteIn(["settings", "agentNotifications", "idleAfterMinutes"]);
    }
  } else {
    doc.setIn(["settings", "agentNotifications", "idleAfterMinutes"], minutes);
  }
  return { text: String(doc), warnings: [] };
}

/**
 * t-aaad95 — write a `settings.<path>` value during the one-time import of the retired VS Code keys.
 *
 * Generic on purpose, unlike the hand-written `setCompanion*` setters above: this is one migration
 * writing a fixed, closed list of paths that `planYmlImport` decides, so a setter per key would be
 * six near-identical functions that all go away together. Validation stays where it already is —
 * `loadConfig` refuses anything malformed on the next read, and the planner only ever emits values
 * that already passed its own checks.
 */
export function setSettingsValue(text: string | undefined, keyPath: string[], value: string | number | boolean | string[]): EditResult {
  if (text === undefined || text.trim().length === 0) {
    throw new Error("create an agent first — settings need an existing tachyon.yml");
  }
  if (keyPath.length === 0) throw new Error("setSettingsValue needs a key path under 'settings'");
  const doc = load(text);
  doc.setIn(["settings", ...keyPath], value);
  return { text: String(doc), warnings: [] };
}

/** 0-based line of a schedule's entry. */
export function scheduleEntryLine(text: string, name: string): number | undefined {
  return entryLineIn(text, "schedules", name);
}

function entryLineIn(text: string, section: string, name: string): number | undefined {
  const doc = load(text);
  const map = doc.get(section);
  if (!(map instanceof YAMLMap)) return undefined;
  const node = map.items.find(
    (pair) => String((pair.key as { toJSON?: () => unknown }).toJSON?.() ?? pair.key) === name,
  );
  const offset = (node?.key as { range?: [number, number, number] })?.range?.[0];
  if (offset === undefined) return undefined;
  return text.slice(0, offset).split("\n").length - 1;
}

// spec 234 — upsertLayout removed (layouts feature retired).

export function cloneAgent(text: string, source: string, newName: string): EditResult {
  assertValidName(newName);
  const doc = load(text);
  const section = sectionOf(doc, source); // clone within the source's block (a terminal clones to a terminal)
  if (!section) throw new Error(`agent '${source}' does not exist`);
  if (sectionOf(doc, newName)) throw new Error(`agent '${newName}' already exists`);
  // Values are copied faithfully; comments inside the cloned block are not.
  const node = doc.getIn([section, source], true);
  const plain = (node as { toJSON?: () => unknown }).toJSON?.() ?? node;
  doc.setIn([section, newName], doc.createNode(plain));
  return { text: String(doc), warnings: [] };
}

/**
 * t-17d885 — settings lists that grant authority BY AGENT NAME.
 *
 * `canMutateLinkedGitDelivery` decides by `principals.includes(caller.name)`, so a name left here
 * after its agent is gone is a grant waiting for a homonym: create an agent with that exact name
 * later — through the governed door, innocently — and it silently inherits an authority nobody gave
 * it. Removing the `agents:` stanza alone never closed that, which is how this workspace ended up
 * listing three principals (`hermes`, `codex`, `codex-canonico`) that no longer exist.
 *
 * Add any future name-keyed settings allowlist here rather than at its own call site.
 */
const AGENT_PRINCIPAL_LISTS: ReadonlyArray<readonly [string, string]> = [
  ["gitDelivery", "prunePrincipals"],
  ["gitDelivery", "integratePrincipals"],
];

/** Drop `name` from every name-keyed principal list, or rewrite it when `to` is given. */
function reconcileAgentPrincipals(doc: ReturnType<typeof parseDocument>, name: string, to?: string): void {
  for (const [block, key] of AGENT_PRINCIPAL_LISTS) {
    const seq = doc.getIn(["settings", block, key], true);
    if (!(seq instanceof YAMLSeq)) continue;
    // Rebuild from plain values: the list is a flat scalar allowlist, so preserving node identity
    // buys nothing and `createNode` keeps the file's existing flow/block style.
    const current = seq.items.map((item) => String((item as { toJSON?: () => unknown }).toJSON?.() ?? item));
    const next = to === undefined
      ? current.filter((principal) => principal !== name)
      // Dedupe: renaming onto a name already present must not list it twice.
      : [...new Set(current.map((principal) => (principal === name ? to : principal)))];
    if (next.length === current.length && next.every((principal, index) => principal === current[index])) continue;
    doc.setIn(["settings", block, key], doc.createNode(next));
  }
}

export function deleteAgent(text: string, name: string): EditResult {
  const doc = load(text);
  const section = sectionOf(doc, name);
  if (!section) throw new Error(`agent '${name}' does not exist`);
  if (entryCount(doc) <= 1) {
    throw new Error(
      `'${name}' is the last agent — a tachyon.yml needs at least one (delete the file itself to deactivate Tachyon here)`,
    );
  }
  doc.deleteIn([section, name]);
  // Drop a now-empty block so we never leave a bare `terminals: {}` / `agents: {}` behind.
  if (mapOf(doc, section)?.items.length === 0) doc.deleteIn([section]);
  reconcileAgentPrincipals(doc, name);

  // spec 234 — layout-ref cleanup removed (layouts feature retired).
  const warnings: string[] = [];
  return { text: String(doc), warnings };
}

export function renameAgent(text: string, oldName: string, newName: string): EditResult {
  assertValidName(newName);
  const doc = load(text);
  const section = sectionOf(doc, oldName);
  if (!section) throw new Error(`agent '${oldName}' does not exist`);
  if (sectionOf(doc, newName)) throw new Error(`agent '${newName}' already exists`);

  const node = doc.getIn([section, oldName], true);
  const plain = (node as { toJSON?: () => unknown }).toJSON?.() ?? node;
  doc.deleteIn([section, oldName]);
  doc.setIn([section, newName], doc.createNode(plain));
  // t-17d885 — the grant follows the agent. Leaving the old name would strand it for a homonym AND
  // silently strip the renamed agent of an authority it had a second ago.
  reconcileAgentPrincipals(doc, oldName, newName);

  // spec 234 — layout-ref update removed (layouts feature retired).
  const warnings: string[] = [];
  return { text: String(doc), warnings };
}

/** 0-based line of an agent/terminal's entry — lets "Edit" open tachyon.yml at the right place. */
export function agentEntryLine(text: string, name: string): number | undefined {
  const doc = load(text);
  const section = sectionOf(doc, name);
  const node = section
    ? mapOf(doc, section)?.items.find(
        (pair) => String((pair.key as { toJSON?: () => unknown }).toJSON?.() ?? pair.key) === name,
      )
    : undefined;
  const offset = (node?.key as { range?: [number, number, number] })?.range?.[0];
  if (offset === undefined) return undefined;
  return text.slice(0, offset).split("\n").length - 1;
}

/**
 * spec 377 T15A — CAS token for one affected agent stanza only.
 * Unrelated `tachyon.yml` edits outside this stanza do not change the token.
 */
export interface AgentStanzaCasToken {
  present: boolean;
  soulEnabled: boolean;
  /** sha256 of the stable JSON form of the agent entry; null when absent. */
  hash: string | null;
}

export function agentStanzaCasToken(text: string | undefined, name: string): AgentStanzaCasToken {
  if (text === undefined || text.trim().length === 0) {
    return { present: false, soulEnabled: false, hash: null };
  }
  const doc = load(text);
  const section = sectionOf(doc, name);
  if (!section) return { present: false, soulEnabled: false, hash: null };
  const plain = doc.getIn([section, name]) as unknown;
  const json = (plain as { toJSON?: () => unknown })?.toJSON?.() ?? plain;
  if (json === undefined || json === null) return { present: false, soulEnabled: false, hash: null };
  const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const soulEnabled = record.soul === true;
  const hash = createHash("sha256").update(JSON.stringify(record)).digest("hex");
  return { present: true, soulEnabled, hash };
}

/**
 * Set or clear only `soul` on a declared agent entry. Used by journaled profile
 * enable/disable so recovery can CAS the affected stanza without rewriting the form.
 * Disabled normalizes to field absence (T14).
 */
export function setAgentSoulEnablement(
  text: string | undefined,
  name: string,
  enabled: boolean,
): EditResult {
  assertValidName(name);
  if (text === undefined || text.trim().length === 0) {
    throw new Error(`agent '${name}' does not exist`);
  }
  const doc = load(text);
  const section = sectionOf(doc, name);
  if (!section) throw new Error(`agent '${name}' does not exist`);
  if (section === "terminals") throw new Error(`soul is not valid on terminal '${name}'`);
  const node = doc.getIn([section, name]);
  if (!(node instanceof YAMLMap) && (typeof node !== "object" || node === null)) {
    throw new Error(`agent '${name}' has an unexpected shape`);
  }
  if (enabled) {
    doc.setIn([section, name, "soul"], true);
  } else {
    doc.deleteIn([section, name, "soul"]);
  }
  return { text: String(doc), warnings: [] };
}

export interface AgentStanzaSourceSlice {
  section: "agents";
  name: string;
  valueStart: number;
  valueEnd: number;
  valueText: string;
  valueSha256: string;
}

/**
 * Capture one plain agent mapping by exact source range. Migration rejects
 * aliases/anchors/merge keys because they make single-owner replacement
 * ambiguous even when YAML could resolve them to an object.
 */
export function agentStanzaSourceSlice(text: string, name: string): AgentStanzaSourceSlice {
  assertValidName(name);
  const doc = parseDocument(text, { uniqueKeys: true, keepSourceTokens: true });
  if (doc.errors.length > 0) throw new Error(`tachyon.yml is not parseable: ${doc.errors[0]!.message}`);
  if (doc.hasIn(["terminals", name])) throw new Error(`terminal '${name}' cannot be migrated to an agent profile`);
  const agents = doc.get("agents", true);
  if (!(agents instanceof YAMLMap)) throw new Error("'agents' must be a mapping");
  const pair = agents.items.find((entry) => isScalar(entry.key) && entry.key.value === name);
  if (!pair) throw new Error(`agent '${name}' does not exist`);
  const value = pair.value;
  if (!(value instanceof YAMLMap)) throw new Error(`agents.${name}: must be a plain mapping`);
  if (value.anchor) throw new Error(`agents.${name}: anchors are not supported by canonical profile pointers`);
  if (value.items.some((entry) => isScalar(entry.key) && entry.key.value === "<<")) {
    throw new Error(`agents.${name}: YAML merge keys are not supported by canonical profile pointers`);
  }
  let alias = false;
  visit(value, (_key, node) => {
    if (isAlias(node)) alias = true;
  });
  if (alias) throw new Error(`agents.${name}: aliases are not supported by canonical profile pointers`);
  const range = value.range;
  if (!range || range.length < 3) throw new Error(`agents.${name}: source range is unavailable`);
  const valueStart = range[0];
  const valueEnd = range[2];
  const valueText = text.slice(valueStart, valueEnd);
  return {
    section: "agents",
    name,
    valueStart,
    valueEnd,
    valueText,
    valueSha256: createHash("sha256").update(valueText).digest("hex"),
  };
}

export function replaceAgentStanzaValue(
  text: string,
  name: string,
  expectedValueSha256: string,
  replacement: string,
): { text: string; prior: AgentStanzaSourceSlice; next: AgentStanzaSourceSlice } {
  if (replacement.length === 0 || !replacement.endsWith("\n") || replacement.includes("\r")) {
    throw new Error("agent stanza replacement must be non-empty LF-terminated text");
  }
  const prior = agentStanzaSourceSlice(text, name);
  if (prior.valueSha256 !== expectedValueSha256) {
    throw new Error(`agents.${name}: affected stanza changed (CAS mismatch)`);
  }
  const nextText = `${text.slice(0, prior.valueStart)}${replacement}${text.slice(prior.valueEnd)}`;
  const next = agentStanzaSourceSlice(nextText, name);
  return { text: nextText, prior, next };
}
