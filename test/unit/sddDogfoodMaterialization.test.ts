import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyInstall, loadPlugin, previewInstall } from "../../src/plugins/engine.js";

describe("spec 301 SDD dogfood materialization", () => {
  it("materializes the dogfood helper and contract docs into claude and codex skill dirs", async () => {
    const pluginDir = process.env.SDD_PLUGIN_DIR ?? "/home/goat/tachyon-plugins/sdd";
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-sdd-dogfood-"));
    try {
      fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
      fs.mkdirSync(path.join(ws, ".codex"), { recursive: true });

      const loaded = loadPlugin(pluginDir);
      expect(loaded.errors).toEqual([]);
      expect(loaded.plugin?.manifest).toMatchObject({ name: "sdd", version: "1.4.0" });

      const targets = new Set(["claude", "codex"] as const);
      const preview = previewInstall(loaded.plugin!, ws, targets);
      expect(preview.skillTargets.map((t) => `${t.runtime}:${t.destRel}`).sort()).toEqual([
        "claude:.claude/skills/sdd",
        "codex:.agents/skills/sdd",
      ]);

      const installed = await applyInstall(loaded.plugin!, preview, ws, targets);
      expect(installed.installed).toBe(true);

      const sourceHelper = fs.readFileSync(path.join(pluginDir, "skills/sdd/scripts/sdd-dogfood.sh"), "utf8");
      const claudeHelper = fs.readFileSync(path.join(ws, ".claude/skills/sdd/scripts/sdd-dogfood.sh"), "utf8");
      const codexHelper = fs.readFileSync(path.join(ws, ".agents/skills/sdd/scripts/sdd-dogfood.sh"), "utf8");
      expect(claudeHelper).toBe(sourceHelper);
      expect(codexHelper).toBe(sourceHelper);

      const claudeSkill = fs.readFileSync(path.join(ws, ".claude/skills/sdd/SKILL.md"), "utf8");
      const codexSkill = fs.readFileSync(path.join(ws, ".agents/skills/sdd/SKILL.md"), "utf8");
      expect(claudeSkill).toContain("Dogfood-Opt-Out");
      expect(codexSkill).toContain("Dogfood-Opt-Out");

      const lock = JSON.parse(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8"));
      expect(lock.plugins.sdd.version).toBe("1.4.0");
      expect(lock.plugins.sdd.runtimes.sort()).toEqual(["claude", "codex"]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
