import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  CollectorDiagnosticCodeV1,
  CollectorEnvelopeV1,
  ProviderAccountObservationScopeV1,
  ProviderObservationScopeV1,
  ProviderQuotaFactV1,
  ProviderUnavailableReasonV1,
} from "./types.js";
import {
  PROVIDER_QUOTA_READ_CAPABILITY,
  type ProviderObservationRequestV1,
  type ProviderObservationSource,
} from "./source.js";
import { validateCollectorEnvelopeV1 } from "./validate.js";

const GROK_COMMAND = "grok";
const GROK_ARGS = ["agent", "--no-leader", "stdio"] as const;
const COLLECTOR = { id: "tachyon-grok-cli", version: "1.0.0" } as const;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 128 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const SHUTDOWN_GRACE_MS = 250;
const SHUTDOWN_ABANDON_MS = 1_000;
const SAFE_PROVIDER_SCOPE_KEY = /^ps_[0-9a-f]{16,64}$/u;

type GrokFailureReason = "timeout" | "cancelled" | "provider-error" | "invalid-payload";
type GrokBillingOutcome =
  | { ok: true; billingResult: unknown }
  | { ok: false; reason: GrokFailureReason };

export type GrokUsageSpawn = (
  command: typeof GROK_COMMAND,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

export interface GrokUsageSourceOptions {
  timeoutMs?: number;
  /** Test seam only; product code cannot replace the fixed command or argv. */
  spawn?: GrokUsageSpawn;
  now?: () => Date;
}

/**
 * Grok quota source backed by the CLI's ACP billing extension. `_x.ai/billing` is the same
 * control-plane request used by `/usage`; it does not create a session or an inference turn.
 */
export class GrokUsageObservationSource implements ProviderObservationSource {
  readonly provider = "grok" as const;
  readonly source = "cli" as const;
  readonly channel = {
    acquisition: "control-plane",
    mechanism: "grok agent stdio ACP _x.ai/billing request (the token-free /usage control plane)",
  } as const;

  private readonly timeoutMs: number;
  private readonly spawn: GrokUsageSpawn;
  private readonly now: () => Date;

  constructor(options: GrokUsageSourceOptions = {}) {
    this.timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.spawn = options.spawn ?? defaultGrokUsageSpawn;
    this.now = options.now ?? (() => new Date());
  }

  async observe(request: ProviderObservationRequestV1): Promise<CollectorEnvelopeV1> {
    const observedAt = this.now().toISOString();
    const scope = safeGrokScope(request.scope);
    if (!scope) return unavailableEnvelope(providerScope(), "invalid-payload", observedAt);

    try {
      const grant: unknown = request.grant;
      const grantRecord = record(grant);
      if (grantRecord?.state === "disabled") {
        return unavailableEnvelope(scope, "source-disabled", observedAt);
      }
      if (!grantRecord
        || grantRecord.state !== "granted"
        || grantRecord.capability !== PROVIDER_QUOTA_READ_CAPABILITY
        || grantRecord.consent !== "explicit-user"
        || grantRecord.source !== this.source) {
        return unavailableEnvelope(scope, "unsupported", observedAt);
      }
      if (request.signal?.aborted) return unavailableEnvelope(scope, "cancelled", observedAt);

      const outcome = await collectGrokBilling(this.spawn, this.timeoutMs, request.signal);
      if (!outcome.ok) return unavailableEnvelope(scope, outcome.reason, observedAt);
      const quota = projectBilling(outcome.billingResult, scope, observedAt);
      if (!quota) return unavailableEnvelope(scope, "invalid-payload", observedAt);
      return validatedOrUnavailable({
        schemaVersion: 1,
        collector: COLLECTOR,
        generatedAt: observedAt,
        facts: [quota],
        diagnostics: [],
      }, observedAt);
    } catch {
      return unavailableEnvelope(scope, "invalid-payload", observedAt);
    }
  }
}

const defaultGrokUsageSpawn: GrokUsageSpawn = (command, args) => nodeSpawn(command, [...args], {
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

async function collectGrokBilling(
  spawn: GrokUsageSpawn,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<GrokBillingOutcome> {
  if (signal?.aborted) return { ok: false, reason: "cancelled" };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(GROK_COMMAND, GROK_ARGS);
  } catch {
    return { ok: false, reason: "provider-error" };
  }

  return new Promise<GrokBillingOutcome>((resolve) => {
    let expectedId = 1;
    let stdoutBuffer = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finalOutcome: GrokBillingOutcome | undefined;
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
      if (closed) return resolveOnce();
      try { child.stdin.end(); } catch { /* best-effort teardown */ }
      escalationTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* process may already be gone */ }
      }, SHUTDOWN_GRACE_MS);
      abandonTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* process may already be gone */ }
        resolveOnce();
      }, SHUTDOWN_ABANDON_MS);
      try { child.kill("SIGTERM"); } catch { resolveOnce(); }
    };
    function finish(outcome: GrokBillingOutcome): void {
      if (finalOutcome) return;
      finalOutcome = outcome;
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
      requestShutdown();
    }
    function send(payload: Record<string, unknown>): void {
      try { child.stdin.write(`${JSON.stringify(payload)}\n`); }
      catch { finish({ ok: false, reason: "provider-error" }); }
    }
    function handleMessage(raw: unknown): void {
      const message = record(raw);
      if (!message) return finish({ ok: false, reason: "invalid-payload" });
      if (message.id === undefined) {
        if (typeof message.method !== "string") finish({ ok: false, reason: "invalid-payload" });
        return;
      }
      if (message.id !== expectedId) return finish({ ok: false, reason: "invalid-payload" });
      if (message.error !== undefined) return finish({ ok: false, reason: "provider-error" });
      if (!("result" in message)) return finish({ ok: false, reason: "invalid-payload" });
      if (expectedId === 1) {
        const initializeResult = record(message.result);
        if (!initializeResult || initializeResult.protocolVersion !== 1) {
          return finish({ ok: false, reason: "invalid-payload" });
        }
        expectedId = 2;
        send({ jsonrpc: "2.0", id: 2, method: "_x.ai/billing", params: {} });
        return;
      }
      finish({ ok: true, billingResult: message.result });
    }
    function onStdoutData(chunk: Buffer | string): void {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += data.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) return finish({ ok: false, reason: "invalid-payload" });
      stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
      while (!finalOutcome) {
        const newline = stdoutBuffer.indexOf(0x0a);
        if (newline < 0) break;
        let line = stdoutBuffer.subarray(0, newline);
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
        if (line.length === 0) continue;
        if (line.length > MAX_LINE_BYTES) return finish({ ok: false, reason: "invalid-payload" });
        try { handleMessage(JSON.parse(line.toString("utf8")) as unknown); }
        catch { finish({ ok: false, reason: "invalid-payload" }); }
      }
      if (!finalOutcome && stdoutBuffer.length > MAX_LINE_BYTES) finish({ ok: false, reason: "invalid-payload" });
    }
    function onStderrData(chunk: Buffer | string): void {
      stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (stderrBytes > MAX_STDERR_BYTES) finish({ ok: false, reason: "invalid-payload" });
    }
    function onAbort(): void { finish({ ok: false, reason: "cancelled" }); }
    function onStreamError(): void { finish({ ok: false, reason: "provider-error" }); }
    function onClose(): void {
      closed = true;
      if (!finalOutcome) finalOutcome = { ok: false, reason: "provider-error" };
      resolveOnce();
    }
    child.stdout.on("data", onStdoutData);
    child.stderr.on("data", onStderrData);
    child.stdout.on("error", onStreamError);
    child.stderr.on("error", onStreamError);
    child.stdin.on("error", onStreamError);
    child.on("error", onStreamError);
    child.on("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "tachyon-runtime-observability", title: "Tachyon Runtime Observability", version: "1.0.0" },
      },
    });
  });
}

function projectBilling(
  raw: unknown,
  scope: ProviderAccountObservationScopeV1,
  observedAt: string,
): ProviderQuotaFactV1 | undefined {
  const result = record(raw);
  const config = record(result?.config);
  const period = record(config?.currentPeriod);
  const usedPercent = config?.creditUsagePercent;
  const resetsAt = timestamp(period?.end);
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)
    || usedPercent < 0 || usedPercent > 100
    || period?.type !== "USAGE_PERIOD_TYPE_WEEKLY" || !timestamp(period.start) || !resetsAt) {
    return undefined;
  }
  return {
    kind: "provider-quota",
    scope,
    source: "cli",
    confidence: "exact",
    observedAt,
    freshness: { state: "fresh" },
    windows: [{ name: "weekly", usedPercent, resetsAt }],
  };
}

function safeGrokScope(scope: ProviderAccountObservationScopeV1): ProviderAccountObservationScopeV1 | undefined {
  return scope?.kind === "provider-account" && scope.provider === "grok" && SAFE_PROVIDER_SCOPE_KEY.test(scope.key)
    ? scope
    : undefined;
}

function providerScope(): ProviderObservationScopeV1 {
  return { kind: "provider", provider: "grok" };
}

function unavailableEnvelope(
  scope: ProviderObservationScopeV1 | ProviderAccountObservationScopeV1,
  reason: ProviderUnavailableReasonV1,
  observedAt: string,
): CollectorEnvelopeV1 {
  return {
    schemaVersion: 1,
    collector: COLLECTOR,
    generatedAt: observedAt,
    facts: [{ kind: "provider-unavailable", scope, source: "cli", observedAt, reason }],
    diagnostics: [{ code: diagnosticCode(reason), provider: "grok", factIndex: 0 }],
  };
}

function validatedOrUnavailable(envelope: CollectorEnvelopeV1, observedAt: string): CollectorEnvelopeV1 {
  return validateCollectorEnvelopeV1(envelope).ok ? envelope : unavailableEnvelope(providerScope(), "invalid-payload", observedAt);
}

function diagnosticCode(reason: ProviderUnavailableReasonV1): CollectorDiagnosticCodeV1 {
  if (reason === "timeout") return "SOURCE_TIMEOUT";
  if (reason === "cancelled") return "SOURCE_CANCELLED";
  if (reason === "invalid-payload") return "INVALID_PAYLOAD";
  return "SOURCE_UNAVAILABLE";
}

function boundedTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS);
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
