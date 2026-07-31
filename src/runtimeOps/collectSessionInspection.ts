import {
  classifySetting,
  foldWrappedStatusLine,
  inspectEnv,
  redactCommand,
  type InspectedSession,
  type InspectedSetting,
} from "./sessionInspection.js";
import { claudeSessionReader } from "./claudeSessionReader.js";
import type { RuntimeSessionReader } from "./sessionSources.js";

/**
 * t-283149 / t-0c963d — read what a live session was actually given, and hand it to the pure projection.
 *
 * This file holds the RULES and nothing else: classify each key's origin, redact secrets, fold a
 * wrapped status line, and state what could not be seen. Where a runtime keeps its config is a reader's
 * job (`sessionSources.ts`), so a rule fixed here is fixed for every runtime — the alternative, one
 * collector per runtime, is the two-path defect class t-b4a799 catalogued.
 *
 * Every read is best-effort: a missing file means "we could not see this", never a thrown error,
 * because an inspector that fails closed teaches nothing. What it must never do is guess — an absent
 * value is reported absent (`notExposed`), following parity.md's rule that code wins over prose.
 */

export interface SessionInspectionPorts {
  /** OS pid of the agent's pane, when a live session exists. */
  panePid: (agent: string) => Promise<number | undefined>;
  /** argv of a pid, NUL-split as `/proc/<pid>/cmdline` gives it. Undefined when unreadable. */
  processArgv: (pid: number) => string[] | undefined;
  /** environ of a pid. Undefined when unreadable (another user's process, or gone). */
  processEnv: (pid: number) => Record<string, string> | undefined;
}

/**
 * A runtime with no reader reports what the process itself shows and names the rest as unknown. Codex
 * and Grok have a different shape (one regenerated `config.toml`, no `--settings`) and get their own
 * readers rather than being forced into Claude's mould.
 */
const RUNTIME_READERS: Readonly<Record<string, RuntimeSessionReader>> = {
  claude: claudeSessionReader,
};

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

export async function collectSessionInspection(input: {
  workspaceRoot: string;
  agent: string;
  runtime: string;
  ports: SessionInspectionPorts;
}): Promise<InspectedSession> {
  const { workspaceRoot, agent, runtime, ports } = input;
  const reader = RUNTIME_READERS[runtime];

  const pid = await ports.panePid(agent).catch(() => undefined);
  const env = pid === undefined ? undefined : ports.processEnv(pid);
  const argv = pid === undefined ? undefined : ports.processArgv(pid);

  const found = reader?.read({ workspaceRoot, agent, env, argv });
  const config = reader?.config;
  const globalKeys = new Set(found?.globalKeys ?? []);

  const settings: InspectedSetting[] = (found?.settings ?? []).map((entry) => ({
    key: entry.key,
    value: renderValue(entry.value),
    origin: entry.hostAuthored
      ? "host"
      : classifySetting(entry.key, {
        projectable: config?.projectableKeys ?? [],
        hostInjected: config?.hostKeys ?? [],
        agentOwned: config?.agentOwnedKeys ?? [],
      }, globalKeys.has(entry.key)),
  }));

  // A global key that is NOT projectable never reaches the agent. Surfacing it is the single most
  // useful row here: it is the shape of defect that took three releases to find in t-084b28.
  for (const key of globalKeys) {
    if (settings.some((setting) => setting.key === key)) continue;
    if ((config?.projectableKeys ?? []).includes(key)) continue;
    settings.push({ key, value: "(not delivered to this agent)", origin: "not-projected" });
  }

  const secrets = Object.entries(env ?? {})
    .filter(([key]) => key.toUpperCase().includes("TOKEN") || key.toUpperCase().includes("SECRET"))
    .map(([, value]) => value);

  return {
    agent,
    runtime,
    state: argv ? "live" : "last-known",
    command: argv ? redactCommand(argv, secrets) : [],
    hooks: found?.hooks ?? [],
    settings: foldWrappedStatusLine(settings, found?.wrappedStatusLine),
    mcpServers: found?.mcpServers ?? [],
    strictMcp: (argv ?? []).includes("--strict-mcp-config"),
    env: inspectEnv(env ?? {}, config?.extraEnvKeys ?? []),
    notExposed: [
      ...(found?.notExposed ?? []),
      ...(reader ? [] : [`Tachyon does not yet describe what it injects into '${runtime}' sessions`]),
      ...(argv ? [] : ["no live process — showing what is on disk from the last launch"]),
    ],
  };
}
