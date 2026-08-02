/**
 * t-a5d827 — where a Grok session keeps what Tachyon handed it.
 *
 * Re-measured against live sessions on 2026-08-02 (HEAD after four same-day Grok deliveries). Reading
 * the task body alone would have been wrong on every surface that landed today:
 *
 * - **t-53e5f2** — lifecycle hooks land in `$GROK_HOME/hooks/*.json` (files, not argv). Temporary agents
 *   get ownership alone; declared/canonical also get the handoff pointer. Continuity + Stop stay off
 *   because Grok is not eligible for silent persistence.
 * - **t-836be3 / t-2f99e7** — projected enforcement (secrets-guard etc.) is a SEPARATE `projected.json`
 *   in the same hooks dir, never merged into the lifecycle files.
 * - **t-de73e0** — `auth.json` is a private COPY of the person's credential, never a symlink. The
 *   runtime was measured writing through a pointer and destroying the real credential.
 * - **t-84f0eb** — a delegated Grok child receives `--always-approve` on the argv by class, independent
 *   of whether the private `config.toml` carries `ui.permission_mode`. The flag is the delivery; the
 *   config key is a different door.
 * - **SDD 456** — only a *canonical* profile co-binds `HOME` to the private `GROK_HOME`. A Temporary
 *   child (this session) keeps the person's real `HOME` and only redirects `GROK_HOME`. Saying "HOME
 *   is always private" would be the same lie the panel exists to end.
 *
 * Shape difference vs Claude and Codex (do not squeeze Grok into either mould):
 * - One regenerated `config.toml` (like Codex), not two `--settings` files.
 * - Hooks in files under `$GROK_HOME/hooks/` (like Claude), so they survive without a live process.
 * - Unconditional isolation pins (`[memory] enabled=false`, every `[compat.*]` cell off) sit in that
 *   same file whenever a canonical projection runs — deliberate product decisions the person did not
 *   toggle, and the rows a "why does Grok remember nothing?" debugger needs to see first.
 */

import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { GROK_NATIVE_CONFIG_FAMILY_KEYS } from "../config/grokNativeConfigProjection.js";
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

/** Best-effort JSON for the hooks directory. Same fail-open rule as TOML. */
function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAt(source: Record<string, unknown>, field: string): unknown {
  return field.split(".").reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), source);
}

/**
 * Resolve the private GROK_HOME. Live sessions name it in the env; last-known falls back to the two
 * places Tachyon materializes it (non-harness bridge-mcp home, harness home). Prefer the path that
 * actually has a config or hooks dir so a wiped home is not preferred over a real one.
 */
function resolveGrokHome(workspaceRoot: string, agent: string, env?: Record<string, string>): string {
  if (env?.GROK_HOME?.trim()) return env.GROK_HOME;
  const bridge = path.join(workspaceRoot, ".tachyon", "bridge-mcp", `${agent}.grok`);
  const harness = path.join(workspaceRoot, ".tachyon", "harness", agent, ".grok");
  const has = (dir: string) => {
    try {
      return fs.existsSync(path.join(dir, "config.toml")) || fs.existsSync(path.join(dir, "hooks"));
    } catch {
      return false;
    }
  };
  if (has(bridge)) return bridge;
  if (has(harness)) return harness;
  // Default to the non-harness path: every real Grok agent measured today lives there.
  return bridge;
}

/**
 * The person's own home — where `~/.grok/config.toml` lives.
 *
 * When Tachyon co-binds `HOME` to the private GROK_HOME (canonical profiles, SDD 456), the agent's
 * env.HOME is NOT the person. Using it would either read nothing or read the private home and call
 * that "global". The inspector process is the operator, so `process.env.HOME` is the real one.
 */
function personHome(env: Record<string, string> | undefined, grokHome: string): string | undefined {
  const agentHome = env?.HOME;
  if (agentHome && path.resolve(agentHome) === path.resolve(grokHome)) {
    return process.env.HOME;
  }
  return agentHome ?? process.env.HOME;
}

function homesCoBound(env: Record<string, string> | undefined, grokHome: string): boolean {
  const agentHome = env?.HOME;
  return Boolean(agentHome && path.resolve(agentHome) === path.resolve(grokHome));
}

/** Runtime-owned tables Grok writes into the private home; not Tachyon injection and not projection. */
const RUNTIME_OWNED_PREFIXES = ["marketplace.", "cli.", "model."] as const;

function isRuntimeOwnedKey(key: string): boolean {
  return RUNTIME_OWNED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Host-authored isolation / wiring that lives in the same file as projected scalars. */
function isHostAuthoredKey(key: string): boolean {
  return key === "memory.enabled"
    || key.startsWith("memory.")
    || key.startsWith("compat.")
    || key.startsWith("mcp_servers.");
}

const ALWAYS_APPROVE_MODES = new Set(["always-approve", "bypassPermissions"]);

/** Flatten every family allowlist into the projectable-key list the collector classifies against. */
const PROJECTABLE_KEYS: readonly string[] = [
  ...GROK_NATIVE_CONFIG_FAMILY_KEYS.permissions,
  ...GROK_NATIVE_CONFIG_FAMILY_KEYS.interface,
  ...GROK_NATIVE_CONFIG_FAMILY_KEYS.featureFlags,
];

/** Every `[compat.*]` cell the materializer pins off — listed so the panel can name them as host pins. */
const COMPAT_PIN_KEYS = [
  "compat.cursor.skills", "compat.cursor.rules", "compat.cursor.agents",
  "compat.cursor.mcps", "compat.cursor.hooks", "compat.cursor.sessions",
  "compat.claude.skills", "compat.claude.rules", "compat.claude.agents",
  "compat.claude.mcps", "compat.claude.hooks", "compat.claude.sessions",
  "compat.codex.sessions",
] as const;

function hooksFromDir(hooksRoot: string): InspectedHook[] {
  const files = ["session-start.json", "stop.json", "projected.json"];
  const out: InspectedHook[] = [];
  for (const name of files) {
    const parsed = readJson(path.join(hooksRoot, name));
    // Each file is `{ hooks: { Event: [...] } }` — the same shape Claude uses, which is why
    // hooksFromConfig is shared. projected.json can be absent; that is the load-bearing empty case.
    out.push(...hooksFromConfig(parsed));
  }
  return out;
}

function argvFlagPresent(argv: readonly string[] | undefined, flag: string): boolean {
  if (!argv) return false;
  const eq = `${flag}=`;
  return argv.some((arg) => arg === flag || arg.startsWith(eq));
}

export const grokSessionReader: RuntimeSessionReader = {
  config: {
    // Mirrors FAMILY_KEYS in grokNativeConfigProjection.ts — pinned by a drift test, like Claude/Codex.
    projectableKeys: PROJECTABLE_KEYS,
    hostKeys: ["memory.enabled", ...COMPAT_PIN_KEYS, "auth.json"],
    agentOwnedKeys: ["models.default", "models.default_reasoning_effort"],
    // HOME is listed so a co-bound (or not) home is visible next to GROK_HOME; GROK_MEMORY is the
    // load-bearing memory pin (t-0e88f3 measured the env var, not the config key, as the control).
    extraEnvKeys: ["GROK_HOME", "HOME", "GROK_MEMORY"],
  },

  read: ({ workspaceRoot, agent, env, argv }: SessionReadContext): SessionSources => {
    const grokHome = resolveGrokHome(workspaceRoot, agent, env);
    const projected = readToml(path.join(grokHome, "config.toml"));
    const coBound = homesCoBound(env, grokHome);

    const settings: FoundSetting[] = flattenConfig(projected ?? {})
      .filter((entry) => !isRuntimeOwnedKey(entry.key))
      .map((entry) => ({
        key: entry.key,
        value: entry.value,
        hostAuthored: isHostAuthoredKey(entry.key),
      }));

    // Auth is a presence claim, never a path and never the bytes. Reading auth.json would put a
    // credential into the projection; stating that a private copy exists is what the panel owes.
    const authPath = path.join(grokHome, "auth.json");
    let authPresent = false;
    try {
      authPresent = fs.existsSync(authPath) && fs.statSync(authPath).isFile();
    } catch {
      authPresent = false;
    }
    settings.push({
      key: "auth.json",
      value: authPresent
        ? "private reconciled copy (present) — never a pointer at the person's credential"
        : "private reconciled copy (missing)",
      hostAuthored: true,
    });

    // t-84f0eb / t-0e88f3 — flags on the argv are first-class delivery, not shadows of config keys.
    // A delegated child can run always-approve with a Bridge-only config.toml that never mentions it.
    if (argvFlagPresent(argv, "--always-approve")) {
      settings.push({
        key: "argv.--always-approve",
        value: "true (delegated-child class policy)",
        hostAuthored: true,
      });
    }
    if (argvFlagPresent(argv, "--no-memory")) {
      settings.push({
        key: "argv.--no-memory",
        value: "true (canonical memory pin; pairs with GROK_MEMORY=0)",
        hostAuthored: true,
      });
    }
    if (argvFlagPresent(argv, "--permission-mode")) {
      const idx = argv!.findIndex((arg) => arg === "--permission-mode" || arg.startsWith("--permission-mode="));
      const raw = argv![idx];
      const mode = raw.startsWith("--permission-mode=")
        ? raw.slice("--permission-mode=".length)
        : argv![idx + 1];
      if (typeof mode === "string" && mode.length > 0 && !mode.startsWith("-")) {
        settings.push({
          key: "argv.--permission-mode",
          value: mode,
          hostAuthored: true,
        });
      }
    }

    const realHome = personHome(env, grokHome);
    const globalToml = realHome ? readToml(path.join(realHome, ".grok", "config.toml")) : undefined;
    // Do NOT strip runtime-owned prefixes here: a global `[cli]` key that never reaches the agent is
    // exactly a not-projected row. Marketplace noise is filtered only from the private-home settings
    // above, where it would otherwise masquerade as Tachyon injection.
    const globalKeys = globalToml
      ? flattenConfig(globalToml).map((entry) => entry.key)
      : [];

    const hooks = hooksFromDir(path.join(grokHome, "hooks"));

    const mcpServers = new Set<string>();
    const servers = projected?.mcp_servers;
    if (servers && typeof servers === "object") {
      for (const name of Object.keys(servers as Record<string, unknown>)) mcpServers.add(name);
    }

    const notExposed: string[] = [
      // Workspace is refused as a nativeConfig source, by measurement — not offered and not silently skipped.
      "a project .grok/config.toml is refused as a nativeConfig source: measured on Grok 0.2.112 it only contributes [mcp_servers]/[plugins]/[permission], and [permission] did not reach the effective rule set",
      // strictMcp is Claude-shaped; Grok isolates by redirecting GROK_HOME.
      "MCP isolation comes from the redirected GROK_HOME, not from a strict-config flag",
    ];

    if (env?.GROK_HOME || env?.HOME) {
      if (coBound) {
        notExposed.push(
          "HOME is co-bound to the private GROK_HOME — the agent cannot see the person's real home directory (canonical profile isolation, SDD 456)",
        );
      } else if (env?.GROK_HOME) {
        notExposed.push(
          "GROK_HOME is private; HOME is NOT co-bound on this session (only canonical profiles co-bind both — Temporary/delegated children keep the real HOME)",
        );
      }
    }

    // Deliberate OFF is as important as ON. When the isolation block is in the file the settings
    // rows already show it; when a Temporary home has no projection, name the pins from env/argv so
    // "why no memory" still has an answer.
    const memoryPinnedInConfig = settings.some((entry) => entry.key === "memory.enabled" && entry.value === false);
    const memoryPinnedInEnv = env?.GROK_MEMORY === "0";
    if (!memoryPinnedInConfig && (memoryPinnedInEnv || argvFlagPresent(argv, "--no-memory"))) {
      notExposed.push(
        "native memory is pinned off for this session (GROK_MEMORY=0 and/or --no-memory) even though the private config.toml has no [memory] table — Temporary homes are Bridge-only and still inherit the pin",
      );
    }

    // Authorization refusal vs silent absence: global always-approve that did not reach the private
    // config and is not on the argv is a refusal the person must be able to see.
    const globalMode = globalToml ? valueAt(globalToml, "ui.permission_mode") : undefined;
    const globalYolo = globalToml ? valueAt(globalToml, "ui.yolo") : undefined;
    const privateMode = projected ? valueAt(projected, "ui.permission_mode") : undefined;
    const privateYolo = projected ? valueAt(projected, "ui.yolo") : undefined;
    const sessionHasAlwaysApprove = ALWAYS_APPROVE_MODES.has(String(privateMode ?? ""))
      || privateYolo === true
      || argvFlagPresent(argv, "--always-approve");
    const globalWantsAlwaysApprove = ALWAYS_APPROVE_MODES.has(String(globalMode ?? "")) || globalYolo === true;
    if (globalWantsAlwaysApprove && !sessionHasAlwaysApprove) {
      notExposed.push(
        `your global config grants always-approve (ui.permission_mode=${String(globalMode ?? "—")}, yolo=${String(globalYolo ?? "—")}) but this session does not — either the Permissions family is excluded or this agent did not authorize alwaysApprove`,
      );
    }

    return {
      settings,
      globalKeys,
      hooks,
      mcpServers: [...mcpServers].sort(),
      notExposed,
    };
  },
};
