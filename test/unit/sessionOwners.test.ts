import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { parseOwnerRows, latestOwnerFor, buildCodexSessionStartHookConfig, buildOwnershipSettings, CODEX_TOOL_HOOK_RECORDER_SOURCE, CODEX_UPDATE_PLAN_HOOK_MATCHER, PERSISTENCE_STOP_RECORDER_SOURCE, RUNTIME_STATUS_PUBLISHER_SOURCE, SESSION_HANDOFF_POINTER_SOURCE, SESSION_OWNER_RECORDER_SOURCE, appendOwnerRow, compactSessionOwnerRows, compactSpawnSettings, persistenceHookFailureFile, prunePersistenceLedger, readSessionOwners, removeSessionOwnerRows, removeSpawnSettings, resolveRotationFollow, sessionOwnersFile, spawnSettingsPath } from "@tachyon/engine/activity/sessionOwners.js";
import { AGENT_TOKEN_ENV_VAR, URL_ENV_VAR } from "@tachyon/shared/bridge/env.js";
import { URL_ENV_VAR as spawnUrlEnvVar, AGENT_TOKEN_ENV_VAR as spawnTokenEnvVar } from "@tachyon/bridge/token.js";
import { makeTempDir } from "../helpers/tempDir.js";

describe("sessionOwners — pure ledger helpers (spec 243)", () => {
  const execFileAsync = promisify(execFile);
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

  it("removeSessionOwnerRows removes only the deleted agent's ownership rows", () => {
    const tmp = makeTempDir("tachyon-owner-cleanup-");
    const file = path.join(tmp, "session-owners.jsonl");
    fs.writeFileSync(file, [
      row({ agent: "drop", sessionId: "d1", transcriptPath: "/p/d1.jsonl", cwd: "/ws" }),
      row({ agent: "keep", sessionId: "k1", transcriptPath: "/p/k1.jsonl", cwd: "/ws" }),
      row({ agent: "drop", sessionId: "d2", transcriptPath: "/p/d2.jsonl", cwd: "/ws" }),
      "{partial",
    ].join("\n"), "utf8");

    removeSessionOwnerRows(file, "drop");

    const rows = parseOwnerRows(fs.readFileSync(file, "utf8"));
    expect(rows.map((r) => r.agent)).toEqual(["keep"]);
    expect(rows[0]?.sessionId).toBe("k1");
  });

  it("compactSessionOwnerRows keeps only ownership rows for known agents", () => {
    const tmp = makeTempDir("tachyon-owner-compact-");
    const file = path.join(tmp, "session-owners.jsonl");
    fs.writeFileSync(file, [
      row({ agent: "declared", sessionId: "s-declared", transcriptPath: "/p/declared.jsonl", cwd: "/ws" }),
      row({ agent: "ledger", sessionId: "s-ledger", transcriptPath: "/p/ledger.jsonl", cwd: "/ws" }),
      row({ agent: "stale", sessionId: "s-stale", transcriptPath: "/p/stale.jsonl", cwd: "/ws" }),
      "{partial",
      row({ agent: "live", sessionId: "s-live", transcriptPath: "/p/live.jsonl", cwd: "/ws" }),
    ].join("\n"), "utf8");

    compactSessionOwnerRows(file, ["declared", "ledger", "live"]);

    expect(parseOwnerRows(fs.readFileSync(file, "utf8")).map((r) => r.agent)).toEqual(["declared", "ledger", "live"]);
  });

  it("removeSpawnSettings removes one agent's per-spawn settings file idempotently", () => {
    const tmp = makeTempDir("tachyon-spawn-settings-remove-");
    fs.mkdirSync(path.dirname(spawnSettingsPath(tmp, "drop")), { recursive: true });
    fs.writeFileSync(spawnSettingsPath(tmp, "drop"), "{}\n", "utf8");
    fs.writeFileSync(spawnSettingsPath(tmp, "keep"), "{}\n", "utf8");

    removeSpawnSettings(tmp, "drop");

    expect(fs.existsSync(spawnSettingsPath(tmp, "drop"))).toBe(false);
    expect(fs.existsSync(spawnSettingsPath(tmp, "keep"))).toBe(true);
    expect(() => removeSpawnSettings(tmp, "drop")).not.toThrow();
  });

  it("compactSpawnSettings drops settings for agents no longer known to the workspace", () => {
    const tmp = makeTempDir("tachyon-spawn-settings-compact-");
    fs.mkdirSync(path.dirname(spawnSettingsPath(tmp, "declared")), { recursive: true });
    for (const name of ["declared", "ledger", "live", "stale"]) fs.writeFileSync(spawnSettingsPath(tmp, name), "{}\n", "utf8");
    fs.writeFileSync(path.join(tmp, ".tachyon", "spawn-settings", "README.txt"), "keep\n", "utf8");

    compactSpawnSettings(tmp, ["declared", "ledger", "live"]);

    expect(fs.existsSync(spawnSettingsPath(tmp, "declared"))).toBe(true);
    expect(fs.existsSync(spawnSettingsPath(tmp, "ledger"))).toBe(true);
    expect(fs.existsSync(spawnSettingsPath(tmp, "live"))).toBe(true);
    expect(fs.existsSync(spawnSettingsPath(tmp, "stale"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".tachyon", "spawn-settings", "README.txt"))).toBe(true);
  });

  it("appendOwnerRow appends one durable row, creating the directory if needed", () => {
    const tmp = makeTempDir("tachyon-owner-append-");
    const file = sessionOwnersFile(tmp);
    appendOwnerRow(file, { agent: "a", sessionId: "s1", transcriptPath: "/p/s1.jsonl", cwd: "/ws", source: "rotation-follow", ts: "2026-07-14T00:00:00Z" });
    appendOwnerRow(file, { agent: "a", sessionId: "s2", transcriptPath: "/p/s2.jsonl", cwd: "/ws", source: "rotation-follow", ts: "2026-07-14T00:01:00Z" });
    const rows = readSessionOwners(file);
    expect(rows.map((r) => r.sessionId)).toEqual(["s1", "s2"]);
    expect(latestOwnerFor(rows, "a", "/ws")?.sessionId).toBe("s2");
  });

  describe("resolveRotationFollow (t-9f2641 — mid-run transcript rotation follow)", () => {
    const mk = (files: Record<string, number>) => {
      const tmp = makeTempDir("tachyon-rotation-follow-");
      for (const [name, mtimeMs] of Object.entries(files)) {
        const p = path.join(tmp, name);
        fs.writeFileSync(p, "{}\n", "utf8");
        const t = new Date(mtimeMs);
        fs.utimesSync(p, t, t);
      }
      return tmp;
    };

    it("follows the newest STRICTLY-newer sibling .jsonl when unambiguous", () => {
      const dir = mk({ "old.jsonl": 1000, "new.jsonl": 5000, "newest.jsonl": 9000, "note.txt": 9999 });
      const follow = resolveRotationFollow([], "me", path.join(dir, "old.jsonl"));
      expect(follow).toEqual({ transcriptPath: path.join(dir, "newest.jsonl"), sessionId: "newest" });
    });

    it("never follows when another agent's current row shares the same transcript directory (never-guess)", () => {
      const dir = mk({ "old.jsonl": 1000, "new.jsonl": 5000 });
      const rows = parseOwnerRows([
        row({ agent: "sibling", sessionId: "sib", transcriptPath: path.join(dir, "old.jsonl"), cwd: "/ws" }),
      ].join("\n"));
      expect(resolveRotationFollow(rows, "me", path.join(dir, "old.jsonl"))).toBeUndefined();
    });

    it("ignores another agent's row that lives in a DIFFERENT directory (isolated cwd/home stays unambiguous)", () => {
      const dir = mk({ "old.jsonl": 1000, "new.jsonl": 5000 });
      const rows = parseOwnerRows([
        row({ agent: "elsewhere", sessionId: "e1", transcriptPath: "/other/dir/e1.jsonl", cwd: "/other" }),
      ].join("\n"));
      expect(resolveRotationFollow(rows, "me", path.join(dir, "old.jsonl"))?.sessionId).toBe("new");
    });

    it("returns undefined when no strictly-newer sibling exists", () => {
      const dir = mk({ "old.jsonl": 5000, "older.jsonl": 1000 });
      expect(resolveRotationFollow([], "me", path.join(dir, "old.jsonl"))).toBeUndefined();
    });

    it("returns undefined when the dead file's own mtime can't be read (no evidence of 'newer than')", () => {
      const dir = mk({ "new.jsonl": 5000 });
      expect(resolveRotationFollow([], "me", path.join(dir, "missing.jsonl"))).toBeUndefined();
    });

    it("t-9f2641 MAJOR fix: a live (currently-declared) sibling's transcript dir is ambiguous even with NO owner row for it yet (TOCTOU close)", () => {
      // The exact race: sibling's brand-new session file is on disk (newest mtime) BEFORE its SessionStart
      // hook has appended its own owner row — `rows` alone can't see it, so `liveTranscriptDirs` must.
      const dir = mk({ "old.jsonl": 1000, "sib-new.jsonl": 5000 });
      expect(resolveRotationFollow([], "me", path.join(dir, "old.jsonl"), { liveTranscriptDirs: [dir] })).toBeUndefined();
    });

    it("t-9f2641 MAJOR fix: a live sibling's dir in a DIFFERENT directory never makes an isolated dir ambiguous", () => {
      const dir = mk({ "old.jsonl": 1000, "new.jsonl": 5000 });
      expect(resolveRotationFollow([], "me", path.join(dir, "old.jsonl"), { liveTranscriptDirs: ["/other/dir"] })?.sessionId).toBe("new");
    });

    it("t-9f2641 addendum: a deleted dead transcript follows the sole candidate strictly newer than the caller's last-known mtime", () => {
      const dir = mk({ "new.jsonl": 5000 });
      const deadPath = path.join(dir, "gone.jsonl"); // rotated AND pruned — no mtime of its own
      expect(resolveRotationFollow([], "me", deadPath, { deadMtimeBaseline: 1000 })).toEqual({
        transcriptPath: path.join(dir, "new.jsonl"),
        sessionId: "new",
      });
    });

    it("t-9f2641 addendum: a deleted dead transcript stays pinned with NO baseline at all", () => {
      const dir = mk({ "new.jsonl": 5000 });
      expect(resolveRotationFollow([], "me", path.join(dir, "gone.jsonl"))).toBeUndefined();
    });

    it("t-9f2641 addendum: a deleted dead transcript stays pinned when MULTIPLE candidates are newer than the baseline (still conservative)", () => {
      const dir = mk({ "a.jsonl": 5000, "b.jsonl": 6000 });
      expect(resolveRotationFollow([], "me", path.join(dir, "gone.jsonl"), { deadMtimeBaseline: 1000 })).toBeUndefined();
    });

    it("t-9f2641 addendum: a deleted dead transcript stays pinned when nothing is newer than the baseline", () => {
      const dir = mk({ "old-sibling.jsonl": 500 });
      expect(resolveRotationFollow([], "me", path.join(dir, "gone.jsonl"), { deadMtimeBaseline: 1000 })).toBeUndefined();
    });

    it("t-9f2641 addendum: a deleted dead transcript still respects row + live-dir ambiguity", () => {
      const dir = mk({ "new.jsonl": 5000 });
      const deadPath = path.join(dir, "gone.jsonl");
      const rows = parseOwnerRows([
        row({ agent: "sibling", sessionId: "sib", transcriptPath: path.join(dir, "new.jsonl"), cwd: "/ws" }),
      ].join("\n"));
      expect(resolveRotationFollow(rows, "me", deadPath, { deadMtimeBaseline: 1000 })).toBeUndefined();
    });
  });

  it("buildOwnershipSettings produces a SessionStart command hook with the agent + paths shell-quoted", () => {
    const s = buildOwnershipSettings("/ws/.tachyon/activity/rec.cjs", "claude-x", "/ws/.tachyon/activity/owners.jsonl");
    const cmd = s.hooks.SessionStart[0].hooks[0].command;
    expect(s.hooks.SessionStart[0].hooks[0].type).toBe("command");
    expect(cmd).toBe("node '/ws/.tachyon/activity/rec.cjs' '{\"agent\":\"claude-x\",\"out\":\"/ws/.tachyon/activity/owners.jsonl\",\"failureFile\":\"\"}'");
  });

  it("t-4e286c: buildOwnershipSettings can seed Claude's dangerous-mode consent skip", () => {
    const s = buildOwnershipSettings("/ws/.tachyon/activity/rec.cjs", "claude-x", "/ws/.tachyon/activity/owners.jsonl", undefined, undefined, {
      skipDangerousModePermissionPrompt: true,
    });
    expect(s.skipDangerousModePermissionPrompt).toBe(true);
  });

  it("buildOwnershipSettings adds Stop bookkeeping without a continuity SessionStart hook", () => {
    const s = buildOwnershipSettings("/ws/.tachyon/activity/rec.cjs", "claude-x", "/ws/.tachyon/activity/owners.jsonl", undefined, {
      stopRecorderPath: "/ws/.tachyon/activity/persistence-stop-record.cjs",
      stopFile: "/ws/.tachyon/activity/persistence-stop.jsonl",
      failureFile: "/ws/.tachyon/activity/persistence-hooks-failures.jsonl",
    });
    const startCmds = s.hooks.SessionStart[0].hooks.map((h) => h.command);
    expect(startCmds).toEqual(["node '/ws/.tachyon/activity/rec.cjs' '{\"agent\":\"claude-x\",\"out\":\"/ws/.tachyon/activity/owners.jsonl\",\"failureFile\":\"/ws/.tachyon/activity/persistence-hooks-failures.jsonl\"}'"]);
    expect(s.hooks.Stop?.[0].hooks[0].command).toBe("node '/ws/.tachyon/activity/persistence-stop-record.cjs' '{\"agent\":\"claude-x\",\"out\":\"/ws/.tachyon/activity/persistence-stop.jsonl\",\"failureFile\":\"/ws/.tachyon/activity/persistence-hooks-failures.jsonl\"}'");
  });

  it("spec 317: buildOwnershipSettings wires the failure ledger into all persistence hooks", () => {
    const s = buildOwnershipSettings("/ws/.tachyon/activity/rec.cjs", "claude-x", "/ws/.tachyon/activity/owners.jsonl", {
      pointerPath: "/ws/.tachyon/activity/handoff-pointer.cjs",
      handoffPath: "/ws/.tachyon/HANDOFF.md",
    }, {
      stopRecorderPath: "/ws/.tachyon/activity/persistence-stop-record.cjs",
      stopFile: "/ws/.tachyon/activity/persistence-stop.jsonl",
      failureFile: "/ws/.tachyon/activity/persistence-hooks-failures.jsonl",
    });
    const startCmds = s.hooks.SessionStart[0].hooks.map((h) => h.command);
    expect(startCmds).toHaveLength(2);
    for (const cmd of [...startCmds, s.hooks.Stop?.[0].hooks[0].command ?? ""]) {
      expect(cmd).toContain("/ws/.tachyon/activity/persistence-hooks-failures.jsonl");
    }
  });

  it("buildCodexSessionStartHookConfig produces a session-scoped hook override using TACHYON_AGENT_NAME", () => {
    const c = buildCodexSessionStartHookConfig("/ws/.tachyon/activity/rec.cjs", "/ws/.tachyon/activity/owners.jsonl", {
      pointerPath: "/ws/.tachyon/activity/handoff-pointer.cjs",
      handoffPath: "/ws/.tachyon/HANDOFF.md",
    });
    expect(typeof c).toBe("string");
    const config = c as string;
    expect(config).toContain("hooks.SessionStart=");
    expect(config).toContain('matcher="startup|resume|clear|compact"');
    expect(config).toContain('matcher="startup|resume|clear"');
    expect(config).toContain("\\\"$TACHYON_AGENT_NAME\\\"");
    expect(config).toContain("handoff-pointer.cjs");
    expect(config).toContain("Checking Tachyon project handoff");
    const compactEntry = /matcher="startup\|resume\|clear\|compact",hooks=\[([^\]]*)\]/.exec(config)?.[1] ?? "";
    const pointerEntry = /matcher="startup\|resume\|clear",hooks=\[([^\]]*)\]/.exec(config)?.[1] ?? "";
    expect(compactEntry).toContain("session ownership");
    expect(compactEntry).not.toContain("handoff-pointer.cjs");
    expect(pointerEntry).toContain("handoff-pointer.cjs");
  });

  it("buildCodexSessionStartHookConfig adds Stop without a continuity pointer", () => {
    const c = buildCodexSessionStartHookConfig("/ws/.tachyon/activity/rec.cjs", "/ws/.tachyon/activity/owners.jsonl", undefined, {
      stopRecorderPath: "/ws/.tachyon/activity/persistence-stop-record.cjs",
      stopFile: "/ws/.tachyon/activity/persistence-stop.jsonl",
      failureFile: "/ws/.tachyon/activity/persistence-hooks-failures.jsonl",
    });
    expect(c).toEqual(expect.any(Array));
    const [start, stop] = c as string[];
    expect(start).toContain("hooks.SessionStart=");
    expect(start).not.toContain("continuity-pointer");
    expect(stop).toContain("hooks.Stop=");
    expect(stop).toContain("persistence-stop-record.cjs");
    expect(start).toContain("/ws/.tachyon/activity/persistence-hooks-failures.jsonl");
    expect(stop).toContain("/ws/.tachyon/activity/persistence-hooks-failures.jsonl");
  });

  it("t-17b510: buildCodexSessionStartHookConfig injects PreToolUse/PostToolUse without replacing a projected gate", () => {
    const c = buildCodexSessionStartHookConfig(
      "/ws/.tachyon/activity/rec.cjs",
      "/ws/.tachyon/activity/owners.jsonl",
      undefined,
      undefined,
      {
        PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "gate.sh", statusMessage: "secrets-guard shape-gate" }] }],
      },
      undefined,
      {
        recorderPath: "/ws/.tachyon/activity/codex-tool-hook-record.cjs",
        file: "/ws/.tachyon/activity/codex-tool-hooks.jsonl",
        failureFile: "/ws/.tachyon/activity/persistence-hooks-failures.jsonl",
      },
    );
    expect(c).toEqual(expect.any(Array));
    const values = c as string[];
    const pre = values.find((value) => value.startsWith("hooks.PreToolUse="));
    const post = values.find((value) => value.startsWith("hooks.PostToolUse="));
    expect(pre).toBeDefined();
    expect(post).toBeDefined();
    expect(values.filter((value) => value.startsWith("hooks.PreToolUse="))).toHaveLength(1);
    expect(pre).toContain("gate.sh");
    expect(pre).toContain("codex-tool-hook-record.cjs");
    expect(pre).toContain(`matcher="${CODEX_UPDATE_PLAN_HOOK_MATCHER}"`);
    expect(pre).toContain('matcher="^update_plan$"');
    expect(pre).toContain("codex-tool-hooks.jsonl");
    expect(post).toContain("codex-tool-hook-record.cjs");
    expect(post).toContain('matcher="^update_plan$"');
    expect(post).not.toContain("gate.sh");
  });

  it("the recorder source is syntactically valid JS (parses without throwing)", () => {
    // Compiles the materialized recorder the way `node <file>` would — guards against a broken template string.
    expect(() => new Function(SESSION_OWNER_RECORDER_SOURCE)).not.toThrow();
    expect(() => new Function(SESSION_HANDOFF_POINTER_SOURCE)).not.toThrow();
    expect(() => new Function(PERSISTENCE_STOP_RECORDER_SOURCE)).not.toThrow();
    expect(() => new Function(CODEX_TOOL_HOOK_RECORDER_SOURCE)).not.toThrow();
    expect(SESSION_OWNER_RECORDER_SOURCE).toContain("appendFileSync");
    expect(PERSISTENCE_STOP_RECORDER_SOURCE).toContain("turnId");
    expect(CODEX_TOOL_HOOK_RECORDER_SOURCE).toContain("toolInput");
  });

  it("t-628ee7: materialized Codex writers resolve the agent from the environment in persisted rows", () => {
    const tmp = makeTempDir("tachyon-hook-agent-resolution-");
    const cases = [
      {
        source: SESSION_OWNER_RECORDER_SOURCE,
        name: "session-owner-record.cjs",
        output: "session-owners.jsonl",
        config: (out: string, failureFile: string) => ({ agent: "$TACHYON_AGENT_NAME", out, failureFile }),
        input: JSON.stringify({ session_id: "session-1", transcript_path: "/tmp/transcript.jsonl", cwd: "/ws" }),
      },
      {
        source: SESSION_HANDOFF_POINTER_SOURCE,
        name: "handoff-pointer.cjs",
        output: "handoff-failures.jsonl",
        config: (out: string, failureFile: string) => ({ agent: "$TACHYON_AGENT_NAME", path: out, failureFile }),
        input: "",
      },
      {
        source: PERSISTENCE_STOP_RECORDER_SOURCE,
        name: "persistence-stop-record.cjs",
        output: "persistence-stop.jsonl",
        config: (out: string, failureFile: string) => ({ agent: "$TACHYON_AGENT_NAME", out, failureFile }),
        input: JSON.stringify({ session_id: "session-1", turn_id: "turn-1", cwd: "/ws" }),
      },
      {
        source: CODEX_TOOL_HOOK_RECORDER_SOURCE,
        name: "codex-tool-hook-record.cjs",
        output: "codex-tool-hooks.jsonl",
        config: (out: string, failureFile: string) => ({ agent: "$TACHYON_AGENT_NAME", out, failureFile }),
        input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "session-1", turn_id: "turn-1", tool_name: "update_plan", tool_input: { plan: [] } }),
      },
    ];

    for (const expectedAgent of ["codex-test", ""]) {
      for (const tc of cases) {
        const dir = path.join(tmp, `${tc.name}-${expectedAgent || "empty"}`);
        fs.mkdirSync(dir, { recursive: true });
        const script = path.join(dir, tc.name);
        const output = path.join(dir, tc.output);
        const failureFile = path.join(dir, "failures.jsonl");
        fs.writeFileSync(script, tc.source);
        if (tc.name === "handoff-pointer.cjs") fs.mkdirSync(output);
        const env: NodeJS.ProcessEnv = { ...process.env, TACHYON_AGENT_NAME: expectedAgent };
        if (!expectedAgent) delete env.TACHYON_AGENT_NAME;

        const result = spawnSync(process.execPath, [script, JSON.stringify(tc.config(output, failureFile))], {
          env,
          input: tc.input,
          encoding: "utf8",
        });

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        if (!expectedAgent && tc.name !== "handoff-pointer.cjs") {
          expect(fs.existsSync(output), tc.name).toBe(false);
          continue;
        }
        const lines = fs.readFileSync(tc.name === "handoff-pointer.cjs" ? failureFile : output, "utf8").trim().split("\n");
        expect(lines).toHaveLength(1);
        const row = JSON.parse(lines[0]!);
        expect(row.agent).toBe(expectedAgent);
        expect(row.agent).not.toBe("$TACHYON_AGENT_NAME");
      }
    }
  });

  it("spec 317: materialized hooks log sanitized failures and still exit cleanly", () => {
    const tmp = makeTempDir("tachyon-hook-failure-");
    const cases = [
      {
        source: SESSION_OWNER_RECORDER_SOURCE,
        file: "session-owner-record.cjs",
        args: (badPath: string, failureFile: string) => [JSON.stringify({ agent: "codex-x", out: badPath, failureFile })],
        input: JSON.stringify({ session_id: "s", transcript_path: "/tmp/t.jsonl", cwd: "/ws", source: "startup" }),
        match: { agent: "codex-x", event: "SessionStart", script: "session-owner-record" },
      },
      {
        source: SESSION_HANDOFF_POINTER_SOURCE,
        file: "handoff-pointer.cjs",
        args: (badPath: string, failureFile: string) => [JSON.stringify({ path: badPath, failureFile, agent: "" })],
        input: "",
        match: { agent: "", event: "SessionStart", script: "handoff-pointer" },
      },
      {
        source: PERSISTENCE_STOP_RECORDER_SOURCE,
        file: "persistence-stop-record.cjs",
        args: (badPath: string, failureFile: string) => [JSON.stringify({ agent: "codex-x", out: badPath, failureFile })],
        input: JSON.stringify({ session_id: "s", cwd: "/ws" }),
        match: { agent: "codex-x", event: "Stop", script: "persistence-stop-record" },
      },
    ];

    for (const tc of cases) {
      const script = path.join(tmp, tc.file);
      const badPath = path.join(tmp, `${tc.file}.bad`);
      const failureFile = path.join(tmp, `${tc.file}.failures.jsonl`);
      fs.writeFileSync(script, tc.source);
      fs.mkdirSync(badPath);

      const res = spawnSync(process.execPath, [script, ...tc.args(badPath, failureFile)], {
        input: tc.input,
        encoding: "utf8",
      });

      expect(res.status).toBe(0);
      expect(res.stderr).toBe("");
      const rows = fs.readFileSync(failureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ...tc.match, path: badPath });
      expect(rows[0].reason).toEqual(expect.any(String));
      expect(rows[0].reason.length).toBeLessThanOrEqual(240);
      expect(rows[0].reason).not.toMatch(/[\r\n\t]/);
    }
  });

  it("spec 317: parse failures do not leak malformed hook stdin into the failure ledger", () => {
    const tmp = makeTempDir("tachyon-hook-parse-failure-");
    const script = path.join(tmp, "session-owner-record.cjs");
    const ownersFile = path.join(tmp, "session-owners.jsonl");
    const failureFile = path.join(tmp, "persistence-hooks-failures.jsonl");
    const sentinel = "SECRET_SENTINEL_SHOULD_NOT_LEAK";
    fs.writeFileSync(script, SESSION_OWNER_RECORDER_SOURCE);

    const res = spawnSync(process.execPath, [script, JSON.stringify({ agent: "codex-x", out: ownersFile, failureFile })], {
      input: `{"session_id":"${sentinel}"`,
      encoding: "utf8",
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    const rows = fs.readFileSync(failureFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "codex-x",
      event: "SessionStart",
      script: "session-owner-record",
      path: ownersFile,
      reason: "syntax-error",
    });
    expect(JSON.stringify(rows[0])).not.toContain(sentinel);
  });

  it("spec 317: failure logging remains best-effort when the failure ledger cannot be written", () => {
    const tmp = makeTempDir("tachyon-hook-failure-swallow-");
    const script = path.join(tmp, "persistence-stop-record.cjs");
    const badOut = path.join(tmp, "bad-out");
    const unwritableFailureTarget = path.join(tmp, "failure-target-is-directory");
    fs.writeFileSync(script, PERSISTENCE_STOP_RECORDER_SOURCE);
    fs.mkdirSync(badOut);
    fs.mkdirSync(unwritableFailureTarget);

    const res = spawnSync(process.execPath, [script, JSON.stringify({ agent: "codex-x", out: badOut, failureFile: unwritableFailureTarget })], {
      input: JSON.stringify({ session_id: "s", cwd: "/ws" }),
      encoding: "utf8",
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
  });

  it("spec 317: failure ledger path lives beside activity ledgers", () => {
    expect(persistenceHookFailureFile("/ws")).toBe("/ws/.tachyon/activity/persistence-hooks-failures.jsonl");
  });

  it("t-907238: publisher env names are the spawn launchEnv names, from one source", () => {
    // URL_ENV_VAR is what WorkspaceBridgeTransport.launchEnv writes. The hook source
    // interpolates that export. Two handwritten "TACHYON_BRIDGE_URL" strings would
    // let this pass while the names drifted again.
    expect(URL_ENV_VAR).toBe(spawnUrlEnvVar);
    expect(AGENT_TOKEN_ENV_VAR).toBe(spawnTokenEnvVar);
    expect(RUNTIME_STATUS_PUBLISHER_SOURCE).toContain(`process.env.${URL_ENV_VAR}`);
    expect(RUNTIME_STATUS_PUBLISHER_SOURCE).toContain(`process.env.${AGENT_TOKEN_ENV_VAR}`);
    expect(RUNTIME_STATUS_PUBLISHER_SOURCE).not.toContain("TACHYON_AGENT_BRIDGE_URL");
  });

  it("t-907238: empty spawn URL env is the incomplete-env failure, not a missing invented name", () => {
    const tmp = makeTempDir("tachyon-runtime-status-publish-");
    const script = path.join(tmp, "runtime-status-publish.cjs");
    const failureFile = path.join(tmp, "failures.jsonl");
    fs.writeFileSync(script, RUNTIME_STATUS_PUBLISHER_SOURCE);

    const withoutUrlEnv: NodeJS.ProcessEnv = {
      ...process.env,
      [AGENT_TOKEN_ENV_VAR]: "tok",
      TACHYON_AGENT_BRIDGE_URL: "http://127.0.0.1:9/mcp",
    };
    delete withoutUrlEnv[URL_ENV_VAR];
    const withoutUrl = spawnSync(process.execPath, [script, JSON.stringify({ runtime: "claude", failureFile, agent: "claude" })], {
      env: withoutUrlEnv,
      encoding: "utf8",
    });
    expect(withoutUrl.status).toBe(0);
    const missing = JSON.parse(fs.readFileSync(failureFile, "utf8").trim().split("\n").at(-1)!);
    expect(missing.reason).toContain("environment is incomplete");
    expect(missing.path).toBe("");

    fs.writeFileSync(failureFile, "");
    const withUrl = spawnSync(process.execPath, [script, JSON.stringify({ runtime: "claude", failureFile, agent: "claude" })], {
      env: { ...process.env, [AGENT_TOKEN_ENV_VAR]: "tok", [URL_ENV_VAR]: "http://127.0.0.1:1/mcp" },
      encoding: "utf8",
    });
    expect(withUrl.status).toBe(0);
    const lines = fs.readFileSync(failureFile, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const last = JSON.parse(lines.at(-1)!);
    expect(last.path).toBe("http://127.0.0.1:1/mcp");
    expect(last.reason).not.toContain("environment is incomplete");
  });

  it("t-43e9f6: publisher records an initialize HTTP refusal separately, including the raw response", async () => {
    const tmp = makeTempDir("tachyon-runtime-status-http-refusal-");
    const script = path.join(tmp, "runtime-status-publish.cjs");
    const failureFile = path.join(tmp, "failures.jsonl");
    fs.writeFileSync(script, RUNTIME_STATUS_PUBLISHER_SOURCE);
    const server = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", reason: "token_revoked" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    try {
      await execFileAsync(process.execPath, [script, JSON.stringify({ runtime: "grok", failureFile, agent: "gonegrok" })], {
        env: { ...process.env, [AGENT_TOKEN_ENV_VAR]: "revoked", [URL_ENV_VAR]: `http://127.0.0.1:${address.port}/mcp` },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    const failure = JSON.parse(fs.readFileSync(failureFile, "utf8").trim());
    expect(failure.reason).toBe('runtime status hook initialize HTTP failed: 401 Unauthorized; body={"error":"unauthorized","reason":"token_revoked"}');
  });

  it("t-43e9f6: publisher records a successful initialize without a session id separately", async () => {
    const tmp = makeTempDir("tachyon-runtime-status-missing-session-");
    const script = path.join(tmp, "runtime-status-publish.cjs");
    const failureFile = path.join(tmp, "failures.jsonl");
    fs.writeFileSync(script, RUNTIME_STATUS_PUBLISHER_SOURCE);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    try {
      await execFileAsync(process.execPath, [script, JSON.stringify({ runtime: "claude", failureFile, agent: "claude" })], {
        env: { ...process.env, [AGENT_TOKEN_ENV_VAR]: "live", [URL_ENV_VAR]: `http://127.0.0.1:${address.port}/mcp` },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    const failure = JSON.parse(fs.readFileSync(failureFile, "utf8").trim());
    expect(failure.reason).toBe("runtime status hook initialize succeeded without mcp-session-id: 200 OK");
  });

  it("spec 319: persistence ledger retention keeps recent valid rows and latest row per key", () => {
    const tmp = makeTempDir("tachyon-ledger-retention-");
    const file = path.join(tmp, "persistence-stop.jsonl");
    const rows = [
      { agent: "a", event: "Stop", ts: "old-a" },
      "{bad json",
      { agent: "a", event: "Stop", ts: "new-a" },
      { agent: "b", event: "Stop", ts: "old-b" },
      { agent: "b", event: "Stop", ts: "new-b" },
      { agent: "c", event: "Stop", ts: "tail-c" },
      { agent: "d", event: "Stop", ts: "tail-d" },
    ].map((r) => typeof r === "string" ? r : JSON.stringify(r)).join("\n") + "\n";
    fs.writeFileSync(file, rows);

    prunePersistenceLedger(file, { maxRows: 4, maxBytes: 4096 });

    const kept = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(kept.map((r) => r.ts)).toEqual(["new-a", "new-b", "tail-c", "tail-d"]);
    expect(fs.readFileSync(file, "utf8")).not.toContain("{bad json");
  });

  it("spec 319: persistence ledger retention enforces a hard byte cap when possible", () => {
    const tmp = makeTempDir("tachyon-ledger-byte-retention-");
    const file = path.join(tmp, "persistence-hooks-failures.jsonl");
    fs.writeFileSync(file, Array.from({ length: 20 }, (_x, i) => JSON.stringify({
      agent: `agent-${i}`,
      event: "SessionStart",
      script: "continuity-pointer",
      reason: `erro-${i}-` + "á".repeat(20),
    })).join("\n") + "\n");

    prunePersistenceLedger(file, { maxRows: 20, maxBytes: 500 });

    const out = fs.readFileSync(file, "utf8");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(500);
    expect(out.trim().split("\n").at(-1)).toContain("agent-19");
  });

  it("spec 319: Stop recorder prunes its ledger after appending", () => {
    const tmp = makeTempDir("tachyon-stop-retention-");
    const script = path.join(tmp, "persistence-stop-record.cjs");
    const stopFile = path.join(tmp, "persistence-stop.jsonl");
    const failureFile = path.join(tmp, "failures.jsonl");
    fs.writeFileSync(script, PERSISTENCE_STOP_RECORDER_SOURCE);
    fs.writeFileSync(stopFile, Array.from({ length: 2005 }, (_x, i) => JSON.stringify({ agent: "codex-x", event: "Stop", sessionId: `old-${i}` })).join("\n") + "\n");

    const res = spawnSync(process.execPath, [script, JSON.stringify({ agent: "codex-x", out: stopFile, failureFile })], {
      input: JSON.stringify({ session_id: "newest", cwd: "/ws" }),
      encoding: "utf8",
    });

    expect(res.status).toBe(0);
    const kept = fs.readFileSync(stopFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(kept.length).toBe(2000);
    expect(kept.at(-1)).toMatchObject({ agent: "codex-x", event: "Stop", sessionId: "newest" });
  });

  it("path resolution is platform-consistent for the cwd filter", () => {
    // sanity: path.resolve collapses '.', so the filter compares canonical dirs
    expect(path.resolve("/ws/.")).toBe(path.resolve("/ws"));
  });
});
