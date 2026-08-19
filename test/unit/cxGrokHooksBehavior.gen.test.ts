import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HarnessManager, harnessHome } from "@tachyon/engine/harness/HarnessManager.js";
import { SESSION_OWNER_RECORDER_SOURCE } from "@tachyon/engine/activity/sessionOwners.js";
import { adapterForRuntime } from "@tachyon/shared/resume/adapters.js";
import { runtimeUsesSilentPersistenceHooks, sessionOwnerCoverage } from "@tachyon/engine/runtime/parity.js";

describe("container-generated delegation behavior", () => {
  it("records a native Grok SessionStart payload in the shared ledger format", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-grok-owner-"));
    try {
      const ws = path.join(base, "ws");
      const grokHome = path.join(base, "grok-home");
      const recorder = path.join(base, "session-owner-record.cjs");
      const owners = path.join(ws, ".tachyon", "activity", "session-owners.jsonl");
      const cwd = path.join(base, "project");
      fs.mkdirSync(ws, { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(recorder, SESSION_OWNER_RECORDER_SOURCE);
      execFileSync("node", [recorder, JSON.stringify({ agent: "grok-x", out: owners })], {
        cwd,
        env: { ...process.env, GROK_HOME: grokHome },
        input: JSON.stringify({ hookEventName: "SessionStart", sessionId: "grok-session", cwd, workspaceRoot: cwd }),
        encoding: "utf8",
      });
      const row = JSON.parse(fs.readFileSync(owners, "utf8")) as Record<string, string>;
      expect(row).toMatchObject({
        agent: "grok-x",
        sessionId: "grok-session",
        cwd,
        transcriptPath: path.join(grokHome, "sessions", encodeURIComponent(cwd), "grok-session", "chat_history.jsonl"),
      });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("declares runtimes without a lifecycle recorder as uncovered", () => {
    expect(runtimeUsesSilentPersistenceHooks("grok")).toBe(true);
    expect(runtimeUsesSilentPersistenceHooks("pi")).toBe(false);
    expect(runtimeUsesSilentPersistenceHooks("unknown-cli")).toBe(false);
    expect(sessionOwnerCoverage("pi")).toEqual({ covered: false, reason: "runtime 'pi' has no Tachyon session-owner recorder" });
  });

  it("a harnessed grok agent materializes lifecycle hooks that wire the Tachyon session recorders", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-grok-hooks-"));
    try {
      const ws = path.join(base, "ws");
      const realGrokHome = path.join(base, "real-grok");
      fs.mkdirSync(ws, { recursive: true });
      fs.mkdirSync(realGrokHome, { recursive: true });
      fs.writeFileSync(path.join(realGrokHome, "auth.json"), '{"token":"REAL"}');

      const grok = adapterForRuntime("grok")!;
      const mgr = new HarnessManager(ws, ws, {}, undefined, undefined, undefined, undefined, realGrokHome);
      const handoff = path.join(ws, ".tachyon", "HANDOFF.md");

      const res = mgr.materialize("grok-x", { inherit: "none" }, grok, ws, undefined, {
        handoffPath: handoff,
        silentPersistence: true,
      });

      const home = harnessHome(ws, "grok-x");
      expect(res.home).toBe(home);
      expect(res.env.GROK_HOME).toBe(path.join(home, ".grok"));
      // t-de73e0 — the harnessed home gets its OWN copy of the credential, never a pointer at the
      // person's: a Grok re-auth inside a redirected home was measured writing the resolved path.
      expect(fs.lstatSync(path.join(home, ".grok", "auth.json")).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(home, ".grok", "auth.json"), "utf8")).toBe('{"token":"REAL"}');

      const sessionStart = JSON.parse(fs.readFileSync(path.join(home, ".grok", "hooks", "session-start.json"), "utf8"));
      const stop = JSON.parse(fs.readFileSync(path.join(home, ".grok", "hooks", "stop.json"), "utf8"));
      const startHooks = sessionStart.hooks.SessionStart[0].hooks as Array<{ type: string; command: string }>;
      const stopHook = stop.hooks.Stop[0].hooks[0] as { type: string; command: string };

      expect(startHooks.map((h) => h.type)).toEqual(["command", "command"]);
      expect(startHooks[0].command).toContain("session-owner-record.cjs");
      expect(startHooks[0].command).toContain('"agent":"grok-x"');
      expect(startHooks[0].command).toContain("session-owners.jsonl");
      expect(startHooks[1].command).toContain("handoff-pointer.cjs");
      expect(startHooks[1].command).toContain("HANDOFF.md");
      expect(stopHook.type).toBe("command");
      expect(stopHook.command).toContain("persistence-stop-record.cjs");
      expect(stopHook.command).toContain("persistence-stop.jsonl");
      expect(stopHook.command).toContain("persistence-hooks-failures.jsonl");

      expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "session-owner-record.cjs"))).toBe(true);
      expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "handoff-pointer.cjs"))).toBe(true);
      expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "continuity-pointer.cjs"))).toBe(false);
      expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "persistence-stop-record.cjs"))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
