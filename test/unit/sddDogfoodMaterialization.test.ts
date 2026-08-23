import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyContribution, applyInstall, loadPlugin, previewInstall } from "../../apps/vscode-extension/src/plugins/engine.js";

/**
 * spec 301 / 515 — the real `sdd` plugin, from install to a skill a runtime can read.
 *
 * This is the end-to-end proof of what slice 2 moved. Installing used to write the skill into
 * `.claude/skills` and `.agents/skills` for everybody, and this test read those directories straight
 * afterwards. Now installing lands the PAYLOAD and records the plugin; putting the skill into the
 * project's own directories is an act the human takes, and the same `applyContribution` door that
 * already existed for MCP servers and hooks is what takes it.
 *
 * Both halves are asserted here, in order, because the whole point of the change is that they are two
 * different events: nothing in `.claude`/`.agents` after install, both directories complete after
 * export, with byte-for-byte the payload's content.
 */
describe("spec 301 SDD dogfood materialization", () => {
  it("installs the payload without touching the project, then exports into claude and codex skill dirs", async () => {
    const pluginDir = process.env.SDD_PLUGIN_DIR ?? "/home/goat/tachyon-plugins/sdd";
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-sdd-dogfood-"));
    try {
      fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
      fs.mkdirSync(path.join(ws, ".codex"), { recursive: true });

      const loaded = loadPlugin(pluginDir);
      expect(loaded.errors).toEqual([]);
      expect(loaded.plugin?.manifest.name).toBe("sdd");
      const version = loaded.plugin!.manifest.version;

      const targets = new Set(["claude", "codex"] as const);
      const preview = previewInstall(loaded.plugin!, ws, targets);
      // 515 — a workspace install plans no skill materialization at all. What it knows about the
      // skills is that the payload carries them, which is what makes them grantable and exportable.
      expect(preview.skillTargets).toEqual([]);
      expect(preview.payloadSkills).toEqual(["sdd"]);

      const installed = await applyInstall(loaded.plugin!, preview, ws, targets);
      expect(installed.installed).toBe(true);
      expect(fs.existsSync(path.join(ws, ".claude/skills/sdd"))).toBe(false);
      expect(fs.existsSync(path.join(ws, ".agents/skills/sdd"))).toBe(false);
      expect(fs.existsSync(path.join(ws, ".tachyon/plugins/sdd/skills/sdd/SKILL.md"))).toBe(true);

      // The export door: one act, both runtimes, derived from the runtimes the install consented to.
      expect(applyContribution("sdd", { kind: "skill", name: "sdd" }, ws).applied).toBe(true);

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
      expect(lock.plugins.sdd.version).toBe(version);
      expect(lock.plugins.sdd.runtimes.sort()).toEqual(["claude", "codex"]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
