/**
 * t-0c963d — where a Codex session keeps what Tachyon handed it.
 *
 * Measured against a live session (2026-07-31), because reading the code produced a wrong answer
 * first: Codex's hooks are NOT written to a file. They ride the argv as TOML fragments —
 * `-c hooks.SessionStart=[…]` and `-c hooks.Stop=[…]` (`activity/sessionOwners.ts:458` builds them,
 * `config/loadConfig.ts:321` turns each into `-c`). The Bridge arrives the same way.
 *
 * Codex has a persisted hook-trust ledger, the only one of the three runtimes with one. Writing hooks
 * into `$CODEX_HOME/config.toml` would gate them behind that ledger, leaving only two options: prompt
 * the person every launch, or grant permanent blanket trust. The argv route plus a per-invocation
 * `--dangerously-bypass-hook-trust` is what keeps the bypass scoped to one launch.
 *
 * The consequence this reader must state rather than hide: with no live process there is no argv, so
 * a Codex session's hooks are not observable AT ALL from disk. Rendering that as "no hooks" would be
 * the same lie the runtime's own `/hooks` tells — and ending that lie is why this panel exists.
 */

import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { flattenConfig, hooksFromConfig, type InspectedHook } from "./sessionInspection.js";
import type {
  FoundSetting,
  RuntimeSessionReader,
  SessionReadContext,
  SessionSources,
} from "./sessionSources.js";

/** Best-effort TOML: a missing or malformed file means "could not see this", never a throw. */
function readToml(file: string): Record<string, unknown> | undefined {
  try {
    return TOML.parse(fs.readFileSync(file, "utf8")) as unknown as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Each `-c` value is a standalone TOML assignment; a fragment we cannot parse is skipped, not guessed. */
function configOverrides(argv: readonly string[] | undefined): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let index = 0; index < (argv?.length ?? 0) - 1; index++) {
    if (argv![index] !== "-c") continue;
    try {
      out.push(TOML.parse(argv![index + 1]) as unknown as Record<string, unknown>);
    } catch {
      /* an override we cannot read is reported by its absence, never by a guess */
    }
  }
  return out;
}

/**
 * Tachyon writes `[projects."<path>"] trust_level` itself (`harness/HarnessManager.ts:2346`), so those
 * rows are host-authored even though they share the file with projected keys. Codex has ONE config
 * file, unlike Claude's two, so the layer cannot be inferred from which file a key came from.
 */
const HOST_AUTHORED_PREFIX = "projects.";

/**
 * Codex keeps two LEDGERS in the same file as its settings, and neither is a setting.
 *
 * `projects.<path>.trust_level` records which directories the person trusted; `hooks.state.<…>
 * .trusted_hash` is the persisted hook-trust ledger — the very one that forces Tachyon's hooks onto
 * the argv instead of into this file.
 *
 * Measured before this filter existed: they produced ~30 rows of "not delivered to this agent",
 * burying the four that matter (model, model_reasoning_effort, approvals_reviewer, service_tier).
 * Saying a trust record "was not delivered" is also just false — it was never addressed to the agent.
 * Same failure as printing the 7.9 KB brief in the launch command: everything present, nothing legible.
 */
const LEDGER_PREFIXES = ["projects.", "hooks.state."] as const;

function isLedgerKey(key: string): boolean {
  return LEDGER_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export const codexSessionReader: RuntimeSessionReader = {
  config: {
    // Mirrors FAMILY_KEYS in codexNativeConfigProjection.ts — six keys against Claude's eight, and
    // dotted rather than flat. Pinned by a drift test, like Claude's.
    projectableKeys: [
      "approval_policy", "sandbox_mode",
      "personality", "tui.status_line", "tui.status_line_use_colors",
      "features.terminal_resize_reflow",
    ],
    hostKeys: [],
    agentOwnedKeys: ["model", "model_reasoning_effort"],
    extraEnvKeys: ["CODEX_HOME"],
  },

  read: ({ workspaceRoot, agent, env, argv }: SessionReadContext): SessionSources => {
    const home = env?.CODEX_HOME ?? path.join(workspaceRoot, ".tachyon", "harness", agent);
    const projected = readToml(path.join(home, "config.toml"));
    const overrides = configOverrides(argv);

    const settings: FoundSetting[] = flattenConfig(projected ?? {})
      // Hooks get their own section; repeating them as settings rows helps nobody.
      .filter((entry) => !entry.key.startsWith("hooks."))
      .map((entry) => ({
        key: entry.key,
        value: entry.value,
        hostAuthored: entry.key.startsWith(HOST_AUTHORED_PREFIX),
      }));

    const realHome = env?.HOME ?? process.env.HOME;
    const globalKeys = realHome
      ? flattenConfig(readToml(path.join(realHome, ".codex", "config.toml")) ?? {})
        .map((entry) => entry.key)
        .filter((key) => !isLedgerKey(key))
      : [];

    const hooks: InspectedHook[] = overrides.flatMap((override) => hooksFromConfig(override));
    const mcpServers = new Set<string>();
    for (const source of [projected, ...overrides]) {
      const servers = source?.mcp_servers;
      if (servers && typeof servers === "object") for (const name of Object.keys(servers)) mcpServers.add(name);
    }

    return {
      settings,
      globalKeys,
      hooks,
      mcpServers: [...mcpServers].sort(),
      // No status-line wrapper on Codex: the observability capture is Claude-only, so there is
      // nothing composed here and claiming a wrap would invent one.
      notExposed: [
        // `strictMcp` is a Claude flag and Codex has no equivalent, so the panel would otherwise read
        // this session as "ambient MCP config is not excluded". It IS excluded — by the CODEX_HOME
        // redirect, which makes the private config the only one Codex ever reads. Saying so beats
        // letting a Claude-shaped field imply the opposite.
        "MCP isolation comes from the redirected CODEX_HOME, not from a strict-config flag",
        ...(argv
          ? []
          : ["Codex hooks are passed on the command line, so they cannot be read without a live process"]),
      ],
    };
  },
};
