import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { parseOwnerRows, latestOwnerFor, buildCodexSessionStartHookConfig, buildOwnershipSettings, PERSISTENCE_STOP_RECORDER_SOURCE, SESSION_CONTINUITY_POINTER_SOURCE, SESSION_OWNER_RECORDER_SOURCE } from "../../src/activity/sessionOwners.js";

describe("sessionOwners — pure ledger helpers (spec 243)", () => {
  const row = (o: Record<string, unknown>) => JSON.stringify(o);

  it("parseOwnerRows keeps well-formed rows and skips blank/partial/garbage lines", () => {
    const text = [
      row({ agent: "a", sessionId: "s1", transcriptPath: "/p/s1.jsonl", cwd: "/ws", source: "startup", ts: "1" }),
      "",
      "{not json",
      row({ agent: "a", sessionId: "s2" }), // missing transcriptPath → dropped
      row({ agent: "b", sessionId: "s3", transcriptPath: "/p/s3.jsonl" }), // cwd/source/ts default to ""
    ].join("\n");
    const rows = parseOwnerRows(text);
    expect(rows.map((r) => r.sessionId)).toEqual(["s1", "s3"]);
    expect(rows[1]).toMatchObject({ agent: "b", transcriptPath: "/p/s3.jsonl", cwd: "", source: "", ts: "" });
  });

  it("latestOwnerFor returns the LAST row for the agent (append-order = newest)", () => {
    const rows = parseOwnerRows([
      row({ agent: "a", sessionId: "old", transcriptPath: "/p/old.jsonl", cwd: "/ws" }),
      row({ agent: "b", sessionId: "bbb", transcriptPath: "/p/bbb.jsonl", cwd: "/ws" }),
      row({ agent: "a", sessionId: "new", transcriptPath: "/p/new.jsonl", cwd: "/ws" }), // a's /clear
    ].join("\n"));
    expect(latestOwnerFor(rows, "a", "/ws")?.sessionId).toBe("new");
    expect(latestOwnerFor(rows, "b", "/ws")?.sessionId).toBe("bbb");
  });

  it("latestOwnerFor never returns another agent's session (per-agent positive attribution)", () => {
    const rows = parseOwnerRows([
      row({ agent: "sibling", sessionId: "sib-new", transcriptPath: "/p/sib.jsonl", cwd: "/ws" }),
    ].join("\n"));
    expect(latestOwnerFor(rows, "me", "/ws")).toBeUndefined(); // no row for "me" → gap, NOT the sibling
  });

  it("latestOwnerFor requires a canonical cwd match — a relocated/foreign-cwd or empty-cwd row never matches", () => {
    const rows = parseOwnerRows([
      row({ agent: "a", sessionId: "elsewhere", transcriptPath: "/p/x.jsonl", cwd: "/other" }),
      row({ agent: "a", sessionId: "here", transcriptPath: "/p/y.jsonl", cwd: "/ws/." }), // non-canonical, same dir
      row({ agent: "a", sessionId: "nocwd", transcriptPath: "/p/z.jsonl" }), // empty cwd → never matches (codex review)
    ].join("\n"));
    expect(latestOwnerFor(rows, "a", "/ws")?.sessionId).toBe("here"); // '/ws/.' resolves to '/ws'; the empty-cwd row is ignored
    expect(latestOwnerFor(rows, "a", "/other")?.sessionId).toBe("elsewhere");
    expect(latestOwnerFor(rows, "a", "/nowhere")).toBeUndefined(); // no cwd-matching row → gap
  });

  it("buildOwnershipSettings produces a SessionStart command hook with the agent + paths shell-quoted", () => {
    const s = buildOwnershipSettings("/ws/.tachyon/activity/rec.cjs", "claude-x", "/ws/.tachyon/activity/owners.jsonl");
    const cmd = s.hooks.SessionStart[0].hooks[0].command;
    expect(s.hooks.SessionStart[0].hooks[0].type).toBe("command");
    expect(cmd).toBe("node '/ws/.tachyon/activity/rec.cjs' 'claude-x' '/ws/.tachyon/activity/owners.jsonl'");
  });

  it("spec 312: buildOwnershipSettings can add continuity SessionStart + Stop bookkeeping hooks", () => {
    const s = buildOwnershipSettings("/ws/.tachyon/activity/rec.cjs", "claude-x", "/ws/.tachyon/activity/owners.jsonl", undefined, {
      continuityPointerPath: "/ws/.tachyon/activity/continuity-pointer.cjs",
      continuityPath: "/ws/.tachyon/continuity/claude-x.md",
      stopRecorderPath: "/ws/.tachyon/activity/persistence-stop-record.cjs",
      stopFile: "/ws/.tachyon/activity/persistence-stop.jsonl",
    });
    const startCmds = s.hooks.SessionStart[0].hooks.map((h) => h.command);
    expect(startCmds).toEqual([
      "node '/ws/.tachyon/activity/rec.cjs' 'claude-x' '/ws/.tachyon/activity/owners.jsonl'",
      "node '/ws/.tachyon/activity/continuity-pointer.cjs' 'claude-x' '/ws/.tachyon/continuity/claude-x.md'",
    ]);
    expect(s.hooks.Stop?.[0].hooks[0].command).toBe("node '/ws/.tachyon/activity/persistence-stop-record.cjs' 'claude-x' '/ws/.tachyon/activity/persistence-stop.jsonl'");
  });

  it("buildCodexSessionStartHookConfig produces a session-scoped hook override using TACHYON_AGENT_NAME", () => {
    const c = buildCodexSessionStartHookConfig("/ws/.tachyon/activity/rec.cjs", "/ws/.tachyon/activity/owners.jsonl", {
      pointerPath: "/ws/.tachyon/activity/handoff-pointer.cjs",
      handoffPath: "/ws/.tachyon/HANDOFF.md",
    });
    expect(c).toContain("hooks.SessionStart=");
    expect(c).toContain('matcher="startup|resume|clear|compact"');
    expect(c).toContain('matcher="startup|resume|clear"');
    expect(c).toContain("\\\"$TACHYON_AGENT_NAME\\\"");
    expect(c).toContain("handoff-pointer.cjs");
    expect(c).toContain("Checking Tachyon project handoff");
    const compactEntry = /matcher="startup\|resume\|clear\|compact",hooks=\[([^\]]*)\]/.exec(c)?.[1] ?? "";
    const pointerEntry = /matcher="startup\|resume\|clear",hooks=\[([^\]]*)\]/.exec(c)?.[1] ?? "";
    expect(compactEntry).toContain("session ownership");
    expect(compactEntry).not.toContain("handoff-pointer.cjs");
    expect(pointerEntry).toContain("handoff-pointer.cjs");
  });

  it("spec 312: buildCodexSessionStartHookConfig adds continuity and Stop hook overrides", () => {
    const c = buildCodexSessionStartHookConfig("/ws/.tachyon/activity/rec.cjs", "/ws/.tachyon/activity/owners.jsonl", undefined, {
      continuityPointerPath: "/ws/.tachyon/activity/continuity-pointer.cjs",
      continuityPath: "/ws/.tachyon/continuity/codex.md",
      stopRecorderPath: "/ws/.tachyon/activity/persistence-stop-record.cjs",
      stopFile: "/ws/.tachyon/activity/persistence-stop.jsonl",
    });
    expect(c).toContain("hooks.SessionStart=");
    expect(c).toContain("continuity-pointer.cjs");
    expect(c).toContain("/ws/.tachyon/continuity/codex.md");
    expect(c).toContain("hooks.Stop=");
    expect(c).toContain("persistence-stop-record.cjs");
    const compactEntry = /matcher="startup\|resume\|clear\|compact",hooks=\[([^\]]*)\]/.exec(c)?.[1] ?? "";
    const pointerEntry = /matcher="startup\|resume\|clear",hooks=\[([^\]]*)\]/.exec(c)?.[1] ?? "";
    expect(compactEntry).not.toContain("continuity-pointer.cjs");
    expect(pointerEntry).toContain("continuity-pointer.cjs");
  });

  it("the recorder source is syntactically valid JS (parses without throwing)", () => {
    // Compiles the materialized recorder the way `node <file>` would — guards against a broken template string.
    expect(() => new Function(SESSION_OWNER_RECORDER_SOURCE)).not.toThrow();
    expect(() => new Function(SESSION_CONTINUITY_POINTER_SOURCE)).not.toThrow();
    expect(() => new Function(PERSISTENCE_STOP_RECORDER_SOURCE)).not.toThrow();
    expect(SESSION_OWNER_RECORDER_SOURCE).toContain("appendFileSync");
  });

  it("path resolution is platform-consistent for the cwd filter", () => {
    // sanity: path.resolve collapses '.', so the filter compares canonical dirs
    expect(path.resolve("/ws/.")).toBe(path.resolve("/ws"));
  });
});
