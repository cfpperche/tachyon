import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  CollectorDiagnosticCodeV1,
  CollectorEnvelopeV1,
  ProviderAccountObservationScopeV1,
  ProviderObservationScopeV1,
  ProviderQuotaFactV1,
  ProviderQuotaWindowV1,
  ProviderUnavailableReasonV1,
} from "./types.js";
import {
  PROVIDER_QUOTA_READ_CAPABILITY,
  type ProviderObservationRequestV1,
  type ProviderObservationSource,
} from "./source.js";
import { validateCollectorEnvelopeV1 } from "./validate.js";

const CODEX_COMMAND = "codex";
const CODEX_ARGS = ["-s", "read-only", "-a", "untrusted", "app-server", "--stdio"] as const;
const COLLECTOR = { id: "tachyon-codex-cli", version: "1.0.0" } as const;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 128 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const SHUTDOWN_GRACE_MS = 250;
const SHUTDOWN_ABANDON_MS = 1_000;
const MAX_WINDOW_MINUTES = 525_600;
const SESSION_WINDOW_MAX_MINUTES = 24 * 60;
const WEEKLY_WINDOW_MAX_MINUTES = 14 * 24 * 60;
const MAX_RESET_EPOCH_SECONDS = 253_402_300_799;
const SAFE_PROVIDER_SCOPE_KEY = /^ps_[0-9a-f]{16,64}$/u;

type CodexAppServerFailureReason =
  | "unauthenticated"
  | "unsupported"
  | "timeout"
  | "cancelled"
  | "provider-error"
  | "invalid-payload";

type CodexAppServerOutcome =
  | { ok: true; rateLimitsResult: unknown }
  | { ok: false; reason: CodexAppServerFailureReason };

export type CodexAppServerSpawn = (
  command: typeof CODEX_COMMAND,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

export interface CodexAppServerSourceOptions {
  /** Whole initialize/account/quota exchange deadline. Bounded to 30 seconds. */
  timeoutMs?: number;
  /** Test seam only; product configuration cannot replace the fixed `codex` command or argv. */
  spawn?: CodexAppServerSpawn;
  now?: () => Date;
}

/**
 * Codex quota source backed only by the documented app-server account protocol. Codex owns credentials and refresh;
 * this adapter owns a bounded child lifecycle and a fresh allowlisted `CollectorEnvelopeV1` projection.
 */
export class CodexAppServerObservationSource implements ProviderObservationSource {
  readonly provider = "codex" as const;
  readonly source = "cli" as const;
  /** t-458497 — Codex answers a machine request for its own limits; nothing here reads a rendered surface. */
  readonly channel = {
    acquisition: "control-plane",
    mechanism: "codex app-server JSON-RPC account/rateLimits/read over stdio",
  } as const;

  private readonly timeoutMs: number;
  private readonly spawn: CodexAppServerSpawn;
  private readonly now: () => Date;

  constructor(options: CodexAppServerSourceOptions = {}) {
    this.timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.spawn = options.spawn ?? defaultCodexAppServerSpawn;
    this.now = options.now ?? (() => new Date());
  }

  async observe(request: ProviderObservationRequestV1): Promise<CollectorEnvelopeV1> {
    const observedAt = this.now().toISOString();
    const scope = safeCodexScope(request.scope);
    if (!scope) return unavailableEnvelope(providerScope(), "invalid-payload", observedAt);

    try {
      const grant: unknown = request.grant;
      if (record(grant) && grant.state === "disabled") {
        return unavailableEnvelope(scope, "source-disabled", observedAt);
      }
      if (!record(grant)
        || grant.state !== "granted"
        || grant.capability !== PROVIDER_QUOTA_READ_CAPABILITY
        || grant.consent !== "explicit-user"
        || grant.source !== this.source) {
        return unavailableEnvelope(scope, "unsupported", observedAt);
      }
      if (request.signal?.aborted) return unavailableEnvelope(scope, "cancelled", observedAt);

      const outcome = await collectCodexRateLimits(this.spawn, this.timeoutMs, request.signal);
      if (!outcome.ok) return unavailableEnvelope(scope, outcome.reason, observedAt);

      const quota = projectRateLimits(outcome.rateLimitsResult, scope, observedAt);
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

const defaultCodexAppServerSpawn: CodexAppServerSpawn = (command, args) => nodeSpawn(command, [...args], {
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

async function collectCodexRateLimits(
  spawn: CodexAppServerSpawn,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CodexAppServerOutcome> {
  if (signal?.aborted) return { ok: false, reason: "cancelled" };

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(CODEX_COMMAND, CODEX_ARGS);
  } catch {
    return { ok: false, reason: "provider-error" };
  }

  return new Promise<CodexAppServerOutcome>((resolve) => {
    let expectedId = 1;
    let stage: "initialize" | "account" | "rate-limits" = "initialize";
    let stdoutBuffer = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finalOutcome: CodexAppServerOutcome | undefined;
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
      // Keep error listeners attached even after the bounded abandon path. A pathological child that survives
      // SIGKILL must not turn a later stream/process error into an unhandled host exception.
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

    function finish(outcome: CodexAppServerOutcome): void {
      if (finalOutcome) return;
      finalOutcome = outcome;
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
      requestShutdown();
    }

    function send(payload: Record<string, unknown>): boolean {
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
        return true;
      } catch {
        finish({ ok: false, reason: "provider-error" });
        return false;
      }
    }

    function handleMessage(raw: unknown): void {
      if (!record(raw)) {
        finish({ ok: false, reason: "invalid-payload" });
        return;
      }
      if (raw.id === undefined) {
        if (typeof raw.method !== "string") finish({ ok: false, reason: "invalid-payload" });
        return;
      }
      if (raw.id !== expectedId) {
        finish({ ok: false, reason: "invalid-payload" });
        return;
      }
      if (raw.error !== undefined) {
        finish({ ok: false, reason: "provider-error" });
        return;
      }
      if (!("result" in raw)) {
        finish({ ok: false, reason: "invalid-payload" });
        return;
      }

      if (stage === "initialize") {
        if (!record(raw.result)) {
          finish({ ok: false, reason: "invalid-payload" });
          return;
        }
        stage = "account";
        expectedId = 2;
        if (!send({ method: "initialized", params: {} })) return;
        send({ method: "account/read", id: expectedId, params: { refreshToken: false } });
        return;
      }

      if (stage === "account") {
        const accountState = classifyAccount(raw.result);
        if (accountState !== "chatgpt") {
          finish({ ok: false, reason: accountState });
          return;
        }
        stage = "rate-limits";
        expectedId = 3;
        send({ method: "account/rateLimits/read", id: expectedId });
        return;
      }

      finish({ ok: true, rateLimitsResult: raw.result });
    }

    function onStdoutData(chunk: Buffer | string): void {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += data.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        finish({ ok: false, reason: "invalid-payload" });
        return;
      }
      stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
      while (!finalOutcome) {
        const newline = stdoutBuffer.indexOf(0x0a);
        if (newline < 0) break;
        let line = stdoutBuffer.subarray(0, newline);
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
        if (line.length === 0) continue;
        if (line.length > MAX_LINE_BYTES) {
          finish({ ok: false, reason: "invalid-payload" });
          return;
        }
        try {
          handleMessage(JSON.parse(line.toString("utf8")) as unknown);
        } catch {
          finish({ ok: false, reason: "invalid-payload" });
        }
      }
      if (!finalOutcome && stdoutBuffer.length > MAX_LINE_BYTES) {
        finish({ ok: false, reason: "invalid-payload" });
      }
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

    function onClose(): void {
      closed = true;
      if (!finalOutcome) {
        finalOutcome = stdoutBuffer.length > 0
          ? { ok: false, reason: "invalid-payload" }
          : { ok: false, reason: "provider-error" };
      }
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

    send({
      method: "initialize",
      id: expectedId,
      params: {
        clientInfo: {
          name: "tachyon_runtimeops",
          title: "Tachyon RuntimeOps",
          version: COLLECTOR.version,
        },
      },
    });
  });
}

function classifyAccount(raw: unknown): "chatgpt" | "unauthenticated" | "unsupported" | "invalid-payload" {
  if (!record(raw) || typeof raw.requiresOpenaiAuth !== "boolean") return "invalid-payload";
  const account = raw.account;
  if (account === null) return raw.requiresOpenaiAuth ? "unauthenticated" : "unsupported";
  if (!record(account) || typeof account.type !== "string") return "invalid-payload";
  return account.type === "chatgpt" ? "chatgpt" : "unsupported";
}

function projectRateLimits(
  raw: unknown,
  scope: ProviderAccountObservationScopeV1,
  observedAt: string,
): ProviderQuotaFactV1 | undefined {
  try {
    const result = record(raw) ? raw : undefined;
    const snapshot = result && record(result.rateLimits) ? result.rateLimits : undefined;
    if (!snapshot) return undefined;
    const windows = ([
      ["primary", "session"],
      ["secondary", "weekly"],
    ] as const).flatMap(([field, name]) => {
      const window = projectWindow(snapshot[field], name);
      return window ? [window] : [];
    });
    if (windows.length === 0) return undefined;
    if (new Set(windows.map((window) => window.name)).size !== windows.length) return undefined;
    const order: Record<ProviderQuotaWindowV1["name"], number> = { session: 0, weekly: 1, tertiary: 2 };
    windows.sort((left, right) => order[left.name] - order[right.name]);
    return {
      kind: "provider-quota",
      scope,
      source: "cli",
      confidence: "exact",
      observedAt,
      freshness: { state: "fresh" },
      windows,
    };
  } catch {
    return undefined;
  }
}

function projectWindow(
  raw: unknown,
  fallbackName: ProviderQuotaWindowV1["name"],
): ProviderQuotaWindowV1 | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!record(raw)) throw new Error("invalid window");
  const usedPercent = raw.usedPercent;
  const windowDurationMins = raw.windowDurationMins;
  const resetsAt = raw.resetsAt;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)
    || usedPercent < 0 || usedPercent > 100) {
    throw new Error("invalid used percent");
  }
  const window: ProviderQuotaWindowV1 = {
    name: classifyWindowName(windowDurationMins, fallbackName),
    usedPercent,
  };
  if (windowDurationMins !== undefined && windowDurationMins !== null) {
    if (typeof windowDurationMins !== "number"
      || !Number.isSafeInteger(windowDurationMins)
      || windowDurationMins <= 0
      || windowDurationMins > MAX_WINDOW_MINUTES) {
      throw new Error("invalid window duration");
    }
    window.windowMinutes = windowDurationMins;
  }
  if (resetsAt !== undefined && resetsAt !== null) {
    if (typeof resetsAt !== "number"
      || !Number.isSafeInteger(resetsAt)
      || resetsAt < 0
      || resetsAt > MAX_RESET_EPOCH_SECONDS) {
      throw new Error("invalid reset timestamp");
    }
    window.resetsAt = new Date(resetsAt * 1_000).toISOString();
  }
  return window;
}

/**
 * App-server's primary/secondary fields are positional, not semantic: a sole weekly or monthly limit can occupy
 * `primary`. Prefer the documented duration, falling back to the historical slot only when duration is absent.
 */
function classifyWindowName(
  windowDurationMins: unknown,
  fallbackName: ProviderQuotaWindowV1["name"],
): ProviderQuotaWindowV1["name"] {
  if (typeof windowDurationMins !== "number" || !Number.isSafeInteger(windowDurationMins)) return fallbackName;
  if (windowDurationMins <= SESSION_WINDOW_MAX_MINUTES) return "session";
  if (windowDurationMins <= WEEKLY_WINDOW_MAX_MINUTES) return "weekly";
  return "tertiary";
}

function unavailableEnvelope(
  scope: ProviderObservationScopeV1 | ProviderAccountObservationScopeV1,
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
  const candidate: CollectorEnvelopeV1 = {
    schemaVersion: 1,
    collector: COLLECTOR,
    generatedAt: observedAt,
    facts: [{
      kind: "provider-unavailable",
      scope,
      source: "cli",
      observedAt,
      reason,
    }],
    diagnostics: [{ code: diagnosticCode, provider: "codex", factIndex: 0 }],
  };
  const validated = validateCollectorEnvelopeV1(candidate);
  if (validated.ok) return validated.value;
  throw new Error("invalid adapter-owned unavailable envelope");
}

function validatedOrUnavailable(candidate: CollectorEnvelopeV1, observedAt: string): CollectorEnvelopeV1 {
  const validated = validateCollectorEnvelopeV1(candidate);
  return validated.ok ? validated.value : unavailableEnvelope(providerScope(), "invalid-payload", observedAt);
}

function safeCodexScope(raw: ProviderAccountObservationScopeV1): ProviderAccountObservationScopeV1 | undefined {
  try {
    if (raw.kind !== "provider-account" || raw.provider !== "codex"
      || typeof raw.key !== "string" || !SAFE_PROVIDER_SCOPE_KEY.test(raw.key)) {
      return undefined;
    }
    return { kind: "provider-account", provider: "codex", key: raw.key };
  } catch {
    return undefined;
  }
}

function providerScope(): ProviderObservationScopeV1 {
  return { kind: "provider", provider: "codex" };
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new TypeError(`Codex app-server timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}ms`);
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
