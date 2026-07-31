import fs from "node:fs";
import path from "node:path";
import {
  classifySetting,
  describeHook,
  foldWrappedStatusLine,
  inspectEnv,
  redactCommand,
  type InspectedHook,
  type InspectedSession,
  type InspectedSetting,
} from "./sessionInspection.js";

/**
 * t-283149 — read what a live session was actually given, and hand it to the pure projection.
 *
 * All I/O lives here so `sessionInspection.ts` stays a total function over found values. Every read is
 * best-effort: a missing file means "we could not see this", never a thrown error, because an
 * inspector that fails closed teaches nothing. What it must never do is guess — an absent value is
 * reported absent (`notExposed`), following parity.md's rule that code wins over prose.
 */

export interface SessionInspectionPorts {
  /** OS pid of the agent's pane, when a live session exists. */
  panePid: (agent: string) => Promise<number | undefined>;
  /** argv of a pid, NUL-split as `/proc/<pid>/cmdline` gives it. Undefined when unreadable. */
  processArgv: (pid: number) => string[] | undefined;
  /** environ of a pid. Undefined when unreadable (another user's process, or gone). */
  processEnv: (pid: number) => Record<string, string> | undefined;
}

/** Which settings keys the profile family allowlist can carry, per runtime. Empty = we do not know. */
export interface SessionInspectionConfig {
  projectableKeys: readonly string[];
  /** Keys Tachyon writes itself, in the host layer. */
  hostKeys: readonly string[];
  /** Keys the agent profile owns directly (selectors). */
  agentOwnedKeys: readonly string[];
  /** Env keys worth showing beyond `TACHYON_*` — a runtime's config home, typically. */
  extraEnvKeys: readonly string[];
  /** What this runtime does not expose, stated rather than silently missing. */
  notExposed: readonly string[];
}

/**
 * Only Claude is described today, and that is deliberate: Codex and Grok have a different shape (one
 * regenerated `config.toml`, no `--settings`) and get their own tasks rather than being forced into
 * this one's mould. A runtime with no entry reports what it can and names the rest as unknown.
 */
const RUNTIME_CONFIG: Readonly<Record<string, SessionInspectionConfig>> = {
  claude: {
    // Mirrors FAMILY_KEYS in claudeNativeConfigProjection.ts. Kept as data here, and pinned by a test
    // that fails when the two drift — a comment saying "keep in sync" is what t-e73e54 proved worthless.
    projectableKeys: [
      "permissions", "theme", "prefersReducedMotion", "spinnerTipsEnabled",
      "showTurnDuration", "terminalProgressBarEnabled", "statusLine", "alwaysThinkingEnabled",
    ],
    hostKeys: ["hooks", "skipDangerousModePermissionPrompt", "autoMemoryEnabled"],
    agentOwnedKeys: [],
    extraEnvKeys: ["CLAUDE_CONFIG_DIR"],
    notExposed: [],
  },
};

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Objects are summarized rather than dumped: the panel answers "what is set", not "paste the JSON". */
function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return Object.entries(record).map(([key, inner]) => `${key}=${renderValue(inner)}`).join(" · ");
  }
  return JSON.stringify(value ?? null);
}

function hooksFrom(settings: Record<string, unknown> | undefined): InspectedHook[] {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const out: InspectedHook[] = [];
  for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const inner = (matcher as { hooks?: unknown })?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const entry of inner) {
        const command = (entry as { command?: unknown })?.command;
        if (typeof command === "string") out.push(describeHook(event, command));
      }
    }
  }
  return out;
}

/** The status-line wrapper records the command it wraps; that is what makes it composition, not override. */
function priorStatusLineCommand(relayCommand: string | undefined): string | undefined {
  if (!relayCommand) return undefined;
  const match = /'([^']+\.relay\.json)'/.exec(relayCommand);
  if (!match) return undefined;
  const relay = readJson(match[1]);
  return typeof relay?.priorCommand === "string" ? relay.priorCommand : undefined;
}

export async function collectSessionInspection(input: {
  workspaceRoot: string;
  agent: string;
  runtime: string;
  ports: SessionInspectionPorts;
}): Promise<InspectedSession> {
  const { workspaceRoot, agent, runtime, ports } = input;
  const config = RUNTIME_CONFIG[runtime];
  const dot = (...segments: string[]) => path.join(workspaceRoot, ".tachyon", ...segments);

  const pid = await ports.panePid(agent).catch(() => undefined);
  const env = pid === undefined ? undefined : ports.processEnv(pid);
  const argv = pid === undefined ? undefined : ports.processArgv(pid);

  const projected = readJson(dot("harness", agent, "settings.json"));
  const host = readJson(dot("spawn-settings", `${agent}.json`));
  const globalKeys = new Set<string>();
  const home = env?.HOME ?? process.env.HOME;
  if (runtime === "claude" && home) {
    for (const key of Object.keys(readJson(path.join(home, ".claude", "settings.json")) ?? {})) globalKeys.add(key);
  }

  const settings: InspectedSetting[] = [];
  const push = (source: Record<string, unknown> | undefined, hostLayer: boolean) => {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (key === "hooks") continue; // hooks get their own section — listing them twice helps nobody
      settings.push({
        key,
        value: renderValue(value),
        origin: hostLayer
          ? "host"
          : classifySetting(key, {
            projectable: config?.projectableKeys ?? [],
            hostInjected: config?.hostKeys ?? [],
            agentOwned: config?.agentOwnedKeys ?? [],
          }, globalKeys.has(key)),
      });
    }
  };
  push(projected, false);
  push(host, true);

  // A global key that is NOT projectable never reaches the agent. Surfacing it is the single most
  // useful row here: it is the shape of defect that took three releases to find in t-084b28.
  for (const key of globalKeys) {
    if (settings.some((setting) => setting.key === key)) continue;
    if ((config?.projectableKeys ?? []).includes(key)) continue;
    settings.push({ key, value: "(not delivered to this agent)", origin: "not-projected" });
  }

  const statusLine = host?.statusLine as { command?: string } | undefined;
  const mcpServers = Object.keys((readJson(dot("harness", agent, "mcp.json"))?.mcpServers as Record<string, unknown>) ?? {});
  const bridgeMcp = Object.keys((readJson(dot("bridge-mcp", `${agent}.json`))?.mcpServers as Record<string, unknown>) ?? {});
  const secrets = Object.entries(env ?? {})
    .filter(([key]) => key.toUpperCase().includes("TOKEN") || key.toUpperCase().includes("SECRET"))
    .map(([, value]) => value);

  return {
    agent,
    runtime,
    state: argv ? "live" : "last-known",
    command: argv ? redactCommand(argv, secrets) : [],
    hooks: hooksFrom(host),
    settings: foldWrappedStatusLine(settings, priorStatusLineCommand(statusLine?.command)),
    mcpServers: [...new Set([...mcpServers, ...bridgeMcp])].sort(),
    strictMcp: (argv ?? []).includes("--strict-mcp-config"),
    env: inspectEnv(env ?? {}, config?.extraEnvKeys ?? []),
    notExposed: [
      ...(config?.notExposed ?? []),
      ...(config ? [] : [`Tachyon does not yet describe what it injects into '${runtime}' sessions`]),
      ...(argv ? [] : ["no live process — showing what is on disk from the last launch"]),
    ],
  };
}
