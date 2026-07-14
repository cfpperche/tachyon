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

const CLAUDE_COMMAND = "claude";
const CLAUDE_AUTH_ARGS = ["auth", "status", "--json"] as const;
const COLLECTOR = { id: "tachyon-claude-cli", version: "1.0.0" } as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_AUTH_STDOUT_BYTES = 32 * 1024;
const MAX_AUTH_STDERR_BYTES = 16 * 1024;
const SHUTDOWN_GRACE_MS = 250;
const SHUTDOWN_ABANDON_MS = 1_000;
const MAX_RESET_EPOCH_SECONDS = 253_402_300_799;
const SAFE_PROVIDER_SCOPE_KEY = /^ps_[0-9a-f]{16,64}$/u;
const PASSIVE_READ_ABORTED = Symbol("passive-read-aborted");

type ClaudeFailureReason = "timeout" | "cancelled" | "provider-error" | "invalid-payload";

type PassiveReadOutcome =
  | { ok: true; capture: ClaudeStatusLineCaptureV1 | null }
  | { ok: false; reason: ClaudeFailureReason };

type CaptureProjection =
  | { state: "quota"; fact: ProviderQuotaFactV1; observedAt: string }
  | { state: "not-observed" }
  | { state: "invalid-payload" };

type AuthStatusOutcome =
  | { ok: true; loggedIn: boolean }
  | { ok: false; reason: ClaudeFailureReason };

/** Raw status-line JSON is bounded and projected immediately; callers must never persist it as an observation fact. */
export interface ClaudeStatusLineCaptureV1 {
  /** Host receipt time for this already-running Claude session's status-line event. */
  observedAt: string;
  /** Exact status-line stdin JSON, bounded again by this adapter before parsing. */
  json: string | Buffer;
}

/**
 * T3 supplies the transport-backed reader. It must return only the current passive capture selected by the host and
 * honor cancellation; this T2 adapter owns parsing, redaction and neutral-envelope projection.
 */
export type ClaudeStatusLineCaptureReader = (
  signal: AbortSignal,
) => Promise<ClaudeStatusLineCaptureV1 | null>;

export type ClaudeAuthStatusSpawn = (
  command: typeof CLAUDE_COMMAND,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

export interface ClaudeStatusLineSourceOptions {
  readCapture?: ClaudeStatusLineCaptureReader;
  /** Whole passive-read or auth-classification stage deadline. Bounded to 30 seconds. */
  timeoutMs?: number;
  /** Test seam only; product code cannot replace the fixed command or argv. */
  spawnAuthStatus?: ClaudeAuthStatusSpawn;
  now?: () => Date;
}

/**
 * Claude quota source backed by documented, token-free status-line telemetry from an already-running Claude Code
 * session. A fixed `claude auth status --json` fallback classifies absence only; it never supplies quota.
 */
export class ClaudeStatusLineObservationSource implements ProviderObservationSource {
  readonly provider = "claude" as const;
  readonly source = "cli" as const;

  private readonly readCapture: ClaudeStatusLineCaptureReader;
  private readonly timeoutMs: number;
  private readonly spawnAuthStatus: ClaudeAuthStatusSpawn;
  private readonly now: () => Date;

  constructor(options: ClaudeStatusLineSourceOptions = {}) {
    this.readCapture = options.readCapture ?? (async () => null);
    this.timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.spawnAuthStatus = options.spawnAuthStatus ?? defaultClaudeAuthStatusSpawn;
    this.now = options.now ?? (() => new Date());
  }

  async observe(request: ProviderObservationRequestV1): Promise<CollectorEnvelopeV1> {
    const observedAt = this.now().toISOString();
    const scope = safeClaudeScope(request.scope);
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

      const passive = await readPassiveCapture(this.readCapture, this.timeoutMs, request.signal);
      if (!passive.ok) return unavailableEnvelope(scope, passive.reason, observedAt);
      if (request.signal?.aborted) return unavailableEnvelope(scope, "cancelled", observedAt);

      if (passive.capture) {
        const projected = projectStatusLineCapture(passive.capture, scope);
        if (projected.state === "invalid-payload") {
          return unavailableEnvelope(scope, "invalid-payload", observedAt);
        }
        if (projected.state === "quota") {
          return validatedOrUnavailable({
            schemaVersion: 1,
            collector: COLLECTOR,
            generatedAt: projected.observedAt,
            facts: [projected.fact],
            diagnostics: [],
          }, observedAt);
        }
      }

      const auth = await collectClaudeAuthStatus(this.spawnAuthStatus, this.timeoutMs, request.signal);
      if (!auth.ok) return unavailableEnvelope(scope, auth.reason, observedAt);
      return unavailableEnvelope(scope, auth.loggedIn ? "not-observed" : "unauthenticated", observedAt);
    } catch {
      return unavailableEnvelope(scope, "invalid-payload", observedAt);
    }
  }
}

const defaultClaudeAuthStatusSpawn: ClaudeAuthStatusSpawn = (command, args) => nodeSpawn(command, [...args], {
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

async function readPassiveCapture(
  reader: ClaudeStatusLineCaptureReader,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PassiveReadOutcome> {
  if (signal?.aborted) return { ok: false, reason: "cancelled" };

  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let onInternalAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onInternalAbort = () => reject(PASSIVE_READ_ABORTED);
    controller.signal.addEventListener("abort", onInternalAbort, { once: true });
  });

  try {
    const capture = await Promise.race([reader(controller.signal), aborted]);
    return { ok: true, capture };
  } catch {
    return {
      ok: false,
      reason: signal?.aborted ? "cancelled" : timedOut ? "timeout" : "provider-error",
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
    if (onInternalAbort) controller.signal.removeEventListener("abort", onInternalAbort);
  }
}

async function collectClaudeAuthStatus(
  spawn: ClaudeAuthStatusSpawn,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AuthStatusOutcome> {
  if (signal?.aborted) return { ok: false, reason: "cancelled" };

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(CLAUDE_COMMAND, CLAUDE_AUTH_ARGS);
  } catch {
    return { ok: false, reason: "provider-error" };
  }

  return new Promise<AuthStatusOutcome>((resolve) => {
    let stdoutBuffer = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finalOutcome: AuthStatusOutcome | undefined;
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
      // Error listeners remain after bounded abandon so a pathological late error cannot crash the extension host.
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

    function finish(outcome: AuthStatusOutcome): void {
      if (finalOutcome) return;
      finalOutcome = outcome;
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
      requestShutdown();
    }

    function onStdoutData(chunk: Buffer | string): void {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += data.length;
      if (stdoutBytes > MAX_AUTH_STDOUT_BYTES) {
        finish({ ok: false, reason: "invalid-payload" });
        return;
      }
      stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
    }

    function onStderrData(chunk: Buffer | string): void {
      stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (stderrBytes > MAX_AUTH_STDERR_BYTES) finish({ ok: false, reason: "invalid-payload" });
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
      if (!finalOutcome) finalOutcome = classifyAuthStatus(stdoutBuffer, code);
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

function classifyAuthStatus(stdout: Buffer, exitCode: number | null): AuthStatusOutcome {
  try {
    const raw = JSON.parse(stdout.toString("utf8")) as unknown;
    if (record(raw) && typeof raw.loggedIn === "boolean") {
      return { ok: true, loggedIn: raw.loggedIn };
    }
    return { ok: false, reason: exitCode === 0 ? "invalid-payload" : "provider-error" };
  } catch {
    return { ok: false, reason: exitCode === 0 ? "invalid-payload" : "provider-error" };
  }
}

function projectStatusLineCapture(
  capture: ClaudeStatusLineCaptureV1,
  scope: ProviderAccountObservationScopeV1,
): CaptureProjection {
  try {
    let text: unknown = capture.json;
    if (Buffer.isBuffer(text)) {
      if (text.length > MAX_CAPTURE_BYTES) return { state: "invalid-payload" };
      text = text.toString("utf8");
    }
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_CAPTURE_BYTES) {
      return { state: "invalid-payload" };
    }
    const raw = JSON.parse(text) as unknown;
    if (!record(raw)) return { state: "invalid-payload" };
    const rateLimits = raw.rate_limits;
    if (rateLimits === undefined || rateLimits === null) return { state: "not-observed" };
    if (!record(rateLimits)) return { state: "invalid-payload" };

    const windows = ([
      ["five_hour", "session", 5 * 60],
      ["seven_day", "weekly", 7 * 24 * 60],
    ] as const).flatMap(([field, name, windowMinutes]) => {
      const window = projectWindow(rateLimits[field], name, windowMinutes);
      return window ? [window] : [];
    });
    if (windows.length === 0) return { state: "not-observed" };

    return {
      state: "quota",
      observedAt: capture.observedAt,
      fact: {
        kind: "provider-quota",
        scope,
        source: "cli",
        confidence: "exact",
        observedAt: capture.observedAt,
        freshness: { state: "fresh" },
        windows,
      },
    };
  } catch {
    return { state: "invalid-payload" };
  }
}

function projectWindow(
  raw: unknown,
  name: ProviderQuotaWindowV1["name"],
  windowMinutes: number,
): ProviderQuotaWindowV1 | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!record(raw)) throw new Error("invalid window");
  const usedPercent = raw.used_percentage;
  const resetsAt = raw.resets_at;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)
    || usedPercent < 0 || usedPercent > 100) {
    throw new Error("invalid used percent");
  }
  const window: ProviderQuotaWindowV1 = { name, usedPercent, windowMinutes };
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
    diagnostics: [{ code: diagnosticCode, provider: "claude", factIndex: 0 }],
  };
  const validated = validateCollectorEnvelopeV1(candidate);
  if (validated.ok) return validated.value;
  throw new Error("invalid adapter-owned unavailable envelope");
}

function validatedOrUnavailable(candidate: CollectorEnvelopeV1, observedAt: string): CollectorEnvelopeV1 {
  const validated = validateCollectorEnvelopeV1(candidate);
  return validated.ok ? validated.value : unavailableEnvelope(providerScope(), "invalid-payload", observedAt);
}

function safeClaudeScope(raw: ProviderAccountObservationScopeV1): ProviderAccountObservationScopeV1 | undefined {
  try {
    if (raw.kind !== "provider-account" || raw.provider !== "claude"
      || typeof raw.key !== "string" || !SAFE_PROVIDER_SCOPE_KEY.test(raw.key)) {
      return undefined;
    }
    return { kind: "provider-account", provider: "claude", key: raw.key };
  } catch {
    return undefined;
  }
}

function providerScope(): ProviderObservationScopeV1 {
  return { kind: "provider", provider: "claude" };
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new TypeError(`Claude status-line timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}ms`);
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
