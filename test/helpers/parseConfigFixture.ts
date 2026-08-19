import { parseDocument } from "yaml";
import { parseConfig, type ManagedEntryDef, type ParseConfigOptions, type ParseResult } from "@tachyon/engine/config/loadConfig.js";
import { parseHarness } from "@tachyon/engine/config/loadConfig.js";

/**
 * Test-only bridge for fixtures written before the canonical profile roster existed.
 * It removes the retired YAML block and supplies the equivalent canonical projection directly;
 * production code never calls this helper and never reads `raw.agents`.
 */
export function parseConfigFixture(yamlText: string, options: ParseConfigOptions = {}): ParseResult {
  const document = parseDocument(yamlText);
  const raw = document.toJS() as Record<string, unknown> | null;
  if (document.errors.length > 0) return parseConfig(yamlText, options);
  const authored = raw?.agents;
  const canonicalAgents: Record<string, ManagedEntryDef> = { ...(options.canonicalAgents ?? {}) };
  const fixtureDiscarded: string[] = [];
  if (authored && typeof authored === "object" && !Array.isArray(authored)) {
    for (const [name, value] of Object.entries(authored as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const def = value as Record<string, unknown>;
      const cmd = typeof def.cmd === "string" ? def.cmd : "codex";
      const watch = Array.isArray(def.watch) ? def.watch.filter((item): item is string => typeof item === "string") : [];
      if (typeof def.watch === "string") watch.push(def.watch);
      const environment = def.env && typeof def.env === "object" && !Array.isArray(def.env)
        ? { values: def.env as Record<string, string> }
        : undefined;
      const parsedHarness = def.harness === undefined
        ? undefined
        : parseHarness(name, def.harness, cmd, environment?.values, fixtureDiscarded);
      const harness = parsedHarness === undefined
        ? undefined
        : {
          ...parsedHarness,
          inherit: (def.harness as Record<string, unknown>).inherit === "none" ? "none" as const : "workspace" as const,
        };
      const worktreeSetup = typeof def.worktreeSetup === "string"
        ? [def.worktreeSetup]
        : def.worktreeSetup;
      canonicalAgents[name] = {
        ...def,
        cmd,
        kind: "agent",
        cwd: typeof def.cwd === "string" ? def.cwd : undefined,
        environment,
        harness,
        worktreeSetup,
        autostart: def.autostart === true,
        watch,
        restart: def.restart === "on-crash" ? "on-crash" : "never",
        attention: typeof def.attention === "boolean"
          ? { enabled: def.attention, silenceSec: 8, patterns: [] }
          : typeof def.attention === "object" && def.attention !== null
            ? { enabled: true, silenceSec: 8, patterns: [], ...(def.attention as Record<string, unknown>) }
            : { enabled: true, silenceSec: 8, patterns: [] },
      } as ManagedEntryDef;
      if (def.restart !== undefined && def.restart !== "never" && def.restart !== "on-crash") {
        fixtureDiscarded.push(`discarded agents.${name}.restart: invalid restart policy`);
      }
    }
  }
  document.delete("agents");
  const result = parseConfig(String(document), { ...options, canonicalAgents });
  return {
    ...result,
    warnings: [...result.warnings, ...fixtureDiscarded],
    discarded: [...result.discarded, ...fixtureDiscarded],
  };
}
