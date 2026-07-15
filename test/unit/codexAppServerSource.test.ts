import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerObservationSource,
  type CodexAppServerSpawn,
} from "../../src/runtimeObservability/codexAppServerSource.js";
import {
  PROVIDER_QUOTA_READ_CAPABILITY,
  type ProviderObservationGrantV1,
} from "../../src/runtimeObservability/source.js";
import type { CollectorEnvelopeV1 } from "../../src/runtimeObservability/types.js";
import { validateCollectorEnvelopeV1 } from "../../src/runtimeObservability/validate.js";

interface FixtureCorpus {
  provenance: {
    repository: string;
    tag: string;
    commit: string;
    protocolMethod: string;
    codexBarReference: { tag: string; commit: string };
    derivedCode: boolean;
  };
  account: {
    chatgpt: Record<string, unknown>;
    unauthenticated: Record<string, unknown>;
    apiKey: Record<string, unknown>;
  };
  transport: {
    providerError: { code: number; message: string };
    timeout: { responses: unknown[] };
  };
  cases: {
    success: Record<string, unknown>;
    partialSecondaryOnly: Record<string, unknown>;
    primaryWeeklyOnly: Record<string, unknown>;
    primaryMonthlyOnly: Record<string, unknown>;
    duplicateShortWindows: Record<string, unknown>;
    malformedPercent: Record<string, unknown>;
    missingSnapshot: Record<string, unknown>;
    noWindows: Record<string, unknown>;
  };
}

const fixture = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), "test/fixtures/codex-app-server-rate-limits-v0.144.4.json"),
  "utf8",
)) as FixtureCorpus;

const NOW = "2026-07-14T19:00:00.000Z";
const SCOPE = { kind: "provider-account", provider: "codex", key: "ps_0000000000000001" } as const;
const GRANT: ProviderObservationGrantV1 = {
  state: "granted",
  capability: PROVIDER_QUOTA_READ_CAPABILITY,
  source: "cli",
  consent: "explicit-user",
};

type RequestHandler = (request: Record<string, unknown>, process: FakeAppServerProcess) => void;

class FakeAppServerProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  readonly signals: NodeJS.Signals[] = [];
  private input = "";
  private closed = false;

  constructor(
    private readonly handler: RequestHandler,
    private readonly closeOnSignal: NodeJS.Signals | null = "SIGTERM",
  ) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.input += chunk;
      while (this.input.includes("\n")) {
        const newline = this.input.indexOf("\n");
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        this.requests.push(request);
        this.handler(request, this);
      }
    });
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  reply(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  fail(id: number, error: { code: number; message: string }): void {
    this.stdout.write(`${JSON.stringify({ id, error })}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === this.closeOnSignal) queueMicrotask(() => this.close(signal));
    return true;
  }

  get didClose(): boolean {
    return this.closed;
  }

  close(signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", signal ? null : 0, signal);
  }
}

function standardHandler(
  account: Record<string, unknown>,
  rateLimits: unknown,
): RequestHandler {
  return (request, process) => {
    switch (request.method) {
      case "initialize":
        process.reply(request.id as number, { userAgent: "synthetic" });
        break;
      case "account/read":
        process.reply(request.id as number, account);
        break;
      case "account/rateLimits/read":
        process.reply(request.id as number, rateLimits);
        break;
      default:
        break;
    }
  };
}

function harness(
  handler: RequestHandler,
  options: { timeoutMs?: number; signal?: AbortSignal; closeOnSignal?: NodeJS.Signals | null } = {},
): {
  process: FakeAppServerProcess;
  spawn: ReturnType<typeof vi.fn<CodexAppServerSpawn>>;
  observe: () => Promise<CollectorEnvelopeV1>;
} {
  const process = new FakeAppServerProcess(handler, options.closeOnSignal ?? "SIGTERM");
  const spawn = vi.fn<CodexAppServerSpawn>(() => process.asChild());
  const source = new CodexAppServerObservationSource({
    timeoutMs: options.timeoutMs,
    spawn,
    now: () => new Date(NOW),
  });
  return {
    process,
    spawn,
    observe: () => source.observe({ scope: SCOPE, grant: GRANT, signal: options.signal }),
  };
}

function unavailable(envelope: CollectorEnvelopeV1): Extract<CollectorEnvelopeV1["facts"][number], { kind: "provider-unavailable" }> {
  const fact = envelope.facts[0];
  expect(fact.kind).toBe("provider-unavailable");
  if (fact.kind !== "provider-unavailable") throw new Error("expected unavailable fact");
  return fact;
}

describe("CodexAppServerObservationSource", () => {
  it("uses the pinned documented CLI protocol and projects only neutral quota fields", async () => {
    const h = harness(standardHandler(fixture.account.chatgpt, fixture.cases.success));
    const envelope = await h.observe();

    expect(fixture.provenance).toEqual({
      repository: "https://github.com/openai/codex",
      tag: "rust-v0.144.4",
      commit: "8c68d4c87dc54d38861f5114e920c3de2efa5876",
      protocolMethod: "account/rateLimits/read",
      codexBarReference: {
        tag: "v0.43.0",
        commit: "5a0cbc07119ac04d998e2fd5267442ed9358fff0",
      },
      derivedCode: false,
    });
    expect(h.spawn).toHaveBeenCalledWith("codex", [
      "-s", "read-only", "-a", "untrusted", "app-server", "--stdio",
    ]);
    expect(h.process.requests).toEqual([
      {
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "tachyon_runtimeops",
            title: "Tachyon RuntimeOps",
            version: "1.0.0",
          },
        },
      },
      { method: "initialized", params: {} },
      { method: "account/read", id: 2, params: { refreshToken: false } },
      { method: "account/rateLimits/read", id: 3 },
    ]);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      collector: { id: "tachyon-codex-cli", version: "1.0.0" },
      generatedAt: NOW,
      facts: [{
        kind: "provider-quota",
        scope: SCOPE,
        source: "cli",
        confidence: "exact",
        observedAt: NOW,
        freshness: { state: "fresh" },
        windows: [
          { name: "session", usedPercent: 28, windowMinutes: 300, resetsAt: "2026-07-15T01:00:00.000Z" },
          { name: "weekly", usedPercent: 64, windowMinutes: 10080, resetsAt: "2026-07-22T01:00:00.000Z" },
        ],
      }],
      diagnostics: [],
    });
    expect(validateCollectorEnvelopeV1(envelope)).toMatchObject({ ok: true });
    const serialized = JSON.stringify(envelope);
    for (const forbidden of [
      "MUST_NOT_CROSS",
      "fixture@example.invalid",
      "planType",
      "credits",
      "rateLimitsByLimitId",
      "rateLimitResetCredits",
      "authorization",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(h.process.signals).toEqual(["SIGTERM"]);
  });

  it("does not spawn when consent is disabled or bound to another source", async () => {
    const spawn = vi.fn<CodexAppServerSpawn>();
    const source = new CodexAppServerObservationSource({ spawn, now: () => new Date(NOW) });

    const disabled = await source.observe({ scope: SCOPE, grant: { state: "disabled" } });
    expect(unavailable(disabled)).toMatchObject({ reason: "source-disabled", source: "cli", scope: SCOPE });

    const mismatched = await source.observe({
      scope: SCOPE,
      grant: {
        state: "granted",
        capability: PROVIDER_QUOTA_READ_CAPABILITY,
        source: "oauth",
        consent: "explicit-user",
      },
    });
    expect(unavailable(mismatched)).toMatchObject({ reason: "unsupported", source: "cli", scope: SCOPE });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a forged unknown grant state instead of treating matching fields as consent", async () => {
    const spawn = vi.fn<CodexAppServerSpawn>();
    const source = new CodexAppServerObservationSource({ spawn, now: () => new Date(NOW) });
    const forged = {
      state: "inferred",
      capability: PROVIDER_QUOTA_READ_CAPABILITY,
      source: "cli",
      consent: "explicit-user",
    } as unknown as ProviderObservationGrantV1;
    const envelope = await source.observe({ scope: SCOPE, grant: forged });
    expect(unavailable(envelope).reason).toBe("unsupported");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves a valid partial secondary window without fabricating a primary window", async () => {
    const h = harness(standardHandler(fixture.account.chatgpt, fixture.cases.partialSecondaryOnly));
    const envelope = await h.observe();
    expect(envelope.facts[0]).toMatchObject({
      kind: "provider-quota",
      windows: [{ name: "weekly", usedPercent: 63, windowMinutes: 10080 }],
    });
  });

  it("classifies a sole primary slot by duration instead of falsely calling a weekly window session", async () => {
    const weekly = harness(standardHandler(fixture.account.chatgpt, fixture.cases.primaryWeeklyOnly));
    expect((await weekly.observe()).facts[0]).toMatchObject({
      kind: "provider-quota",
      windows: [{ name: "weekly", usedPercent: 73, windowMinutes: 10080 }],
    });

    const monthly = harness(standardHandler(fixture.account.chatgpt, fixture.cases.primaryMonthlyOnly));
    expect((await monthly.observe()).facts[0]).toMatchObject({
      kind: "provider-quota",
      windows: [{ name: "tertiary", usedPercent: 12, windowMinutes: 43200 }],
    });
  });

  it("fails closed when two provider windows collapse into the same bounded semantic lane", async () => {
    const h = harness(standardHandler(fixture.account.chatgpt, fixture.cases.duplicateShortWindows));
    expect(unavailable(await h.observe()).reason).toBe("invalid-payload");
  });

  it("classifies missing ChatGPT auth before requesting rate limits", async () => {
    const h = harness(standardHandler(fixture.account.unauthenticated, fixture.cases.success));
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("unauthenticated");
    expect(h.process.requests.map((request) => request.method)).not.toContain("account/rateLimits/read");
    expect(JSON.stringify(envelope)).not.toContain("requiresOpenaiAuth");
  });

  it("classifies API-key auth as unsupported for ChatGPT account quota", async () => {
    const h = harness(standardHandler(fixture.account.apiKey, fixture.cases.success));
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("unsupported");
    expect(h.process.requests.map((request) => request.method)).not.toContain("account/rateLimits/read");
  });

  it("maps JSON-RPC failures without copying provider error text", async () => {
    const h = harness((request, process) => {
      if (request.method === "initialize") process.reply(request.id as number, {});
      if (request.method === "account/read") process.reply(request.id as number, fixture.account.chatgpt);
      if (request.method === "account/rateLimits/read") {
        process.fail(request.id as number, fixture.transport.providerError);
      }
    });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("provider-error");
    expect(JSON.stringify(envelope)).not.toMatch(/MUST_NOT_CROSS|\/home\/private|message/u);
  });

  it.each([
    ["malformedPercent", fixture.cases.malformedPercent],
    ["missingSnapshot", fixture.cases.missingSnapshot],
    ["noWindows", fixture.cases.noWindows],
  ])("fails closed on %s protocol drift", async (_name, payload) => {
    const h = harness(standardHandler(fixture.account.chatgpt, payload));
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("invalid-payload");
    expect(envelope.diagnostics).toEqual([{ code: "INVALID_PAYLOAD", provider: "codex", factIndex: 0 }]);
  });

  it("times out the entire exchange and terminates the child", async () => {
    const h = harness((_request, process) => {
      for (const response of fixture.transport.timeout.responses) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    }, { timeoutMs: 5 });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("timeout");
    expect(envelope.diagnostics[0]).toMatchObject({ code: "SOURCE_TIMEOUT" });
    expect(h.process.signals).toEqual(["SIGTERM"]);
  });

  it("escalates a child that ignores SIGTERM and waits for its SIGKILL close", async () => {
    const h = harness(() => undefined, { timeoutMs: 5, closeOnSignal: "SIGKILL" });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("timeout");
    expect(h.process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.process.didClose).toBe(true);
  });

  it("cancels an in-flight quota read and terminates the child", async () => {
    const controller = new AbortController();
    const h = harness((request, process) => {
      if (request.method === "initialize") process.reply(request.id as number, {});
      if (request.method === "account/read") process.reply(request.id as number, fixture.account.chatgpt);
      if (request.method === "account/rateLimits/read") controller.abort();
    }, { signal: controller.signal });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("cancelled");
    expect(envelope.diagnostics[0]).toMatchObject({ code: "SOURCE_CANCELLED" });
    expect(h.process.signals).toEqual(["SIGTERM"]);
  });

  it("does not spawn when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn<CodexAppServerSpawn>();
    const source = new CodexAppServerObservationSource({ spawn, now: () => new Date(NOW) });
    const envelope = await source.observe({ scope: SCOPE, grant: GRANT, signal: controller.signal });
    expect(unavailable(envelope).reason).toBe("cancelled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("bounds malformed stdout before parsing or retaining it", async () => {
    const h = harness((request, process) => {
      if (request.method === "initialize") {
        process.stdout.write(`MUST_NOT_CROSS_OVERSIZED_${"x".repeat(64 * 1024)}`);
      }
    });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("invalid-payload");
    expect(JSON.stringify(envelope)).not.toContain("MUST_NOT_CROSS_OVERSIZED");
    expect(h.process.signals).toEqual(["SIGTERM"]);
  });

  it("bounds stderr without copying provider diagnostics", async () => {
    const h = harness((request, process) => {
      if (request.method === "initialize") {
        process.stderr.write(`MUST_NOT_CROSS_STDERR_${"x".repeat(32 * 1024)}`);
      }
    });
    const envelope = await h.observe();
    expect(unavailable(envelope).reason).toBe("invalid-payload");
    expect(JSON.stringify(envelope)).not.toContain("MUST_NOT_CROSS_STDERR");
  });

  it("rejects malformed JSON and unexpected response ids", async () => {
    const malformed = harness((request, process) => {
      if (request.method === "initialize") process.stdout.write("{MUST_NOT_CROSS_JSON}\n");
    });
    expect(unavailable(await malformed.observe()).reason).toBe("invalid-payload");

    const unexpected = harness((request, process) => {
      if (request.method === "initialize") process.reply(99, { secret: "MUST_NOT_CROSS_WRONG_ID" });
    });
    const envelope = await unexpected.observe();
    expect(unavailable(envelope).reason).toBe("invalid-payload");
    expect(JSON.stringify(envelope)).not.toContain("MUST_NOT_CROSS_WRONG_ID");
  });

  it("maps synchronous spawn failures without exposing the error", async () => {
    const source = new CodexAppServerObservationSource({
      spawn: () => { throw new Error("MUST_NOT_CROSS_SPAWN_PATH /private/codex"); },
      now: () => new Date(NOW),
    });
    const envelope = await source.observe({ scope: SCOPE, grant: GRANT });
    expect(unavailable(envelope).reason).toBe("provider-error");
    expect(JSON.stringify(envelope)).not.toContain("MUST_NOT_CROSS_SPAWN_PATH");
  });

  it("fails invalid account scope closed to provider scope without launching", async () => {
    const spawn = vi.fn<CodexAppServerSpawn>();
    const source = new CodexAppServerObservationSource({ spawn, now: () => new Date(NOW) });
    const envelope = await source.observe({
      scope: { ...SCOPE, key: "customer@example.invalid" },
      grant: GRANT,
    });
    expect(unavailable(envelope)).toMatchObject({
      reason: "invalid-payload",
      scope: { kind: "provider", provider: "codex" },
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
