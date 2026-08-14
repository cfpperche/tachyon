import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessManager, harnessHome } from "@tachyon/engine/harness/HarnessManager.js";
import { adapterForRuntime } from "@tachyon/shared/resume/adapters.js";

describe("container-generated delegation behavior", () => {
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

      expect(startHooks.map((h) => h.type)).toEqual(["command", "command", "command"]);
      expect(startHooks[0].command).toContain("session-owner-record.cjs");
      expect(startHooks[0].command).toContain("'grok-x'");
      expect(startHooks[0].command).toContain("session-owners.jsonl");
      expect(startHooks[1].command).toContain("handoff-pointer.cjs");
      expect(startHooks[1].command).toContain("HANDOFF.md");
      expect(startHooks[2].command).toContain("continuity-pointer.cjs");
      expect(startHooks[2].command).toContain("continuity/grok-x.md");
      expect(stopHook.type).toBe("command");
      expect(stopHook.command).toContain("persistence-stop-record.cjs");
      expect(stopHook.command).toContain("persistence-stop.jsonl");
      expect(stopHook.command).toContain("persistence-hooks-failures.jsonl");

      expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "session-owner-record.cjs"))).toBe(true);
      expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "handoff-pointer.cjs"))).toBe(true);
      expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "continuity-pointer.cjs"))).toBe(true);
      expect(fs.existsSync(path.join(ws, ".tachyon", "activity", "persistence-stop-record.cjs"))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
