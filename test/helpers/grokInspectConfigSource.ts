import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  AgentObservationScopeV1,
  CollectorDiagnosticCodeV1,
  CollectorEnvelopeV1,
  ProviderConfigurationCompatCellV1,
  ProviderConfigurationFactV1,
  ProviderObservationScopeV1,
  ProviderUnavailableReasonV1,
} from "@tachyon/engine/runtimeObservability/types.js";
import {
  PROVIDER_CONFIGURATION_READ_CAPABILITY,
  type ConfigurationObservationRequestV1,
  type ConfigurationObservationSource,
} from "@tachyon/engine/runtimeObservability/source.js";
import { validateCollectorEnvelopeV1 } from "@tachyon/engine/runtimeObservability/validate.js";

const GROK_COMMAND = "grok";
const GROK_ARGS = ["inspect", "--json"] as const;
const COLLECTOR = { id: "tachyon-grok-cli", version: "1.0.0" } as const;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const SHUTDOWN_GRACE_MS = 250;
const SHUTDOWN_ABANDON_MS = 1_000;
const MAX_CONFIG_LAYER_ROLES = 16;
const MAX_MCP_SERVER_NAMES = 64;
const MAX_COMPAT_CELLS = 32;
const SAFE_AGENT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_GROK_HOME = /^\/[^\0]{0,4095}$/u;
const SAFE_CONFIG_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;

type GrokInspectFailureReason =
  | "timeout"
  | "cancelled"
  | "provider-error"
  | "invalid-payload";

type InspectOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; reason: GrokInspectFailureReason };

export type GrokInspectSpawn = (
  command: typeof GROK_COMMAND,
  args: readonly string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
  },
) => ChildProcessWithoutNullStreams;

export interface GrokInspectConfigSourceOptions {
  /** Whole `grok inspect --json` deadline. Bounded to 30 seconds. */
  timeoutMs?: number;
  /** Test seam only; product configuration cannot replace the fixed `grok` command or argv. */
  spawn?: GrokInspectSpawn;
  now?: () => Date;
}

/**
 * Grok **configuration** source backed by documented `grok inspect --json`.
 *
 * Measured (grok 0.2.118): inspect returns machine-readable config (agents, channel, configSources,
 * externalCompat, mcpServers, permissions, …) and **no** remaining-quota channel. This adapter
 * projects only an allowlisted structural subset and declares the quota axis unsupported by name.
 * It never invents `provider-quota` from session token spend.
 */
export class GrokInspectConfigObservationSource implements ConfigurationObservationSource {
  readonly runtime = "grok" as const;
  readonly source = "cli" as const;

  private readonly timeoutMs: number;
  private readonly spawn: GrokInspectSpawn;
  private readonly now: () => Date;

  constructor(options: GrokInspectConfigSourceOptions = {}) {
    this.timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.spawn = options.spawn ?? defaultGrokInspectSpawn;
    this.now = options.now ?? (() => new Date());
  }

  async observe(request: ConfigurationObservationRequestV1): Promise<CollectorEnvelopeV1> {
    const observedAt = this.now().toISOString();
    const scope = safeAgentScope(request.scope);
    if (!scope) return unavailableEnvelope(providerScope(), "invalid-payload", observedAt);

    try {
      const grant: unknown = request.grant;
      if (record(grant) && grant.state === "disabled") {
        return unavailableEnvelope(scope, "source-disabled", observedAt);
      }
      if (!record(grant)
        || grant.state !== "granted"
        || grant.capability !== PROVIDER_CONFIGURATION_READ_CAPABILITY
        || grant.consent !== "explicit-user"
        || grant.source !== this.source) {
        return unavailableEnvelope(scope, "unsupported", observedAt);
      }

      const grokHome = safeGrokHome(request.grokHome);
      if (!grokHome) return unavailableEnvelope(scope, "invalid-payload", observedAt);
      if (request.signal?.aborted) return unavailableEnvelope(scope, "cancelled", observedAt);

      const coBindHome = request.coBindHome !== false;
      const outcome = await collectGrokInspect(
        this.spawn,
        this.timeoutMs,
        {
          grokHome,
          cwd: typeof request.cwd === "string" && request.cwd.length > 0 ? request.cwd : undefined,
          coBindHome,
        },
        request.signal,
      );
      if (!outcome.ok) return unavailableEnvelope(scope, outcome.reason, observedAt);

      const fact = projectInspectPayload(outcome.payload, scope, observedAt);
      if (!fact) return unavailableEnvelope(scope, "invalid-payload", observedAt);

      // Configuration only. Quota is refused by name on the fact; never emit provider-quota here.
      return validatedOrUnavailable({
        schemaVersion: 1,
        collector: COLLECTOR,
        generatedAt: observedAt,
        facts: [fact],
        diagnostics: [],
      }, observedAt);
    } catch {
      return unavailableEnvelope(scope, "invalid-payload", observedAt);
    }
  }
}

const defaultGrokInspectSpawn: GrokInspectSpawn = (command, args, options) => nodeSpawn(command, [...args], {
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  cwd: options.cwd,
  env: options.env,
});

async function collectGrokInspect(
  spawn: GrokInspectSpawn,
  timeoutMs: number,
  target: { grokHome: string; cwd?: string; coBindHome: boolean },
  signal?: AbortSignal,
): Promise<InspectOutcome> {
  if (signal?.aborted) return { ok: false, reason: "cancelled" };

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GROK_HOME: target.grokHome,
  };
  if (target.coBindHome) {
    env.HOME = target.grokHome;
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(GROK_COMMAND, GROK_ARGS, { cwd: target.cwd, env });
  } catch {
    return { ok: false, reason: "provider-error" };
  }

  return new Promise<InspectOutcome>((resolve) => {
    let stdoutBuffer = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finalOutcome: InspectOutcome | undefined;
    let closed = false;
    let resolved = false;
    let escalationTimer: NodeJS.Timeout | undefined;
    let abandonTimer: NodeJS.Timeout | undefined;

    const timeoutTimer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (abandonTimer) clearTimeout(abandonTimer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.removeListener("data", onStdoutData);
      child.stderr.removeListener("data", onStderrData);
      // Keep error listeners after bounded abandon so a late pathological error cannot crash the host.
      child.removeListener("close", onClose);
      stdoutBuffer = Buffer.alloc(0);
    };

    const resolveOnce = () => {
      if (resolved || !finalOutcome) return;
      resolved = true;
      cleanup();
      resolve(finalOutcome);
    };

    const requestShutdown = () => {
      if (closed) {
        resolveOnce();
        return;
      }
      try { child.stdin.end(); } catch { /* Process teardown remains best-effort. */ }
      escalationTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* Process may already be gone. */ }
      }, SHUTDOWN_GRACE_MS);
      abandonTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* Process may already be gone. */ }
        resolveOnce();
      }, SHUTDOWN_ABANDON_MS);
      try { child.kill("SIGTERM"); } catch { resolveOnce(); }
    };

    function finish(outcome: InspectOutcome): void {
      if (finalOutcome) return;
      finalOutcome = outcome;
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
      requestShutdown();
    }

    function onStdoutData(chunk: Buffer | string): void {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += data.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        finish({ ok: false, reason: "invalid-payload" });
        return;
      }
      stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
    }

    function onStderrData(chunk: Buffer | string): void {
      stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (stderrBytes > MAX_STDERR_BYTES) finish({ ok: false, reason: "invalid-payload" });
    }

    function onAbort(): void {
      finish({ ok: false, reason: "cancelled" });
    }

    function onStreamError(): void {
      finish({ ok: false, reason: "provider-error" });
    }

    function onChildError(): void {
      finish({ ok: false, reason: "provider-error" });
    }

    function onClose(code: number | null): void {
      closed = true;
      if (!finalOutcome) finalOutcome = classifyInspectStdout(stdoutBuffer, code);
      resolveOnce();
    }

    child.stdout.on("data", onStdoutData);
    child.stdout.on("error", onStreamError);
    child.stderr.on("data", onStderrData);
    child.stderr.on("error", onStreamError);
    child.stdin.on("error", onStreamError);
    child.once("error", onChildError);
    child.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });

    try { child.stdin.end(); } catch { finish({ ok: false, reason: "provider-error" }); }
  });
}

function classifyInspectStdout(stdout: Buffer, exitCode: number | null): InspectOutcome {
  if (stdout.length === 0) {
    return { ok: false, reason: exitCode === 0 ? "invalid-payload" : "provider-error" };
  }
  try {
    const payload = JSON.parse(stdout.toString("utf8")) as unknown;
    if (!record(payload)) {
      return { ok: false, reason: "invalid-payload" };
    }
    // Incomplete JSON that still parses as an object is not a full inspect result — fail closed.
    if (typeof payload.grokVersion !== "string" && !record(payload.configSources)) {
      return { ok: false, reason: "invalid-payload" };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: exitCode === 0 ? "invalid-payload" : "provider-error" };
  }
}

/**
 * Project only the allowlisted structural fields. Paths, headers, targets, tokens, session ids and
 * free-form instruction text are dropped — never forwarded into the envelope.
 */
function projectInspectPayload(
  raw: unknown,
  scope: AgentObservationScopeV1,
  observedAt: string,
): ProviderConfigurationFactV1 | undefined {
  try {
    if (!record(raw)) return undefined;

    // Refuse to treat spend/usage-shaped fields as configuration success or as synthetic quota.
    if (hasForbiddenQuotaShape(raw)) return undefined;

    const configLayerRoles = projectLayerRoles(raw.configSources);
    const mcpServerNames = projectMcpNames(raw.mcpServers);
    const externalCompat = projectCompatCells(raw.externalCompat);
    if (configLayerRoles === undefined || mcpServerNames === undefined || externalCompat === undefined) {
      return undefined;
    }

    const fact: ProviderConfigurationFactV1 = {
      kind: "provider-configuration",
      scope,
      runtime: "grok",
      source: "cli",
      confidence: "exact",
      observedAt,
      freshness: { state: "fresh" },
      quotaChannel: { state: "unsupported", reason: "no-quota-channel" },
      configLayerRoles,
      mcpServerNames,
      externalCompat,
    };

    if (typeof raw.grokVersion === "string" && SAFE_VERSION.test(raw.grokVersion)) {
      fact.grokVersion = raw.grokVersion;
    }
    if (typeof raw.projectTrusted === "boolean") {
      fact.projectTrusted = raw.projectTrusted;
    }
    const permissions = record(raw.permissions) ? raw.permissions : undefined;
    if (permissions && typeof permissions.loaded === "number" && Number.isSafeInteger(permissions.loaded)
      && permissions.loaded >= 0) {
      fact.permissionsLoaded = permissions.loaded;
    }

    // Require at least one structural signal so an empty `{}` cannot look like a complete observation.
    if (fact.grokVersion === undefined
      && fact.configLayerRoles.length === 0
      && fact.mcpServerNames.length === 0
      && fact.externalCompat.length === 0
      && fact.permissionsLoaded === undefined) {
      return undefined;
    }
    return fact;
  } catch {
    return undefined;
  }
}

function hasForbiddenQuotaShape(raw: Record<string, unknown>): boolean {
  // If a future inspect adds a real quota object we do not silently absorb it into this config source.
  for (const key of ["rateLimits", "rate_limits", "quota", "usage", "limits", "credits"] as const) {
    if (raw[key] !== undefined && raw[key] !== null) return true;
  }
  return false;
}

function projectLayerRoles(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!record(raw)) return undefined;
  const layers = raw.layers;
  if (layers === undefined || layers === null) return [];
  if (!Array.isArray(layers)) return undefined;
  if (layers.length > MAX_CONFIG_LAYER_ROLES) return undefined;
  const roles: string[] = [];
  for (const layer of layers) {
    if (!record(layer)) return undefined;
    const role = layer.role;
    if (typeof role !== "string" || !SAFE_CONFIG_TOKEN.test(role)) return undefined;
    // path is deliberately ignored — absolute homes must not enter the projection.
    roles.push(role);
  }
  return roles;
}

function projectMcpNames(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return undefined;
  if (raw.length > MAX_MCP_SERVER_NAMES) return undefined;
  const names: string[] = [];
  for (const server of raw) {
    if (!record(server)) return undefined;
    const name = server.name;
    if (typeof name !== "string" || !SAFE_CONFIG_TOKEN.test(name)) return undefined;
    // target / headers / env / command are never projected.
    names.push(name);
  }
  return names;
}

function projectCompatCells(raw: unknown): ProviderConfigurationCompatCellV1[] | undefined {
  if (raw === undefined || raw === null) return [];
  if (!record(raw)) return undefined;
  const cells = raw.cells;
  if (cells === undefined || cells === null) return [];
  if (!Array.isArray(cells)) return undefined;
  if (cells.length > MAX_COMPAT_CELLS) return undefined;
  const out: ProviderConfigurationCompatCellV1[] = [];
  for (const cell of cells) {
    if (!record(cell)) return undefined;
    const vendor = cell.vendor;
    const surface = cell.surface;
    const source = cell.source;
    const enabled = cell.enabled;
    if (typeof vendor !== "string" || !SAFE_CONFIG_TOKEN.test(vendor)) return undefined;
    if (typeof surface !== "string" || !SAFE_CONFIG_TOKEN.test(surface)) return undefined;
    if (typeof source !== "string" || !SAFE_CONFIG_TOKEN.test(source)) return undefined;
    if (typeof enabled !== "boolean") return undefined;
    out.push({ vendor, surface, enabled, source });
  }
  return out;
}

function unavailableEnvelope(
  _scope: AgentObservationScopeV1 | ProviderObservationScopeV1,
  reason: ProviderUnavailableReasonV1,
  observedAt: string,
): CollectorEnvelopeV1 {
  const diagnosticCode: CollectorDiagnosticCodeV1 = reason === "timeout"
    ? "SOURCE_TIMEOUT"
    : reason === "cancelled"
      ? "SOURCE_CANCELLED"
      : reason === "invalid-payload"
        ? "INVALID_PAYLOAD"
        : "SOURCE_UNAVAILABLE";
  // Unavailable facts only accept provider / provider-account scopes. Configuration failures still
  // name the runtime (`grok`) without inventing an account key or leaking agent identity here.
  const candidate: CollectorEnvelopeV1 = {
    schemaVersion: 1,
    collector: COLLECTOR,
    generatedAt: observedAt,
    facts: [{
      kind: "provider-unavailable",
      scope: { kind: "provider", provider: "grok" },
      source: "cli",
      observedAt,
      reason,
    }],
    diagnostics: [{ code: diagnosticCode, provider: "grok", factIndex: 0 }],
  };
  const validated = validateCollectorEnvelopeV1(candidate);
  if (validated.ok) return validated.value;
  throw new Error("invalid adapter-owned unavailable envelope");
}

function validatedOrUnavailable(candidate: CollectorEnvelopeV1, observedAt: string): CollectorEnvelopeV1 {
  const validated = validateCollectorEnvelopeV1(candidate);
  return validated.ok ? validated.value : unavailableEnvelope(providerScope(), "invalid-payload", observedAt);
}

function safeAgentScope(raw: AgentObservationScopeV1): AgentObservationScopeV1 | undefined {
  try {
    if (raw.kind !== "agent"
      || typeof raw.workspaceKey !== "string" || !SAFE_AGENT_KEY.test(raw.workspaceKey)
      || typeof raw.agentKey !== "string" || !SAFE_AGENT_KEY.test(raw.agentKey)) {
      return undefined;
    }
    return { kind: "agent", workspaceKey: raw.workspaceKey, agentKey: raw.agentKey };
  } catch {
    return undefined;
  }
}

function safeGrokHome(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return undefined;
  if (!SAFE_GROK_HOME.test(raw)) return undefined;
  if (raw.includes("\0") || raw.includes("\n") || raw.includes("\r")) return undefined;
  // Reject relative homes — ambient resolution would observe the wrong agent.
  if (!raw.startsWith("/")) return undefined;
  return raw;
}

function providerScope(): ProviderObservationScopeV1 {
  return { kind: "provider", provider: "grok" };
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new TypeError(`Grok inspect timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}ms`);
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
