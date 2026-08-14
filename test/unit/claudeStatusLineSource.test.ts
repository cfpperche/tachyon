import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeStatusLineObservationSource,
  type ClaudeAuthStatusSpawn,
  type ClaudeStatusLineCaptureReader,
  type ClaudeStatusLineCaptureV1,
} from "@tachyon/engine/runtimeObservability/claudeStatusLineSource.js";
import {
  PROVIDER_QUOTA_READ_CAPABILITY,
  type ProviderObservationGrantV1,
} from "@tachyon/engine/runtimeObservability/source.js";
import type { CollectorEnvelopeV1 } from "@tachyon/engine/runtimeObservability/types.js";
import { validateCollectorEnvelopeV1 } from "@tachyon/engine/runtimeObservability/validate.js";

interface FixtureCase {
  observedAt: string;
  payload: Record<string, unknown>;
}

interface FixtureCorpus {
  provenance: {
    cliVersion: string;
    statusLineDocumentation: string;
    cliDocumentation: string;
    legalDocumentation: string;
    sourceFields: string[];
    codexBarReference: { tag: string; commit: string };
    derivedCode: boolean;
  };
  auth: {
    loggedIn: Record<string, unknown>;
    loggedOut: Record<string, unknown>;
    malformed: Record<string, unknown>;
  };
  transport: {
    providerError: { exitCode: number; stdout: string; stderr: string };
    timeout: { responses: unknown[] };
  };
  cases: {
    success: FixtureCase;
    partialSevenDayOnly: FixtureCase;
    missingRateLimits: FixtureCase;
    emptyRateLimits: FixtureCase;
    malformedPercent: FixtureCase;
    malformedReset: FixtureCase;
    malformedRateLimits: FixtureCase;
  };
}

const fixture = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), "test/fixtures/claude-status-line-v2.1.209.json"),
  "utf8",
)) as FixtureCorpus;

const NOW = "2026-07-14T20:40:00.000Z";
const SCOPE = { kind: "provider-account", provider: "claude", key: "ps_0000000000000002" } as const;
const GRANT: ProviderObservationGrantV1 = {
  state: "granted",
  capability: PROVIDER_QUOTA_READ_CAPABILITY,
  source: "cli",
  consent: "explicit-user",
};

type AuthHandler = (process: FakeAuthStatusProcess) => void;

class FakeAuthStatusProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  private closed = false;

  constructor(
    handler: AuthHandler,
    private readonly closeOnSignal: NodeJS.Signals | null = "SIGTERM",
  ) {
    super();
    this.stdin.once("finish", () => handler(this));
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  reply(payload: unknown, exitCode = 0): void {
    this.stdout.write(JSON.stringify(payload));
    this.close(exitCode);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === this.closeOnSignal) queueMicrotask(() => this.close(null, signal));
    return true;
  }

  close(exitCode: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", exitCode, signal);
  }
}

function capture(value: FixtureCase): ClaudeStatusLineCaptureV1 {
  return { observedAt: value.observedAt, json: JSON.stringify(value.payload) };
}

function harness(options: {
  capture?: ClaudeStatusLineCaptureV1 | null;
  readCapture?: ClaudeStatusLineCaptureReader;
  authHandler?: AuthHandler;
  timeoutMs?: number;
  signal?: AbortSignal;
  closeOnSignal?: NodeJS.Signals | null;
} = {}): {
  process: FakeAuthStatusProcess;
  readCapture: ReturnType<typeof vi.fn<ClaudeStatusLineCaptureReader>>;
  spawnAuthStatus: ReturnType<typeof vi.fn<ClaudeAuthStatusSpawn>>;
  observe: () => Promise<CollectorEnvelopeV1>;
} {
  const process = new FakeAuthStatusProcess(
    options.authHandler ?? ((child) => child.reply(fixture.auth.loggedIn)),
    options.closeOnSignal === undefined ? "SIGTERM" : options.closeOnSignal,
  );
  const readCapture = vi.fn<ClaudeStatusLineCaptureReader>(
    options.readCapture ?? (async () => options.capture ?? null),
  );
  const spawnAuthStatus = vi.fn<ClaudeAuthStatusSpawn>(() => process.asChild());
  const source = new ClaudeStatusLineObservationSource({
    readCapture,
    timeoutMs: options.timeoutMs,
    spawnAuthStatus,
    now: () => new Date(NOW),
  });
  return {
    process,
    readCapture,
    spawnAuthStatus,
    observe: () => source.observe({ scope: SCOPE, grant: GRANT, signal: options.signal }),
  };
}

function unavailable(envelope: CollectorEnvelopeV1): Extract<CollectorEnvelopeV1["facts"][number], { kind: "provider-unavailable" }> {
  const fact = envelope.facts[0];
  expect(fact.kind).toBe("provider-unavailable");
  if (fact.kind !== "provider-unavailable") throw new Error("expected unavailable fact");
  return fact;
}

describe("ClaudeStatusLineObservationSource", () => {
  it("projects only documented passive quota fields and never launches an auth probe on success", async () => {
    const h = harness({ capture: capture(fixture.cases.success) });
    const envelope = await h.observe();

    expect(fixture.provenance).toEqual({
      cliVersion: "2.1.209",
      statusLineDocumentation: "https://code.claude.com/docs/en/statusline",
      cliDocumentation: "https://code.claude.com/docs/en/cli-usage",
      legalDocumentation: "https://code.claude.com/docs/en/legal-and-compliance",
      sourceFields: [
        "rate_limits.five_hour.used_percentage",
        "rate_limits.five_hour.resets_at",
        "rate_limits.seven_day.used_percentage",
        "rate_limits.seven_day.resets_at",
      ],
      codexBarReference: {
        tag: "v0.43.0",
        commit: "5a0cbc07119ac04d998e2fd5267442ed9358fff0",
      },
      derivedCode: false,
    });
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      collector: { id: "tachyon-claude-cli", version: "1.0.0" },
      generatedAt: fixture.cases.success.observedAt,
      facts: [{
        kind: "provider-quota",
        scope: SCOPE,
        source: "cli",
        confidence: "exact",
        observedAt: fixture.cases.success.observedAt,
        freshness: { state: "fresh" },
        windows: [
          { name: "session", usedPercent: 31, windowMinutes: 300, resetsAt: "2026-07-15T01:00:00.000Z" },
          { name: "weekly", usedPercent: 68, windowMinutes: 10080, resetsAt: "2026-07-22T01:00:00.000Z" },
        ],
      }],
      diagnostics: [],
    });
    expect(validateCollectorEnvelopeV1(envelope)).toMatchObject({ ok: true });
    expect(h.spawnAuthStatus).not.toHaveBeenCalled();
    const serialized = JSON.stringify(envelope);
    for (const forbidden of [
      "MUST_NOT_CROSS",
      "/home/private",
      "session_id",
      "transcript_path",
      "context_window",
      "authorization",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("does not read passive telemetry or spawn when consent is disabled or source-mismatched", async () => {
    const readCapture = vi.fn<ClaudeStatusLineCaptureReader>();
    const spawnAuthStatus = vi.fn<ClaudeAuthStatusSpawn>();
    const source = new ClaudeStatusLineObservationSource({ readCapture, spawnAuthStatus, now: () => new Date(NOW) });

    const disabled = await source.observe({ scope: SCOPE, grant: { state: "disabled" } });
    expect(unavailable(disabled).reason).toBe("source-disabled");
    const mismatched = await source.observe({
      scope: SCOPE,
      grant: {
        state: "granted",
        capability: PROVIDER_QUOTA_READ_CAPABILITY,
        source: "oauth",
        consent: "explicit-user",
      },
    });
    expect(unavailable(mismatched).reason).toBe("unsupported");
    expect(readCapture).not.toHaveBeenCalled();
    expect(spawnAuthStatus).not.toHaveBeenCalled();
  });

  it("rejects forged consent states without touching either source", async () => {
    const readCapture = vi.fn<ClaudeStatusLineCaptureReader>();
    const spawnAuthStatus = vi.fn<ClaudeAuthStatusSpawn>();
    const source = new ClaudeStatusLineObservationSource({ readCapture, spawnAuthStatus, now: () => new Date(NOW) });
    const forged = {
      state: "inferred",
      capability: PROVIDER_QUOTA_READ_CAPABILITY,
      source: "cli",
      consent: "explicit-user",
    } as unknown as ProviderObservationGrantV1;
    const envelope = await source.observe({ scope: SCOPE, grant: forged });
    expect(unavailable(envelope).reason).toBe("unsupported");
    expect(readCapture).not.toHaveBeenCalled();
    expect(spawnAuthStatus).not.toHaveBeenCalled();
  });

  it("preserves a valid partial seven-day window without fabricating five-hour usage", async () => {
    const h = harness({ capture: capture(fixture.cases.partialSevenDayOnly) });
    expect((await h.observe()).facts[0]).toMatchObject({
      kind: "provider-quota",
      windows: [{ name: "weekly", usedPercent: 54, windowMinutes: 10080 }],
    });
    expect(h.spawnAuthStatus).not.toHaveBeenCalled();
  });

  it("falls back to the fixed auth-status command and reports authenticated absence honestly", async () => {
    const h = harness({ capture: null });
    const envelope = await h.observe();
    expect(h.spawnAuthStatus).toHaveBeenCalledWith("claude", ["auth", "status", "--json"]);
    expect(unavailable(envelope)).toMatchObject({ reason: "not-observed", source: "cli", scope: SCOPE });
    expect(JSON.stringify(envelope)).not.toMatch(/fixture@example|MUST_NOT_CROSS|orgId|orgName/u);
    expect(h.process.signals).toEqual([]);
  });

  it("classifies an absent passive sample as unauthenticated when auth status exits one with loggedIn false", async () => {
    const h = harness({
      capture: capture(fixture.cases.missingRateLimits),
      authHandler: (child) => child.reply(fixture.auth.loggedOut, 1),
    });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("unauthenticated");
    expect(JSON.stringify(envelope)).not.toContain("MUST_NOT_CROSS_LOGGED_OUT_IDENTITY");
  });

  it("treats an authenticated status line with no populated windows as not yet observed", async () => {
    const h = harness({ capture: capture(fixture.cases.emptyRateLimits) });
    expect(unavailable(await h.observe()).reason).toBe("not-observed");
    expect(h.spawnAuthStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["malformedPercent", fixture.cases.malformedPercent],
    ["malformedReset", fixture.cases.malformedReset],
    ["malformedRateLimits", fixture.cases.malformedRateLimits],
  ])("fails closed on %s status-line drift without probing another source", async (_name, value) => {
    const h = harness({ capture: capture(value) });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("invalid-payload");
    expect(envelope.diagnostics).toEqual([{ code: "INVALID_PAYLOAD", provider: "claude", factIndex: 0 }]);
    expect(h.spawnAuthStatus).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized passive capture before retaining provider text", async () => {
    const malformed = harness({ capture: { observedAt: NOW, json: "{MUST_NOT_CROSS_JSON}" } });
    expect(unavailable(await malformed.observe()).reason).toBe("invalid-payload");

    for (const json of [
      `{"MUST_NOT_CROSS_OVERSIZED":"${"x".repeat(64 * 1024)}"}`,
      Buffer.alloc(64 * 1024 + 1, 0x78),
    ]) {
      const oversized = harness({ capture: { observedAt: NOW, json } });
      const envelope = await oversized.observe();
      expect(unavailable(envelope).reason).toBe("invalid-payload");
      expect(JSON.stringify(envelope)).not.toContain("MUST_NOT_CROSS_OVERSIZED");
      expect(oversized.spawnAuthStatus).not.toHaveBeenCalled();
    }
  });

  it("bounds a passive reader that ignores cancellation and aborts its supplied signal", async () => {
    let supplied: AbortSignal | undefined;
    const h = harness({
      timeoutMs: 5,
      readCapture: async (signal) => {
        supplied = signal;
        return new Promise<ClaudeStatusLineCaptureV1 | null>(() => undefined);
      },
    });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("timeout");
    expect(envelope.diagnostics[0]).toMatchObject({ code: "SOURCE_TIMEOUT" });
    expect(supplied?.aborted).toBe(true);
    expect(h.spawnAuthStatus).not.toHaveBeenCalled();
  });

  it("maps passive reader failures without copying thrown text", async () => {
    const h = harness({
      readCapture: async () => { throw new Error("MUST_NOT_CROSS_READER /home/private/capture"); },
    });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("provider-error");
    expect(JSON.stringify(envelope)).not.toContain("MUST_NOT_CROSS_READER");
  });

  it("cancels an in-flight passive read without launching auth status", async () => {
    const controller = new AbortController();
    const h = harness({
      signal: controller.signal,
      readCapture: async () => {
        controller.abort();
        return new Promise<ClaudeStatusLineCaptureV1 | null>(() => undefined);
      },
    });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("cancelled");
    expect(envelope.diagnostics[0]).toMatchObject({ code: "SOURCE_CANCELLED" });
    expect(h.spawnAuthStatus).not.toHaveBeenCalled();
  });

  it("does not touch either source when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });
    expect(unavailable(await h.observe()).reason).toBe("cancelled");
    expect(h.readCapture).not.toHaveBeenCalled();
    expect(h.spawnAuthStatus).not.toHaveBeenCalled();
  });

  it("maps auth-status provider failures without copying stdout or stderr", async () => {
    const h = harness({
      authHandler: (child) => {
        child.stdout.write(fixture.transport.providerError.stdout);
        child.stderr.write(fixture.transport.providerError.stderr);
        child.close(fixture.transport.providerError.exitCode);
      },
    });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("provider-error");
    expect(JSON.stringify(envelope)).not.toMatch(/MUST_NOT_CROSS|credentials|home\/private/u);
  });

  it("fails closed on a successful auth command with a malformed payload", async () => {
    const h = harness({ authHandler: (child) => child.reply(fixture.auth.malformed) });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("invalid-payload");
    expect(JSON.stringify(envelope)).not.toContain("MUST_NOT_CROSS_MALFORMED_AUTH");
  });

  it("times out auth classification and terminates the child", async () => {
    const h = harness({
      timeoutMs: 5,
      authHandler: (_child) => {
        for (const _response of fixture.transport.timeout.responses) { /* Synthetic no-response fixture. */ }
      },
    });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("timeout");
    expect(h.process.signals).toEqual(["SIGTERM"]);
  });

  it("escalates an auth-status child that ignores SIGTERM", async () => {
    const h = harness({ timeoutMs: 5, authHandler: () => undefined, closeOnSignal: "SIGKILL" });
    expect(unavailable(await h.observe()).reason).toBe("timeout");
    expect(h.process.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("cancels in-flight auth classification and terminates the child", async () => {
    const controller = new AbortController();
    const h = harness({
      signal: controller.signal,
      authHandler: () => controller.abort(),
    });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("cancelled");
    expect(h.process.signals).toEqual(["SIGTERM"]);
  });

  it("bounds auth stdout and stderr without copying identity or provider text", async () => {
    const stdout = harness({ authHandler: (child) => child.stdout.write("x".repeat(32 * 1024 + 1)) });
    expect(unavailable(await stdout.observe()).reason).toBe("invalid-payload");
    expect(stdout.process.signals).toEqual(["SIGTERM"]);

    const stderr = harness({ authHandler: (child) => child.stderr.write("MUST_NOT_CROSS_STDERR".repeat(1024)) });
    const envelope = await stderr.observe();
    expect(unavailable(envelope).reason).toBe("invalid-payload");
    expect(JSON.stringify(envelope)).not.toContain("MUST_NOT_CROSS_STDERR");
  });

  it("maps synchronous auth spawn failures without exposing the error", async () => {
    const source = new ClaudeStatusLineObservationSource({
      readCapture: async () => null,
      spawnAuthStatus: () => { throw new Error("MUST_NOT_CROSS_SPAWN /private/claude"); },
      now: () => new Date(NOW),
    });
    const envelope = await source.observe({ scope: SCOPE, grant: GRANT });
    expect(unavailable(envelope).reason).toBe("provider-error");
    expect(JSON.stringify(envelope)).not.toContain("MUST_NOT_CROSS_SPAWN");
  });

  it("fails an invalid account scope closed without touching either source", async () => {
    const h = harness();
    const source = new ClaudeStatusLineObservationSource({
      readCapture: h.readCapture,
      spawnAuthStatus: h.spawnAuthStatus,
      now: () => new Date(NOW),
    });
    const envelope = await source.observe({
      scope: { ...SCOPE, key: "customer@example.invalid" },
      grant: GRANT,
    });
    expect(unavailable(envelope)).toMatchObject({
      reason: "invalid-payload",
      scope: { kind: "provider", provider: "claude" },
    });
    expect(h.readCapture).not.toHaveBeenCalled();
    expect(h.spawnAuthStatus).not.toHaveBeenCalled();
  });
});
