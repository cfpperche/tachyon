import fs from "node:fs";
import path from "node:path";
import { parseDocument, stringify } from "yaml";

/**
 * t-a65335 — test-side projection of a FULL legacy-style document (terminals/schedules/settings)
 * into the new homes the loader actually reads: `.tachyon/settings.yml` + one declaration file per
 * terminal/schedule. Unlike the production migration (which runs once and lets an existing new-home
 * file win), this helper REPLACES the declared state on every call, because a test that rewrites
 * its config means "this is the workspace now" — the semantics the old single-file write had.
 *
 * Unparseable input lands raw in `.tachyon/settings.yml`, which is where an unparseable workspace
 * config now surfaces (composed load error), preserving the old invalid-file test flows.
 */
export function writeWorkspaceConfig(workspaceRoot: string, yamlText: string): void {
  const tachyonDir = path.join(workspaceRoot, ".tachyon");
  const settingsFile = path.join(tachyonDir, "settings.yml");
  fs.mkdirSync(tachyonDir, { recursive: true });

  const doc = parseDocument(yamlText, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    fs.writeFileSync(settingsFile, yamlText, "utf8");
    return;
  }
  const raw = (doc.toJS() ?? {}) as Record<string, unknown>;

  const settings = raw.settings;
  fs.writeFileSync(
    settingsFile,
    settings && typeof settings === "object" && !Array.isArray(settings) ? stringify(settings) : "# empty settings (test workspace)\n",
    "utf8",
  );

  for (const [dirName, block] of [["terminals", raw.terminals], ["schedules", raw.schedules]] as const) {
    const dir = path.join(tachyonDir, dirName);
    fs.rmSync(dir, { recursive: true, force: true });
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, def] of Object.entries(block as Record<string, unknown>)) {
      fs.writeFileSync(path.join(dir, `${name}.yml`), stringify(def ?? {}), "utf8");
    }
  }
  // The legacy agents: block is dropped exactly as the loader always dropped it (t-ae221c).
}
