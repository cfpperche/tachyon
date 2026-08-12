import { describe, expect, it } from "vitest";
import { parseConfig, type AgentDef } from "../../src/config/loadConfig.js";
import { upsertAgent } from "../../src/config/YamlConfigEditor.js";
import { fromTerminalDef, toTerminalEntry, type FormState } from "../../src/webview/formLogic.js";
import schema from "../../src/config/tachyon.schema.json";
import { canonicalAgentFields, serializeAgentPatch } from "../../src/webview/agent-studio-shell/domain.js";
import {
  patchProfileFromStudioMutation,
  projectAgentProfileStudioSnapshot,
  type AgentProfileStudioMutationV1,
} from "../../src/config/agentProfileStudio.js";
import type { AgentProfileLifecycleSnapshot } from "../../src/config/agentProfileLifecycle.js";

/**
 * t-26ba8f — saving through a Studio must not delete what the form does not author.
 *
 * The measured defect (`neutralattn`, 2026-08-08): a hand-written
 * `attention: {enabled: true, silenceSec: 30, patterns: [...]}` came back as `attention: true` after
 * one Terminal Studio save. Both fields are LIVE — `parseConfig` accepts them, `Workspace.settingsOf`
 * hands them to `AttentionMonitor`, `silenceSec` decides the idle threshold and `patterns` becomes the
 * `extra_prompt_patterns` rule — so this is silent destruction of working configuration, not the
 * cleanup of a dead key. The cause is one line: `upsertAgent` does `doc.setIn([section, name], …)`,
 * which REPLACES the entry node with what the form modeled, and the form models attention as one
 * boolean.
 *
 * The guard is deliberately NOT "no test may find the literal `attention: true`". A string check goes
 * green the moment the same loss returns under another key. What is asserted instead is the FUNCTION:
 * a save that changes nothing must be the IDENTITY on the loaded definition, over every key the real
 * parser accepts for a terminal. A future key that the loader accepts and the form neither authors nor
 * carries forward fails this file without anyone remembering to add it.
 *
 * Scope, stated because it is easy to misread the fix as bigger than it is: this preserves what the
 * form does not author. Deleting-by-omission stays the rule for the fields it DOES author — a cleared
 * `cwd` still clears, `autostart: false` still removes the key — because the form is the authority on
 * exactly those. Rendering `silenceSec`/`patterns` in the form is a different job and not this one.
 */

/** The production chain a Terminal Studio edit walks: load → form → `toTerminalEntry` → declaration writer.
 *  Spelled once, mirroring `Workspace.studioSubmit` (it always passes `"terminals"` and the edited
 *  name), so these tests exercise the real door rather than a lookalike. */
function studioSave(text: string, name: string, edit: (state: FormState) => FormState = (s) => s): string {
  const before = parseConfig(text);
  expect(before.errors).toEqual([]);
  const def = before.config?.agents[name];
  expect(def, `'${name}' must load before it can be re-saved`).toBeDefined();
  const state = edit(fromTerminalDef(name, def as AgentDef));
  return upsertAgent(text, state.name, toTerminalEntry(state), name, "terminals").text;
}

function loaded(text: string, name: string): AgentDef {
  const parsed = parseConfig(text);
  expect(parsed.errors).toEqual([]);
  const def = parsed.config?.agents[name];
  expect(def, `'${name}' must still load after the save`).toBeDefined();
  return def as AgentDef;
}

/** The entry from the task's round-trip, byte for byte in shape: the two fields nothing in any Studio
 *  renders, plus an `env` the form does not model either. */
const HAND_WRITTEN = `# meu projeto
terminals:
  dev:
    cmd: npm run dev
    env:
      API_BASE: http://localhost:3000
    attention:
      enabled: true
      silenceSec: 30
      patterns:
        - "waiting for approval"
`;

describe("t-26ba8f — a Studio save keeps the fields the form does not author", () => {
  it("keeps attention.silenceSec and attention.patterns when nothing was edited", () => {
    const saved = studioSave(HAND_WRITTEN, "dev");
    expect(loaded(saved, "dev").attention).toEqual({
      enabled: true,
      silenceSec: 30,
      patterns: ["waiting for approval"],
    });
  });

  it("keeps them when the human turns attention OFF — the authored bit still lands", () => {
    // The other half of the same rule: preserving must not make the checkbox stop working. `enabled`
    // is the one attention fact the form owns, so it is the one that changes.
    const saved = studioSave(HAND_WRITTEN, "dev", (state) => ({ ...state, attention: false }));
    expect(loaded(saved, "dev").attention).toEqual({
      enabled: false,
      silenceSec: 30,
      patterns: ["waiting for approval"],
    });
  });

  it("keeps them across a rename, where the entry is deleted and rewritten", () => {
    // `upsertAgent` with a new name drops the old key and writes a new one. The prior node has to be
    // read BEFORE that delete, or the rename door loses exactly what the edit door keeps.
    const before = parseConfig(HAND_WRITTEN);
    const state = { ...fromTerminalDef("dev", before.config?.agents.dev as AgentDef), name: "dev-server" };
    const saved = upsertAgent(HAND_WRITTEN, state.name, toTerminalEntry(state), "dev", "terminals").text;
    expect(loaded(saved, "dev-server").attention).toEqual({
      enabled: true,
      silenceSec: 30,
      patterns: ["waiting for approval"],
    });
    expect(parseConfig(saved).config?.agents.dev).toBeUndefined();
  });

  it("preserves nothing on a CREATE — a new entry has no prior node to read", () => {
    const state: FormState = { ...fromTerminalDef("dev", parseConfig(HAND_WRITTEN).config?.agents.dev as AgentDef), name: "fresh" };
    const saved = upsertAgent(HAND_WRITTEN, "fresh", toTerminalEntry(state), undefined, "terminals").text;
    // Defaults, not the neighbour's tuning: preservation reads the entry being REPLACED, never a
    // sibling. (`fresh` inherits attention: true from the form state, which is what the human sees.)
    expect(loaded(saved, "fresh").attention).toEqual({ enabled: true, silenceSec: 8, patterns: [] });
    expect(loaded(saved, "fresh").environment).toBeUndefined();
  });
});

/**
 * The family guard. Not "does key X survive" — X was the key we already knew about — but "does a save
 * that edits nothing change ANY field the loader accepts", measured over the schema's declared entry
 * keys with the real parser deciding which of them a terminal may carry.
 */
const TERMINAL_PROBE_VALUES: Record<string, unknown> = {
  cmd: "npm run dev",
  cwd: "apps/web",
  env: { API_BASE: "http://localhost:3000" },
  autostart: true,
  watch: ["src/**", "package.json"],
  restart: "on-crash",
  attention: { enabled: true, silenceSec: 30, patterns: ["waiting for approval"] },
  kind: "terminal",
  instructions: "you are a reviewer",
  worktree: true,
  branch: "feature/x",
  worktreeSetup: "npm ci",
  harness: { mcp: {} },
  isolate: "transcript",
  subagents: ["child"],
};

/** Declared entry keys, read from the shipped schema rather than from a list in this file. */
function schemaEntryKeys(): string[] {
  const entry = (schema as unknown as {
    properties: { agents: { additionalProperties: { properties: Record<string, unknown> } } };
  }).properties.agents.additionalProperties.properties;
  return Object.keys(entry);
}

/** Does the real loader accept `key` on a `terminals:` entry? Measured, never assumed. */
function terminalAccepts(key: string): boolean {
  const value = TERMINAL_PROBE_VALUES[key];
  const parsed = parseConfig(JSON.stringify({ terminals: { probe: { cmd: "npm run dev", [key]: value } } }));
  const complaints = [...parsed.discarded, ...parsed.errors, ...parsed.warnings]
    .filter((message) => message.includes(`'${key}'`) || message.includes(`.${key}`));
  return complaints.length === 0;
}

describe("t-26ba8f — the family: a no-op Studio save is the identity on the loaded definition", () => {
  it("every key the schema declares has a probe value — coverage cannot shrink by omission", () => {
    // The guard the guard needed. Selecting probes with `key in TERMINAL_PROBE_VALUES` (which is what
    // this file did first) makes a NEW schema key skip itself: no probe, no measurement, still green,
    // while the commit message claims the family is closed. That is precisely the shape this suite
    // exists to catch, so it is asserted rather than trusted.
    //
    // Equality in BOTH directions, and no exemption list: a probe for a key the schema no longer
    // declares is the same rot from the other end, and there is no such thing as a key that cannot be
    // probed — the probe measures whether the loader ACCEPTS the key, and a refusal is a valid answer
    // (it is the answer `kind`, `instructions`, `worktree`, `branch`, `worktreeSetup`
    // and `harness` already give). Adding a key to `tachyon.schema.json` must mean deciding here what
    // a terminal does with it.
    expect(Object.keys(TERMINAL_PROBE_VALUES).sort()).toEqual(schemaEntryKeys().sort());
  });

  it("every schema key a terminal may carry survives a save that edited nothing", () => {
    const accepted = schemaEntryKeys().filter(terminalAccepts);
    // The probe values must be real ones, or "accepted" would silently shrink to nothing and the
    // assertion below would pass by measuring an empty entry.
    expect(accepted).toContain("attention");
    expect(accepted).toContain("env");

    const maximal: Record<string, unknown> = { cmd: "npm run dev" };
    for (const key of accepted) maximal[key] = TERMINAL_PROBE_VALUES[key];
    const text = JSON.stringify({ terminals: { dev: maximal } });

    const before = loaded(text, "dev");
    const after = loaded(studioSave(text, "dev"), "dev");
    expect(after).toEqual(before);
  });
});

/**
 * The Saved Agent half of the task's premise, re-measured before being trusted.
 *
 * The task recorded the same hole for a canonical profile, reasoning from
 * `agent-studio-shell/domain.ts` building `lifecycle.attention: <boolean>`. That much is true, and it
 * is where the resemblance ends: the host-side writer `patchProfileFromStudioMutation` spreads the
 * STORED `lifecycle.attention` and overwrites only `enabled`, so the profile door already merges where
 * the yml door replaced. Nothing was changed for this half — this is the guard that keeps it true, and
 * it passed on the pre-fix tree.
 */
const AGENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const REVISION = "b".repeat(64);

function tunedProfileSnapshot(): AgentProfileLifecycleSnapshot {
  return {
    schemaVersion: 1,
    canonicalizationVersion: 1,
    agentName: "reviewer",
    agentId: AGENT_ID,
    revision: REVISION,
    profile: {
      schemaVersion: 1,
      agentId: AGENT_ID,
      runtime: { adapter: "codex", executable: "codex" },
      lifecycle: {
        enabled: true,
        attention: { enabled: true, silenceSec: 30, patterns: ["waiting for approval"] },
      },
    },
    provenance: {
      canonical: { scope: "profile", writable: true, sha256: "d".repeat(64) },
      authority: { scope: "host", writable: false, revision: "lifecycle-one", grants: 0 },
      projection: { scope: "runtime", writable: false, active: false },
    },
  };
}

describe("t-26ba8f — the Saved Agent profile door already merges, and keeps doing so", () => {
  it("carries silenceSec and patterns through snapshot → form → patch", () => {
    const current = tunedProfileSnapshot();
    const snapshot = projectAgentProfileStudioSnapshot(current);
    // The form sees one boolean — that is the true half of the task's note about this door.
    expect(snapshot.editable.lifecycle.attention).toBe(true);
    const patch = serializeAgentPatch(canonicalAgentFields(snapshot), true) as AgentProfileStudioMutationV1;
    const written = patchProfileFromStudioMutation(patch, current);
    expect(written.lifecycle?.attention).toEqual({
      enabled: true,
      silenceSec: 30,
      patterns: ["waiting for approval"],
    });
  });

  it("keeps the tuning when the human turns attention off", () => {
    const current = tunedProfileSnapshot();
    const snapshot = projectAgentProfileStudioSnapshot(current);
    const fields = { ...canonicalAgentFields(snapshot), attention: false };
    const patch = serializeAgentPatch(fields, true) as AgentProfileStudioMutationV1;
    expect(patchProfileFromStudioMutation(patch, current).lifecycle?.attention).toEqual({
      enabled: false,
      silenceSec: 30,
      patterns: ["waiting for approval"],
    });
  });
});
