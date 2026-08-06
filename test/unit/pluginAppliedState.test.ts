/**
 * SDD 486 A2 — the applied record. Two properties decide whether this store is right, and both are
 * asserted here rather than described: an un-applied contribution must not resurrect on a re-read
 * (the record is authoritative, never derived), and a corrupt record must fail closed rather than
 * read as "nothing applied" while the materializations are still on disk.
 *
 * "Who else can reach this?" — the actors × triggers that reach applied-state, each with a case:
 *   apply (human)              → markApplied
 *   un-apply (human)           → markUnapplied, and re-read
 *   uninstall (human/engine)   → forgetPlugin, and a later re-install
 *   reload / fresh clone       → an ABSENT file, which is the empty state
 *   a human editing the file   → parse, which fails closed
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AppliedStateStore,
  AppliedStateError,
  APPLIED_STATE_REL_PATH,
  contributionId,
  parseContributionId,
  parseAppliedState,
  serializeAppliedState,
  emptyAppliedState,
  type ContributionRef,
} from "../../src/plugins/appliedState.js";

const SKILL: ContributionRef = { kind: "skill", name: "pdf-processing" };
const OTHER_SKILL: ContributionRef = { kind: "skill", name: "code-review" };
const HOOK: ContributionRef = { kind: "hook", name: "PreToolUse" };

let ws: string;
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), "applied-state-")); });
afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

const store = (): AppliedStateStore => new AppliedStateStore(ws);
const raw = (): string => fs.readFileSync(path.join(ws, APPLIED_STATE_REL_PATH), "utf8");
const writeRaw = (text: string): void => {
  fs.mkdirSync(path.dirname(path.join(ws, APPLIED_STATE_REL_PATH)), { recursive: true });
  fs.writeFileSync(path.join(ws, APPLIED_STATE_REL_PATH), text);
};

describe("contribution identity", () => {
  it("round-trips a skill and a hook id", () => {
    expect(contributionId(SKILL)).toBe("skill:pdf-processing");
    expect(contributionId(HOOK)).toBe("hook:PreToolUse");
    expect(parseContributionId("skill:pdf-processing")).toEqual(SKILL);
    expect(parseContributionId("hook:PreToolUse")).toEqual(HOOK);
  });

  it("refuses a kind Phase A does not own, and a name that is not valid for its kind", () => {
    // `mcp-server` is Phase C and `view` is out by decision — neither is spellable as applied state.
    expect(parseContributionId("mcp:some-server")).toBeNull();
    expect(parseContributionId("view:dashboard")).toBeNull();
    expect(parseContributionId("skill:Not-Kebab")).toBeNull();
    expect(parseContributionId("hook:has-a-dash")).toBeNull();
    expect(parseContributionId("skill:../escape")).toBeNull();
    expect(parseContributionId("nocolon")).toBeNull();
    expect(parseContributionId(42)).toBeNull();
  });
});

describe("applied record — parse + serialize", () => {
  it("round-trips, deduping and sorting so repeated writes are byte-identical", () => {
    const text = serializeAppliedState({ schemaVersion: 1, plugins: { sdd: ["skill:pdf-processing", "hook:PreToolUse", "skill:pdf-processing"] } });
    const { state, errors } = parseAppliedState(text);
    expect(errors).toEqual([]);
    expect(state?.plugins.sdd).toEqual(["hook:PreToolUse", "skill:pdf-processing"]);
    expect(serializeAppliedState(state!)).toBe(serializeAppliedState(state!));
  });

  it("fails closed on a bad schema, a bad plugin name and a bad contribution id", () => {
    expect(parseAppliedState("not json").errors[0]).toMatch(/invalid JSON/);
    expect(parseAppliedState(JSON.stringify({ schemaVersion: 2, plugins: {} })).errors[0]).toMatch(/schemaVersion/);
    expect(parseAppliedState(JSON.stringify({ schemaVersion: 1, plugins: [] })).errors[0]).toMatch(/plugins/);
    expect(parseAppliedState(JSON.stringify({ schemaVersion: 1, plugins: { "Not Kebab": [] } })).errors[0]).toMatch(/valid plugin name/);
    expect(parseAppliedState(JSON.stringify({ schemaVersion: 1, plugins: { sdd: "skill:x" } })).errors[0]).toMatch(/must be a list/);
    const bad = parseAppliedState(JSON.stringify({ schemaVersion: 1, plugins: { sdd: ["mcp:x"] } }));
    expect(bad.state).toBeUndefined();
    expect(bad.errors[0]).toMatch(/contribution id/);
  });

  it("the empty state is a real state, not an error", () => {
    const { state, errors } = parseAppliedState(serializeAppliedState(emptyAppliedState()));
    expect(errors).toEqual([]);
    expect(state?.plugins).toEqual({});
  });
});

describe("AppliedStateStore — the acts a human performs", () => {
  it("an ABSENT record means nothing is applied (a fresh clone, or a workspace from before this record)", () => {
    expect(fs.existsSync(path.join(ws, APPLIED_STATE_REL_PATH))).toBe(false);
    expect(store().read().plugins).toEqual({});
    expect(store().isApplied("sdd", SKILL)).toBe(false);
    expect(store().appliedFor("sdd")).toEqual([]);
  });

  it("applies one contribution and leaves the plugin's others alone", () => {
    store().markApplied("sdd", SKILL);
    expect(store().isApplied("sdd", SKILL)).toBe(true);
    expect(store().isApplied("sdd", OTHER_SKILL)).toBe(false);
    expect(store().isApplied("sdd", HOOK)).toBe(false);
  });

  it("keys a skill and a hook independently — a plugin shipping both has two switches", () => {
    store().markApplied("sdd", SKILL);
    store().markApplied("sdd", HOOK);
    expect(store().appliedFor("sdd")).toEqual([HOOK, SKILL]);
    store().markUnapplied("sdd", HOOK);
    expect(store().isApplied("sdd", SKILL)).toBe(true);
    expect(store().isApplied("sdd", HOOK)).toBe(false);
  });

  it("keys per plugin — two plugins may apply the same contribution name independently", () => {
    store().markApplied("sdd", SKILL);
    expect(store().isApplied("other-plugin", SKILL)).toBe(false);
    store().markApplied("other-plugin", SKILL);
    store().markUnapplied("sdd", SKILL);
    expect(store().isApplied("other-plugin", SKILL)).toBe(true);
  });

  it("an un-applied contribution does not resurrect on a fresh read of the same file", () => {
    store().markApplied("sdd", SKILL);
    store().markUnapplied("sdd", SKILL);
    // a NEW store instance re-reads from disk — this is the reload the acceptance criterion names
    expect(new AppliedStateStore(ws).isApplied("sdd", SKILL)).toBe(false);
    expect(new AppliedStateStore(ws).read().plugins.sdd).toBeUndefined();
  });

  it("is idempotent in both directions", () => {
    store().markApplied("sdd", SKILL);
    const after = raw();
    store().markApplied("sdd", SKILL);
    expect(raw()).toBe(after);
    store().markUnapplied("sdd", SKILL);
    const cleared = raw();
    store().markUnapplied("sdd", SKILL);
    expect(raw()).toBe(cleared);
    store().markUnapplied("never-installed", HOOK);
    expect(raw()).toBe(cleared);
  });

  it("uninstall drops the whole entry, so a re-install does not find it already applied", () => {
    store().markApplied("sdd", SKILL);
    store().markApplied("sdd", HOOK);
    store().markApplied("other-plugin", SKILL);
    store().forgetPlugin("sdd");
    expect(store().read().plugins.sdd).toBeUndefined();
    expect(store().isApplied("sdd", SKILL)).toBe(false);
    expect(store().isApplied("sdd", HOOK)).toBe(false);
    // a plugin that was NOT uninstalled keeps its state
    expect(store().isApplied("other-plugin", SKILL)).toBe(true);
    // forgetting an unknown plugin is a no-op, not a write
    const before = raw();
    store().forgetPlugin("sdd");
    expect(raw()).toBe(before);
  });

  it("refuses to record an invalid plugin name or contribution", () => {
    expect(() => store().markApplied("Not Kebab", SKILL)).toThrow(AppliedStateError);
    expect(() => store().markApplied("sdd", { kind: "skill", name: "Not-Kebab" })).toThrow(AppliedStateError);
    expect(fs.existsSync(path.join(ws, APPLIED_STATE_REL_PATH))).toBe(false);
  });

  it("a corrupt record is an ERROR, never a silent 'nothing applied'", () => {
    writeRaw("{ this is not json");
    expect(() => store().read()).toThrow(AppliedStateError);
    expect(() => store().isApplied("sdd", SKILL)).toThrow(AppliedStateError);
    // and a write path refuses too, rather than overwriting a record it could not understand
    expect(() => store().markApplied("sdd", SKILL)).toThrow(AppliedStateError);
    writeRaw(JSON.stringify({ schemaVersion: 1, plugins: { sdd: ["skill:pdf-processing", "mcp:x"] } }));
    expect(() => store().read()).toThrow(/corrupt/);
  });

  it("lives at its own path and never touches plugins.lock.json", () => {
    store().markApplied("sdd", SKILL);
    expect(store().file()).toBe(path.join(ws, APPLIED_STATE_REL_PATH));
    expect(APPLIED_STATE_REL_PATH).not.toContain("plugins.lock.json");
    expect(fs.existsSync(path.join(ws, ".tachyon/plugins.lock.json"))).toBe(false);
    // and it is not inside `.tachyon/plugins/`, where every entry is a plugin name
    expect(APPLIED_STATE_REL_PATH.startsWith(".tachyon/plugins/")).toBe(false);
  });
});
