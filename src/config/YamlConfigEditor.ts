import { createHash } from "node:crypto";
import { isAlias, isScalar, parseDocument, stringify, visit, YAMLMap, YAMLSeq } from "yaml";

/**
 * UI-driven mutations over tachyon.yml. The FILE stays the source of truth —
 * these are pure text→text transforms built on yaml's Document API, which
 * preserves the user's comments and formatting everywhere outside the mutated
 * entry. No parallel state, ever: hand-editing and UI editing stay equivalent.
 */

import { AGENT_NAME_PATTERN } from "./nameValidation.js";
import { defaultAttentionEnabled, type EntryKind } from "./loadConfig.js";

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

/**
 * `t-359469` — which block declares `name`, for a caller that must treat the two blocks differently.
 *
 * Kept separate so callers can distinguish the two managed-entry blocks without parsing YAML.
 */
export function agentStanzaSection(text: string | undefined, name: string): Section | undefined {
  if (text === undefined || text.trim().length === 0) return undefined;
  return sectionOf(load(text), name);
}

/**
 * Keys this writer removes from a `terminals:` entry, because `parseAgentEntry` refuses every one of
 * them for a terminal and `Workspace.mutateConfig` refuses to WRITE a file the loader would discard
 * from — so a caller that includes one does not get a warning, it gets a failed save.
 *
 * t-b54ead added the worktree keys. They reached here from the Terminal Studio, which
 * offered a "Git worktree isolation" section for a year: the fields were mirrored from Agent Studio
 * in `aa99c066` when its footer-void LAYOUT fix was ported, and the parser's refusals only arrived
 * later (SDD 478 M6). The form no longer offers them; this closes the same hole for every OTHER
 * writer of a terminal entry, which is the half a form fix cannot reach.
 *
 * Exported so `test/unit/terminalStudioAgentOnlyKeys.test.ts` can prove the list is a SUBSET of what
 * the loader actually refuses — measured by running the parser, not by reading a second list. A key
 * here that the loader accepts would be silent data loss, and that is the assertion.
 */
export const TERMINAL_STRIPPED_AGENT_KEYS = [
  "kind", "instructions", "selfEvolution", "worktree", "branch", "worktreeSetup",
] as const;

/** A `terminals:` entry must not carry agent-only fields (kind is implied; no AI, no worktree) — strip them. */
function sanitizeForSection(section: Section, entry: Record<string, unknown>): Record<string, unknown> {
  if (section !== "terminals") return entry;
  const rest = { ...entry };
  for (const key of TERMINAL_STRIPPED_AGENT_KEYS) delete rest[key];
  return rest;
}

/**
 * t-26ba8f — entry keys the Studio forms never author, carried forward from the entry a save
 * REPLACES instead of dying with it.
 *
 * A closed list, and that is the whole design. "Preserve everything the form did not send" would be
 * wrong twice over: the form deletes BY OMISSION for the fields it does own (unchecking autostart
 * removes the key), so a blanket rule would make those fields unclearable; and a key the loader
 * REFUSES for this section has to keep being dropped (t-b54ead), or the next save writes a file
 * `mutateConfig` will not persist because the loader would discard from it.
 *
 * `env` is here because it is what the measurement found next to `attention` — accepted by
 * `parseAgentEntry` for both sections, rendered by no Studio, and replaced away by the same
 * `doc.setIn`. `test/unit/studioSaveKeepsUnauthoredFields.test.ts` is what keeps this list honest: it
 * probes every schema-declared entry key against the real parser and fails if an accepted one is
 * neither authored by the form nor listed here.
 */
const UNAUTHORED_ENTRY_KEYS = ["env"] as const;

/**
 * The sub-keys of `attention:` no Studio renders. Every form models attention as ONE boolean, so a
 * save used to flatten `{enabled, silenceSec, patterns}` down to that boolean — measured 2026-08-08:
 * `attention: {enabled: true, silenceSec: 30, patterns: ["waiting for approval"]}` came back as
 * `attention: true`, and both dropped fields were live (`AttentionMonitor`'s idle threshold and its
 * `extra_prompt_patterns` rule).
 */
const UNAUTHORED_ATTENTION_KEYS = ["silenceSec", "patterns"] as const;

function plainRecordOf(node: unknown): Record<string, unknown> | undefined {
  const plain = (node as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? node;
  return typeof plain === "object" && plain !== null && !Array.isArray(plain)
    ? (plain as Record<string, unknown>)
    : undefined;
}

/**
 * The kind the entry being written will load as — from the block and the DECLARED `kind:`, never
 * inferred from the command.
 *
 * `parseAgentEntry` does fall back to `suggestKindForCommand` for an `agents:` entry with no `kind:`,
 * and this deliberately does not follow it there: t-c003e1 forbids that inference wherever the result
 * is persisted, because a later edit to `KNOWN_AI_CLIS` would then silently reclassify an entry
 * already on disk — here, by flipping the attention default of a mapping this writer is about to
 * write. The gap is unreachable in production anyway: `loadProfileAwareConfig` deletes the legacy
 * `agents:` block before parsing (`replaceAgentsBlock`), so no inline `agents:` entry can be loaded
 * into a Studio and come back through this door.
 */
function kindOfEntry(section: Section, entry: Record<string, unknown>): EntryKind {
  return section === "terminals" || entry.kind === "terminal" ? "terminal" : "agent";
}

/**
 * Merge what the form did not author back onto what it did. `prior` is the entry this save replaces;
 * `undefined` on a create, where there is nothing to preserve.
 *
 * `attention` needs the effective boolean rather than the written one: the form OMITS the key when
 * the human's choice equals the kind's default, so an omission still carries a decision, and writing
 * a bare `{silenceSec: 30}` would flip a terminal's attention ON (a mapping with no `enabled` loads
 * as enabled). `defaultAttentionEnabled` is the one statement of that default, shared with the
 * parser and the form.
 */
function carryUnauthoredForward(
  section: Section,
  prior: Record<string, unknown> | undefined,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  if (!prior) return entry;
  const merged = { ...entry };
  for (const key of UNAUTHORED_ENTRY_KEYS) {
    if (!(key in merged) && key in prior) merged[key] = prior[key];
  }
  const priorAttention = plainRecordOf(prior.attention);
  if (priorAttention) {
    const carried = Object.fromEntries(
      UNAUTHORED_ATTENTION_KEYS.filter((key) => key in priorAttention).map((key) => [key, priorAttention[key]]),
    );
    if (Object.keys(carried).length > 0) {
      const enabled = typeof merged.attention === "boolean"
        ? merged.attention
        : defaultAttentionEnabled(kindOfEntry(section, merged));
      merged.attention = { enabled, ...carried };
    }
  }
  return merged;
}

function assertValidName(name: string): void {
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error(`invalid agent name '${name}' (must match ${AGENT_NAME_PATTERN})`);
  }
}

/*
 * `t-c1ef82` — `addAgent` was REMOVED here, not simplified.
 *
 * It wrote `agents.<name>: { cmd, kind?, instructions? }` — always into `agents:`, whatever the kind
 * said. The legacy agent format that shape belonged to was retired on 2026-07-25 (`b4930e2b`), and
 * `agentProfileConfigLoader` now refuses every `agents:` entry without a `profile:` pointer. So this
 * was not dead code: its one production caller (promotion, `extensionOperationService`) still ran, and
 * writing a terminal through it produced a `tachyon.yml` the product's own reader rejects on the next
 * load. Measured by composition rather than inspection — see `yamlEditor.test.ts`, which reads every
 * writer's output back through the production parser.
 *
 * `upsertAgent(text, name, entry, undefined, "terminals")` is the replacement, and it is not a new
 * writer: it is the one `Workspace.studioSubmit` already uses for the terminal tab. It refuses a
 * duplicate across BOTH blocks, and `sanitizeForSection` strips the AI-only keys a terminal may not
 * carry — including the `instructions` parameter that had no caller left.
 */

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

  // t-26ba8f — read the node this save replaces BEFORE anything mutates the document: the rename
  // branch below deletes it, and a rename loses the same fields an edit would if it reads after.
  const prior = replaceName !== undefined ? plainRecordOf(doc.getIn([target, replaceName], true)) : undefined;

  if (replaceName !== undefined && replaceName !== name) {
    // form-driven rename: the new name must be free in BOTH blocks; drop the old key.
    if (sectionOf(doc, name)) throw new Error(`agent '${name}' already exists`);
    doc.deleteIn([target, replaceName]);
    // spec 234 — layout-ref update removed (layouts feature retired).
  } else if (replaceName === undefined && sectionOf(doc, name)) {
    throw new Error(`agent '${name}' already exists`);
  }

  // Sanitize LAST, so a preserved key can never re-introduce one this section refuses.
  doc.setIn([target, name], doc.createNode(sanitizeForSection(target, carryUnauthoredForward(target, prior, entry))));
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
 * SDD 488 F4 — set settings.ideBrowser.enabled (human Control / GA gate).
 * Gates the human surface and call-time execution; does not remove ide_browser_* from the tool list.
 * Requires an existing tachyon.yml. Persists explicit true/false so the opt-in is visible in the file.
 */
export function setIdeBrowserEnabled(text: string | undefined, enabled: boolean): EditResult {
  if (text === undefined || text.trim().length === 0) {
    throw new Error("create an agent first — Integrated Browser settings need an existing tachyon.yml");
  }
  const doc = load(text);
  doc.setIn(["settings", "ideBrowser", "enabled"], enabled);
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

export function deleteAgent(text: string, name: string): EditResult {
  const doc = load(text);
  const section = sectionOf(doc, name);
  if (!section) throw new Error(`agent '${name}' does not exist`);
  // t-ae221c — the "you cannot delete the last one" guard is gone, and it had to be.
  //
  // It refused whenever `agents:` and `terminals:` held one entry between them, and it dated from
  // when an empty roster was an invalid load. t-f67185 made an empty roster valid, and this cut took
  // the AGENTS out of the file entirely — so a workspace running a full canonical fleet and one
  // terminal now reads as "one entry", and deleting that terminal would be refused as deleting the
  // last agent. Measured: `config.agent.delete` on the only declared terminal failed with exactly
  // that message while a Saved Agent was live in `.tachyon/agents/`.
  doc.deleteIn([section, name]);
  // Drop a now-empty block so we never leave a bare `terminals: {}` / `agents: {}` behind.
  if (mapOf(doc, section)?.items.length === 0) doc.deleteIn([section]);

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
