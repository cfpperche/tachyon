import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyInjection, injectionText, reminderText, coldStartReminderText, type Transition } from "@tachyon/engine/continuity/classifier.js";
import { ContinuityState } from "@tachyon/engine/continuity/ContinuityState.js";

describe("continuity classifier (spec 241 D3/D9)", () => {
  const base = { hasBrief: true, discontinuitySinceRestore: false } as const;

  it("CLEAN same-session resume does NOT inject (the D3 fix)", () => {
    expect(classifyInjection({ ...base, transition: "resume", discontinuitySinceRestore: false })).toEqual({ inject: false, reason: "none" });
  });

  it("post-compaction resume DOES inject (resume + discontinuity since restore)", () => {
    expect(classifyInjection({ ...base, transition: "resume", discontinuitySinceRestore: true })).toEqual({ inject: true, reason: "post-compaction-resume" });
  });

  it("restart / new-session / compaction-idle always inject (fresh or lossy context)", () => {
    expect(classifyInjection({ ...base, transition: "restart" }).reason).toBe("restart");
    expect(classifyInjection({ ...base, transition: "new-session" }).reason).toBe("new-session");
    expect(classifyInjection({ ...base, transition: "compaction-idle" }).reason).toBe("compaction");
  });

  it("manual always injects", () => {
    expect(classifyInjection({ ...base, transition: "manual" })).toEqual({ inject: true, reason: "manual" });
  });

  it("a DONE brief is never injected as active work — except on a manual request", () => {
    for (const t of ["restart", "new-session", "compaction-idle", "resume"] as Transition[]) {
      expect(classifyInjection({ ...base, transition: t, discontinuitySinceRestore: true, briefStatus: "done" }).inject).toBe(false);
    }
    expect(classifyInjection({ ...base, transition: "manual", briefStatus: "done" }).inject).toBe(true);
  });

  it("cold start (no brief): nudge on a real discontinuity / manual; stay quiet on a clean resume", () => {
    expect(classifyInjection({ hasBrief: false, discontinuitySinceRestore: false, transition: "restart" })).toEqual({ inject: true, reason: "cold-start" });
    expect(classifyInjection({ hasBrief: false, discontinuitySinceRestore: true, transition: "resume" })).toEqual({ inject: true, reason: "cold-start" });
    expect(classifyInjection({ hasBrief: false, discontinuitySinceRestore: false, transition: "resume" })).toEqual({ inject: false, reason: "none" });
    expect(classifyInjection({ hasBrief: false, discontinuitySinceRestore: false, transition: "manual" })).toEqual({ inject: true, reason: "cold-start" });
  });

  it("injectionText: cold-start nudges set_continuity and restore points at continuity", () => {
    const cold = injectionText({ agent: "claude", reason: "cold-start" });
    expect(cold).toContain("No continuity brief yet");
    expect(cold).toContain("set_continuity");
    expect(injectionText({ agent: "claude", reason: "restart" })).toContain("cat .tachyon/continuity/claude.md");
  });

  it("injectionText: states the EXACT lag and a stale caveat only past staleLag (D4)", () => {
    const fresh = injectionText({ agent: "claude", reason: "restart", lag: 12, staleLag: 100 });
    expect(fresh).toContain("12 activity records behind");
    expect(fresh).not.toMatch(/STALE/);
    const stale = injectionText({ agent: "claude", reason: "post-compaction-resume", lag: 137, staleLag: 100 });
    expect(stale).toContain("137 activity records behind");
    expect(stale).toMatch(/MAY BE STALE/);
    expect(stale).toContain("cat .tachyon/continuity/claude.md");
  });

  it("injectionText: a paused brief is labeled, not presented as active", () => {
    expect(injectionText({ agent: "claude", reason: "restart", briefStatus: "paused" })).toMatch(/paused/);
  });

  it("reminderText: states the exact lag + the EXACT agent name (so the agent doesn't guess) (OQ1)", () => {
    const t = reminderText("claude-papo", 30);
    expect(t).toContain("30 activity records behind");
    expect(t).toContain('set_continuity(agent: "claude-papo"');
  });

  it("coldStartReminderText: nudges the FIRST brief with the EXACT agent name (OQ3)", () => {
    const t = coldStartReminderText("claude-papo");
    expect(t).toContain("no continuity brief yet");
    expect(t).toContain('set_continuity(agent: "claude-papo"');
  });

  it("injectionText cold-start spells out set_continuity with the exact agent name", () => {
    expect(injectionText({ agent: "claude-papo", reason: "cold-start" })).toContain('set_continuity(agent: "claude-papo"');
  });
});

describe("ContinuityState (spec 241 D9)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-cstate-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  let state: ContinuityState;
  beforeEach(() => {
    fs.rmSync(path.join(root, ".tachyon"), { recursive: true, force: true });
    state = new ContinuityState(root);
  });

  it("defaults to no discontinuity when no file exists", () => {
    expect(state.read("claude").discontinuitySinceRestore).toBe(false);
  });

  it("markDiscontinuity sets the flag + seq; markRestored clears it (round-trips on disk)", () => {
    state.markDiscontinuity("claude", 42);
    expect(new ContinuityState(root).read("claude")).toMatchObject({ discontinuitySinceRestore: true, lastDiscontinuitySeq: 42 });
    state.markRestored("claude", 50);
    const s = new ContinuityState(root).read("claude");
    expect(s.discontinuitySinceRestore).toBe(false);
    expect(s.lastRestoreSeq).toBe(50);
  });

  it("markNudged records a cooldown timestamp and activity seq; remove() deletes the state", () => {
    state.markNudged("claude", "2026-06-21T00:00:00Z", 37);
    expect(state.read("claude").lastNudgeAt).toBe("2026-06-21T00:00:00Z");
    expect(state.read("claude").lastNudgeSeq).toBe(37);
    state.remove("claude");
    expect(fs.existsSync(state.pathOf("claude"))).toBe(false);
  });
});
