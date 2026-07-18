/**
 * Pure view-model for the Engine/Bridge Control Inspector (POC).
 * Sibling of the tmux Server Inspector — different domain, same product pattern.
 */

export type EngineAttachState = "attached" | "error" | "none";

export interface ControlInspectorEngineSlice {
  state: EngineAttachState;
  pid?: number;
  instanceId?: string;
  processStartIdentity?: string;
  startedAt?: string;
  bundleId?: string;
  channel?: "stable" | "dev" | "legacy";
  engineVersion?: string;
  protocolMin?: number;
  protocolMax?: number;
  error?: string;
  /** t-cd3626 V1 — recent daemon console lines (newest last). */
  logTail?: string[];
  /** V2 multi-source. */
  logBySource?: { daemon: string[]; events?: string[]; bridge?: string[] };
  logHasError?: boolean;
}

export interface ControlInspectorBridgeSlice {
  url: string;
  port?: number;
  instanceId?: string;
  /** Never the token — only whether auth is configured when known. */
  authConfigured?: boolean | "unknown";
}

export interface ControlInspectorWorkspaceRow {
  folderName: string;
  workspaceRoot: string;
  wsHash: string;
  engine: ControlInspectorEngineSlice;
  bridge: ControlInspectorBridgeSlice;
  agents?: { total: number; running: number };
  /** Short human notes (e.g. "multi-root folder", "bridge direct"). */
  notes: string[];
}

export interface ControlInspectorModel {
  /** POC banner — remove when productized. */
  poc: true;
  checkedAt: string;
  workspaces: ControlInspectorWorkspaceRow[];
  summary: {
    workspaceCount: number;
    attachedEngines: number;
    engineErrors: number;
    totalAgents: number;
    runningAgents: number;
  };
}

export interface ControlInspectorWorkspaceInput {
  folderName: string;
  workspaceRoot: string;
  wsHash: string;
  bridgeUrl: string;
  identity?: {
    pid: number;
    instanceId: string;
    processStartIdentity: string;
    startedAt: string;
    bundleId: string;
    channel?: "stable" | "dev";
    engineVersion: string;
    protocol?: { min: number; max: number };
    bridge?: { instanceId: string; port: number };
  } | null;
  /** t-cd3626 — optional daemon log tail from health. */
  logTail?: string[];
  logBySource?: { daemon: string[]; events?: string[]; bridge?: string[] };
  logHasError?: boolean;
  identityError?: string;
  agents?: { total: number; running: number };
  authConfigured?: boolean | "unknown";
  notes?: string[];
}

export function buildControlInspectorModel(
  inputs: ControlInspectorWorkspaceInput[],
  nowIso: string = new Date().toISOString(),
): ControlInspectorModel {
  const workspaces = inputs.map(rowFromInput);
  let attachedEngines = 0;
  let engineErrors = 0;
  let totalAgents = 0;
  let runningAgents = 0;
  for (const w of workspaces) {
    if (w.engine.state === "attached") attachedEngines++;
    if (w.engine.state === "error") engineErrors++;
    totalAgents += w.agents?.total ?? 0;
    runningAgents += w.agents?.running ?? 0;
  }
  return {
    poc: true,
    checkedAt: nowIso,
    workspaces,
    summary: {
      workspaceCount: workspaces.length,
      attachedEngines,
      engineErrors,
      totalAgents,
      runningAgents,
    },
  };
}

function rowFromInput(input: ControlInspectorWorkspaceInput): ControlInspectorWorkspaceRow {
  const portFromUrl = parseBridgePort(input.bridgeUrl);
  const notes = [...(input.notes ?? [])];

  let engine: ControlInspectorEngineSlice;
  if (input.identityError) {
    engine = { state: "error", error: input.identityError };
  } else if (input.identity) {
    const id = input.identity;
    engine = {
      state: "attached",
      pid: id.pid,
      instanceId: id.instanceId,
      processStartIdentity: id.processStartIdentity,
      startedAt: id.startedAt,
      bundleId: id.bundleId,
      channel: id.channel ?? "legacy",
      engineVersion: id.engineVersion,
      protocolMin: id.protocol?.min,
      protocolMax: id.protocol?.max,
      ...(input.logTail && input.logTail.length > 0 ? { logTail: input.logTail } : {}),
      ...(input.logBySource ? { logBySource: input.logBySource } : {}),
      ...(input.logHasError ? { logHasError: true } : {}),
    };
  } else {
    engine = { state: "none" };
    notes.push("no engine identity (shell not attached?)");
  }

  const bridgePort = input.identity?.bridge?.port ?? portFromUrl;
  const bridge: ControlInspectorBridgeSlice = {
    url: input.bridgeUrl,
    port: bridgePort,
    instanceId: input.identity?.bridge?.instanceId,
    authConfigured: input.authConfigured ?? "unknown",
  };

  return {
    folderName: input.folderName,
    workspaceRoot: input.workspaceRoot,
    wsHash: input.wsHash,
    engine,
    bridge,
    agents: input.agents,
    notes,
  };
}

export function parseBridgePort(bridgeUrl: string): number | undefined {
  try {
    const u = new URL(bridgeUrl);
    if (u.port) return Number(u.port);
    if (u.protocol === "https:") return 443;
    if (u.protocol === "http:") return 80;
  } catch {
    /* fall through */
  }
  const m = bridgeUrl.match(/:(\d{2,5})\b/);
  return m ? Number(m[1]) : undefined;
}

/** Clipboard-friendly diagnostics block (no secrets). */
export function formatControlInspectorDiagnostics(model: ControlInspectorModel): string {
  const lines: string[] = [
    `Tachyon Engine/Bridge Inspector (POC)`,
    `checkedAt: ${model.checkedAt}`,
    `workspaces: ${model.summary.workspaceCount} · engines attached: ${model.summary.attachedEngines} · errors: ${model.summary.engineErrors}`,
    `agents: ${model.summary.runningAgents}/${model.summary.totalAgents} running`,
    "",
  ];
  for (const w of model.workspaces) {
    lines.push(`## ${w.folderName} (${w.wsHash})`);
    lines.push(`root: ${w.workspaceRoot}`);
    lines.push(`engine: ${w.engine.state}` + (w.engine.pid !== undefined ? ` pid=${w.engine.pid}` : ""));
    if (w.engine.engineVersion) lines.push(`  version: ${w.engine.engineVersion}`);
    if (w.engine.channel) lines.push(`  channel: ${w.engine.channel}`);
    if (w.engine.instanceId) lines.push(`  instanceId: ${w.engine.instanceId}`);
    if (w.engine.processStartIdentity) lines.push(`  processStartIdentity: ${w.engine.processStartIdentity}`);
    if (w.engine.startedAt) lines.push(`  startedAt: ${w.engine.startedAt}`);
    if (w.engine.bundleId) lines.push(`  bundleId: ${w.engine.bundleId}`);
    if (w.engine.error) lines.push(`  error: ${w.engine.error}`);
    lines.push(`bridge: ${w.bridge.url}`);
    if (w.bridge.port !== undefined) lines.push(`  port: ${w.bridge.port}`);
    if (w.bridge.instanceId) lines.push(`  bridgeInstanceId: ${w.bridge.instanceId}`);
    lines.push(`  authConfigured: ${String(w.bridge.authConfigured ?? "unknown")}`);
    if (w.agents) lines.push(`agents: ${w.agents.running}/${w.agents.total} running`);
    for (const n of w.notes) lines.push(`note: ${n}`);
    lines.push("");
  }
  return lines.join("\n");
}
