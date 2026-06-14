import { parseDocument, stringify, YAMLMap, YAMLSeq } from "yaml";

/**
 * UI-driven mutations over tachyon.yml. The FILE stays the source of truth —
 * these are pure text→text transforms built on yaml's Document API, which
 * preserves the user's comments and formatting everywhere outside the mutated
 * entry. No parallel state, ever: hand-editing and UI editing stay equivalent.
 */

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

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

/** A `terminals:` entry must not carry kind/instructions (kind is implied; no AI) — strip them. */
function sanitizeForSection(section: Section, entry: Record<string, unknown>): Record<string, unknown> {
  if (section !== "terminals") return entry;
  const { kind: _kind, instructions: _instructions, ...rest } = entry;
  return rest;
}

function assertValidName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid agent name '${name}' (must match ${NAME_RE})`);
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

  // An EDIT acts in the entry's CURRENT block (never moves a legacy agents: terminal); a CREATE
  // uses the kind-implied `section` from the caller (spec 215).
  let target: Section = section;
  if (replaceName !== undefined) {
    const cur = sectionOf(doc, replaceName);
    if (!cur) throw new Error(`agent '${replaceName}' does not exist`);
    target = cur;
  }

  if (replaceName !== undefined && replaceName !== name) {
    // form-driven rename: the new name must be free in BOTH blocks; drop the old key, fix layouts.
    if (sectionOf(doc, name)) throw new Error(`agent '${name}' already exists`);
    doc.deleteIn([target, replaceName]);
    const layouts = doc.get("layouts");
    if (layouts instanceof YAMLMap) {
      for (const pair of layouts.items) {
        const layoutName = String((pair.key as { toJSON?: () => unknown }).toJSON?.() ?? pair.key);
        const agents = doc.getIn(["layouts", layoutName, "agents"]);
        if (!(agents instanceof YAMLSeq)) continue;
        const current = agents.toJSON() as string[];
        if (!current.includes(replaceName)) continue;
        doc.setIn(
          ["layouts", layoutName, "agents"],
          doc.createNode(current.map((a) => (a === replaceName ? name : a))),
        );
        warnings.push(`layout '${layoutName}' updated to reference '${name}'`);
      }
    }
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

/** Create or replace a layout entry (the Save-current-layout command). */
export function upsertLayout(
  text: string | undefined,
  name: string,
  entry: { layout: unknown; agents: string[] },
  overwrite = false,
): EditResult {
  assertValidName(name);
  if (text === undefined || text.trim().length === 0) {
    throw new Error("create an agent first — layouts need an existing tachyon.yml");
  }
  const doc = load(text);
  if (!overwrite && doc.hasIn(["layouts", name])) throw new Error(`layout '${name}' already exists`);
  doc.setIn(["layouts", name], doc.createNode(entry));
  return { text: String(doc), warnings: [] };
}

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
  if (entryCount(doc) <= 1) {
    throw new Error(
      `'${name}' is the last agent — a tachyon.yml needs at least one (delete the file itself to deactivate Tachyon here)`,
    );
  }
  doc.deleteIn([section, name]);
  // Drop a now-empty block so we never leave a bare `terminals: {}` / `agents: {}` behind.
  if (mapOf(doc, section)?.items.length === 0) doc.deleteIn([section]);

  // Keep layouts consistent: drop the agent from every layout; a layout left
  // empty is removed too (the schema requires at least one agent).
  const warnings: string[] = [];
  const layouts = doc.get("layouts");
  if (layouts instanceof YAMLMap) {
    for (const pair of [...layouts.items]) {
      const layoutName = String((pair.key as { toJSON?: () => unknown }).toJSON?.() ?? pair.key);
      const agents = doc.getIn(["layouts", layoutName, "agents"]);
      if (!(agents instanceof YAMLSeq)) continue;
      const current = agents.toJSON() as string[];
      const filtered = current.filter((a) => a !== name);
      if (filtered.length === current.length) continue;
      if (filtered.length === 0) {
        doc.deleteIn(["layouts", layoutName]);
        warnings.push(`layout '${layoutName}' lost its last agent and was removed`);
      } else {
        doc.setIn(["layouts", layoutName, "agents"], doc.createNode(filtered));
        warnings.push(`layout '${layoutName}' no longer includes '${name}'`);
      }
    }
  }
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

  const warnings: string[] = [];
  const layouts = doc.get("layouts");
  if (layouts instanceof YAMLMap) {
    for (const pair of layouts.items) {
      const layoutName = String((pair.key as { toJSON?: () => unknown }).toJSON?.() ?? pair.key);
      const agents = doc.getIn(["layouts", layoutName, "agents"]);
      if (!(agents instanceof YAMLSeq)) continue;
      const current = agents.toJSON() as string[];
      if (!current.includes(oldName)) continue;
      doc.setIn(
        ["layouts", layoutName, "agents"],
        doc.createNode(current.map((a) => (a === oldName ? newName : a))),
      );
      warnings.push(`layout '${layoutName}' updated to reference '${newName}'`);
    }
  }
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
