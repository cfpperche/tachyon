import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  GrokUsageObservationSource,
  type GrokUsageSpawn,
} from "@tachyon/engine/runtimeObservability/grokUsageSource.js";
import {
  PROVIDER_QUOTA_READ_CAPABILITY,
  type ProviderObservationGrantV1,
} from "@tachyon/engine/runtimeObservability/source.js";

const NOW = "2026-08-17T17:55:00.000Z";
const SCOPE = { kind: "provider-account", provider: "grok", key: "ps_0000000000000001" } as const;
const GRANT: ProviderObservationGrantV1 = {
  state: "granted",
  capability: PROVIDER_QUOTA_READ_CAPABILITY,
  source: "cli",
  consent: "explicit-user",
};

class FakeGrokProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Array<Record<string, unknown>> = [];
  readonly signals: NodeJS.Signals[] = [];
  private input = "";
  private closed = false;

  constructor(
    private readonly billing: unknown,
    private readonly onRequest?: (request: Record<string, unknown>, process: FakeGrokProcess) => void,
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
        if (this.onRequest) {
          this.onRequest(request, this);
          continue;
        }
        if (request.method === "initialize") this.reply(request.id as number, { protocolVersion: 1 });
        if (request.method === "_x.ai/billing") this.reply(request.id as number, this.billing);
      }
    });
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  reply(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    queueMicrotask(() => this.close(signal));
    return true;
  }

  close(signal: NodeJS.Signals): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", null, signal);
  }
}

function sourceFor(
  billing: unknown,
  options: { onRequest?: (request: Record<string, unknown>, process: FakeGrokProcess) => void; timeoutMs?: number } = {},
): { source: GrokUsageObservationSource; process: FakeGrokProcess; spawn: ReturnType<typeof vi.fn<GrokUsageSpawn>> } {
  const process = new FakeGrokProcess(billing, options.onRequest);
  const spawn = vi.fn<GrokUsageSpawn>(() => process.asChild());
  return {
    source: new GrokUsageObservationSource({ spawn, timeoutMs: options.timeoutMs, now: () => new Date(NOW) }),
    process,
    spawn,
  };
}

describe("GrokUsageObservationSource", () => {
  it("reads the token-free ACP billing control plane and projects the provider-reported weekly ceiling", async () => {
    const h = sourceFor({
      config: {
        creditUsagePercent: 1,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-08-17T08:28:21.629738+00:00",
          end: "2026-08-24T08:28:21.629738+00:00",
        },
        onDemandCap: { val: 0 },
        prepaidBalance: { val: 0 },
      },
      subscription_tier: "SuperGrok Heavy",
      secret: "MUST_NOT_CROSS",
    });

    const envelope = await h.source.observe({ scope: SCOPE, grant: GRANT });

    expect(h.spawn).toHaveBeenCalledWith("grok", ["agent", "--no-leader", "stdio"]);
    expect(h.process.requests.map((request) => request.method)).toEqual(["initialize", "_x.ai/billing"]);
    expect(envelope.facts).toEqual([{
      kind: "provider-quota",
      scope: SCOPE,
      source: "cli",
      confidence: "exact",
      observedAt: NOW,
      freshness: { state: "fresh" },
      windows: [{ name: "weekly", usedPercent: 1, resetsAt: "2026-08-24T08:28:21.629Z" }],
    }]);
    expect(JSON.stringify(envelope)).not.toMatch(/SuperGrok|MUST_NOT_CROSS|onDemand/u);
    expect(h.process.signals).toEqual(["SIGTERM"]);
  });

  it.each([
    ["missing percentage", { config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: NOW, end: NOW } } }],
    ["invented plan denominator", { config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: NOW, end: NOW } }, subscription_tier: "SuperGrok Heavy" }],
    ["wrong period", { config: { creditUsagePercent: 1, currentPeriod: { type: "USAGE_PERIOD_TYPE_DAILY", start: NOW, end: NOW } } }],
  ])("fails closed on %s", async (_name, billing) => {
    const h = sourceFor(billing);
    const envelope = await h.source.observe({ scope: SCOPE, grant: GRANT });
    expect(envelope.facts[0]).toMatchObject({ kind: "provider-unavailable", reason: "invalid-payload" });
  });

  it("does not launch without an explicit grant", async () => {
    const h = sourceFor({});
    const envelope = await h.source.observe({ scope: SCOPE, grant: { state: "disabled" } });
    expect(envelope.facts[0]).toMatchObject({ kind: "provider-unavailable", reason: "source-disabled" });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("classifies an unauthenticated ACP billing error in the existing provider-error bucket", async () => {
    const h = sourceFor({}, {
      onRequest: (request, process) => {
        if (request.method === "initialize") process.reply(request.id as number, { protocolVersion: 1 });
        if (request.method === "_x.ai/billing") {
          process.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: 401, message: "authentication required" },
          })}\n`);
        }
      },
    });
    const envelope = await h.source.observe({ scope: SCOPE, grant: GRANT });
    expect(envelope.facts[0]).toMatchObject({ kind: "provider-unavailable", reason: "provider-error" });
    expect(envelope.diagnostics[0]).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(JSON.stringify(envelope)).not.toContain("authentication required");
  });

  it("times out the exchange and terminates the child", async () => {
    const h = sourceFor({}, { timeoutMs: 5, onRequest: () => undefined });
    const envelope = await h.source.observe({ scope: SCOPE, grant: GRANT });
    expect(envelope.facts[0]).toMatchObject({ kind: "provider-unavailable", reason: "timeout" });
    expect(envelope.diagnostics[0]).toMatchObject({ code: "SOURCE_TIMEOUT" });
    expect(h.process.signals).toEqual(["SIGTERM"]);
  });

  it("cancels an in-flight billing read and terminates the child", async () => {
    const controller = new AbortController();
    const h = sourceFor({}, {
      onRequest: (request, process) => {
        if (request.method === "initialize") process.reply(request.id as number, { protocolVersion: 1 });
        if (request.method === "_x.ai/billing") controller.abort();
      },
    });
    const envelope = await h.source.observe({ scope: SCOPE, grant: GRANT, signal: controller.signal });
    expect(envelope.facts[0]).toMatchObject({ kind: "provider-unavailable", reason: "cancelled" });
    expect(envelope.diagnostics[0]).toMatchObject({ code: "SOURCE_CANCELLED" });
    expect(h.process.signals).toEqual(["SIGTERM"]);
  });

  it("maps a spawn failure to provider-error without leaking the thrown error", async () => {
    const spawn = vi.fn<GrokUsageSpawn>(() => { throw new Error("MUST_NOT_CROSS_SPAWN_PATH"); });
    const source = new GrokUsageObservationSource({ spawn, now: () => new Date(NOW) });
    const envelope = await source.observe({ scope: SCOPE, grant: GRANT });
    expect(envelope.facts[0]).toMatchObject({ kind: "provider-unavailable", reason: "provider-error" });
    expect(envelope.diagnostics[0]).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(JSON.stringify(envelope)).not.toContain("MUST_NOT_CROSS_SPAWN_PATH");
  });

  it("fails closed when the ACP initialize protocol drifts", async () => {
    const h = sourceFor({}, {
      onRequest: (request, process) => {
        if (request.method === "initialize") process.reply(request.id as number, { protocolVersion: 2 });
      },
    });
    const envelope = await h.source.observe({ scope: SCOPE, grant: GRANT });
    expect(envelope.facts[0]).toMatchObject({ kind: "provider-unavailable", reason: "invalid-payload" });
    expect(envelope.diagnostics[0]).toMatchObject({ code: "INVALID_PAYLOAD" });
  });
});
