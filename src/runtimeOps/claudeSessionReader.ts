/**
 * t-0c963d — where a Claude session keeps what Tachyon handed it.
 *
 * Claude is the only runtime that receives TWO `--settings` files, and the reason is measured
 * (t-5a2c01): a Claude agent can legitimately run with no private home at all (`cmd: claude` with no
 * profile), so the host layer cannot live inside a home that may not exist. The division between the
 * two is by AUTHORITY — allowlist-governed projection versus host injection — not by precedence.
 */

import fs from "node:fs";
import path from "node:path";
import { hooksFromConfig } from "./sessionInspection.js";
import type {
  FoundSetting,
  RuntimeSessionReader,
  SessionReadContext,
  SessionSources,
} from "./sessionSources.js";

/** Best-effort JSON: a missing or malformed file means "could not see this", never a throw. */
export function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** The wrapper records the command it wraps; that record is what makes it composition, not override. */
function priorStatusLineCommand(relayCommand: string | undefined): string | undefined {
  if (!relayCommand) return undefined;
  const match = /'([^']+\.relay\.json)'/.exec(relayCommand);
  if (!match) return undefined;
  const relay = readJson(match[1]);
  return typeof relay?.priorCommand === "string" ? relay.priorCommand : undefined;
}

function entries(source: Record<string, unknown> | undefined, hostAuthored: boolean): FoundSetting[] {
  // Hooks get their own section; repeating them as a settings row helps nobody.
  return Object.entries(source ?? {})
    .filter(([key]) => key !== "hooks")
    .map(([key, value]) => ({ key, value, hostAuthored }));
}

export const claudeSessionReader: RuntimeSessionReader = {
  config: {
    // Mirrors FAMILY_KEYS in claudeNativeConfigProjection.ts. Kept as data here, and pinned by a test
    // that fails when the two drift — a comment saying "keep in sync" is what t-e73e54 proved worthless.
    projectableKeys: [
      "permissions", "theme", "prefersReducedMotion", "spinnerTipsEnabled",
      "showTurnDuration", "terminalProgressBarEnabled", "statusLine", "alwaysThinkingEnabled",
    ],
    hostKeys: ["hooks", "skipDangerousModePermissionPrompt", "autoMemoryEnabled"],
    agentOwnedKeys: [],
    extraEnvKeys: ["CLAUDE_CONFIG_DIR"],
  },

  read: ({ workspaceRoot, agent, env }: SessionReadContext): SessionSources => {
    const dot = (...segments: string[]) => path.join(workspaceRoot, ".tachyon", ...segments);
    const projected = readJson(dot("harness", agent, "settings.json"));
    const host = readJson(dot("spawn-settings", `${agent}.json`));

    const home = env?.HOME ?? process.env.HOME;
    const globalKeys = home
      ? Object.keys(readJson(path.join(home, ".claude", "settings.json")) ?? {})
      : [];

    const statusLine = host?.statusLine as { command?: string } | undefined;
    const mcp = Object.keys((readJson(dot("harness", agent, "mcp.json"))?.mcpServers as Record<string, unknown>) ?? {});
    const bridge = Object.keys((readJson(dot("bridge-mcp", `${agent}.json`))?.mcpServers as Record<string, unknown>) ?? {});

    return {
      settings: [...entries(projected, false), ...entries(host, true)],
      globalKeys,
      // Claude's hooks live in a FILE, so they stay readable with no live process — unlike Codex,
      // whose hooks ride the argv and vanish with the session.
      hooks: hooksFromConfig(host),
      mcpServers: [...new Set([...mcp, ...bridge])].sort(),
      wrappedStatusLine: priorStatusLineCommand(statusLine?.command),
      notExposed: [],
    };
  },
};
