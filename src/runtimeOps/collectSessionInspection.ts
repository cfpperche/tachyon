import {
  classifySetting,
  foldProseArguments,
  foldWrappedStatusLine,
  inspectEnv,
  redactCommand,
  redactSessionArguments,
  redactSettingValue,
  type InspectedSession,
  type InspectedSetting,
} from "./sessionInspection.js";
import { claudeSessionReader } from "./claudeSessionReader.js";
import { codexSessionReader } from "./codexSessionReader.js";
import { grokSessionReader } from "./grokSessionReader.js";
import type { RuntimeSessionReader } from "./sessionSources.js";
import {
  planProjectedPluginHooks,
  readHookProjectionCandidates,
  type AgentHookProjectionPolicy,
} from "../plugins/agentHookProjection.js";

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
  codex: codexSessionReader,
  grok: grokSessionReader,
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

/** Render, then redact: a secret key must never depend on a length heuristic to stay hidden. */
function renderSettingValue(key: string, value: unknown): string {
  return redactSettingValue(key, renderValue(value));
}

/**
 * t-141f61 — which enforcement gates the workspace asked for and did NOT get here.
 *
 * Recomputed from the SAME pure planner every spawn door already calls (authority lockfile ×
 * classification × runtime), never a second opinion parallel to it: the projection module's own
 * header states the plan is a pure function of those three, so this panel is one more door onto it
 * rather than a copy that can drift.
 *
 * Filtered to plugins the human CLASSIFIED, matching the spawn-time notice rule: an unclassified
 * plugin is the default state, not a refusal, and thirteen of those rows would bury the one that
 * means "this agent has no gate".
 */
function withheldGates(
  workspaceRoot: string,
  runtime: string,
  policy: AgentHookProjectionPolicy | undefined,
): { plugin: string; reason: string }[] {
  if (!policy || Object.keys(policy).length === 0) return [];
  const plan = planProjectedPluginHooks({
    plugins: readHookProjectionCandidates(workspaceRoot),
    runtime,
    policy,
  });
  return plan.withheld
    .filter((entry) => policy[entry.plugin] !== undefined)
    .map((entry) => ({ plugin: entry.plugin, reason: entry.reason }));
}

export async function collectSessionInspection(input: {
  workspaceRoot: string;
  agent: string;
  runtime: string;
  ports: SessionInspectionPorts;
  /**
   * `settings.agentHookProjection` — the workspace's plugin classification. Absent means the caller
   * has no policy to report against, which yields no withheld rows rather than a false all-clear:
   * a workspace that classified nothing asked for nothing.
   */
  hookProjectionPolicy?: AgentHookProjectionPolicy;
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
    value: renderSettingValue(entry.key, entry.value),
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

  // Redact BEFORE folding: a secret must never depend on a length heuristic to stay hidden.
  // Session ids are redacted by flag, not by value shape — Grok's `-s <uuid>` is otherwise legible
  // in the launch command, and the panel's rule is show that a session exists, not which one.
  const launch = foldProseArguments(argv ? redactSessionArguments(redactCommand(argv, secrets)) : []);

  return {
    agent,
    runtime,
    state: argv ? "live" : "last-known",
    command: launch.command,
    hooks: found?.hooks ?? [],
    settings: foldWrappedStatusLine(settings, found?.wrappedStatusLine),
    mcpServers: found?.mcpServers ?? [],
    strictMcp: (argv ?? []).includes("--strict-mcp-config"),
    env: inspectEnv(env ?? {}, config?.extraEnvKeys ?? []),
    gatesWithheld: withheldGates(workspaceRoot, runtime, input.hookProjectionPolicy),
    notExposed: [
      ...(found?.notExposed ?? []),
      // Summarized, and SAID to be summarized. The full text is in .tachyon/briefs/spawn/<agent>.md
      // and the agent's own pane; what this panel owes is the flags, legibly.
      ...(launch.folded > 0
        ? ["the opening brief is passed on the command line and is summarized above, not printed"]
        : []),
      ...(reader ? [] : [`Tachyon does not yet describe what it injects into '${runtime}' sessions`]),
      ...(argv ? [] : ["no live process — showing what is on disk from the last launch"]),
    ],
  };
}
