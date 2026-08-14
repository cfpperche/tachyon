import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  GrokInspectConfigObservationSource,
  type GrokInspectSpawn,
} from "../../src/runtimeObservability/grokInspectConfigSource.js";
import {
  PROVIDER_CONFIGURATION_READ_CAPABILITY,
  type ConfigurationObservationGrantV1,
} from "@tachyon/engine/runtimeObservability/source.js";
import type { CollectorEnvelopeV1, ProviderConfigurationFactV1 } from "@tachyon/engine/runtimeObservability/types.js";
import { validateCollectorEnvelopeV1 } from "@tachyon/engine/runtimeObservability/validate.js";

const NOW = "2026-08-02T18:00:00.000Z";
const SCOPE = {
  kind: "agent" as const,
  workspaceKey: "ws-observability",
  agentKey: "agent-solo",
};
const GRANT: ConfigurationObservationGrantV1 = {
  state: "granted",
  capability: PROVIDER_CONFIGURATION_READ_CAPABILITY,
  source: "cli",
  consent: "explicit-user",
};

const AGENT_HOME_A = "/tmp/tachyon-grok-home-agent-a";
const AGENT_HOME_B = "/tmp/tachyon-grok-home-agent-b";
const WORKSPACE_AMBIENT = "/tmp/tachyon-workspace-ambient-home";

const TOKEN = "fake-bridge-token-for-tests-0000000000000000";
const SESSION_ID = "a8f52d0c-a921-4b70-b346-d4ca7077a991";
const CREDENTIAL = "REAL-SECRET-DO-NOT-SURFACE-9f3a";

/** Measured shape of `grok inspect --json` (0.2.118) with secrets planted in fields that must not project. */
function inspectPayload(markerHome: string, mcpName: string): Record<string, unknown> {
  return {
    grokVersion: "0.2.118",
    channel: "unknown",
    cwd: "/tmp/repo",
    projectRoot: "/tmp/repo/",
    projectTrusted: true,
    projectInstructions: [`session ${SESSION_ID}`, `token ${TOKEN}`],
    permissions: {
      sources: [`${markerHome}/.claude/settings.json (settings)`],
      loaded: 0,
      skipped: [],
      mcpServerAllowlist: [],
      marketplaceAllowlist: [],
      managedSettingsPath: "/etc/claude-code/managed-settings.json",
      managedSettingsExists: false,
      managedSettingsActive: false,
    },
    loginPolicy: {
      disableApiKeyAuth: null,
      forceLoginTeamUuid: "team-uuid-must-not-leak",
      apiKeyAuthDisabled: false,
    },
    hooks: [],
    skills: [],
    agents: [{ name: "general-purpose", description: "…", source: { type: "builtin" } }],
    plugins: [],
    marketplaces: [],
    mcpServers: [
      {
        name: mcpName,
        transport: "http",
        target: `http://127.0.0.1:9/mcp?token=${TOKEN}`,
        source: {
          type: "configToml",
          path: `${markerHome}/config.toml`,
        },
        // Inspect does not currently emit headers; plant them so a future leak is still filtered.
        headers: {
          Authorization: `Bearer ${CREDENTIAL}`,
          "X-Session-Id": SESSION_ID,
        },
      },
    ],
    lspServers: [],
    configSources: {
      layers: [
        { role: "user", path: `${markerHome}/config.toml` },
      ],
    },
    externalCompat: {
      remoteSettingsLoaded: false,
      cells: [
        { vendor: "claude", surface: "skills", enabled: false, source: "config" },
        { vendor: "claude", surface: "memory", enabled: false, source: "config" },
      ],
    },
  };
}

type InspectHandler = (process: FakeInspectProcess, spawnEnv: NodeJS.ProcessEnv) => void;

class FakeInspectProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  private closed = false;

  constructor(
    handler: InspectHandler,
    spawnEnv: NodeJS.ProcessEnv,
    private readonly closeOnSignal: NodeJS.Signals | null = "SIGTERM",
  ) {
    super();
    this.stdin.once("finish", () => handler(this, spawnEnv));
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

function harness(options: {
  handler?: InspectHandler;
  timeoutMs?: number;
  signal?: AbortSignal;
  grokHome?: string;
  coBindHome?: boolean;
  grant?: ConfigurationObservationGrantV1 | { state: "disabled" } | Record<string, unknown>;
  closeOnSignal?: NodeJS.Signals | null;
} = {}): {
  spawn: ReturnType<typeof vi.fn<GrokInspectSpawn>>;
  lastEnv: () => NodeJS.ProcessEnv | undefined;
  observe: () => Promise<CollectorEnvelopeV1>;
} {
  let lastEnv: NodeJS.ProcessEnv | undefined;
  const spawn = vi.fn<GrokInspectSpawn>((_command, _args, spawnOptions) => {
    lastEnv = spawnOptions.env;
    const process = new FakeInspectProcess(
      options.handler ?? ((child) => {
        const home = spawnOptions.env.GROK_HOME ?? "missing";
        const mcp = home.includes("agent-a") ? "marker_from_home_a" : "marker_from_home_b";
        child.reply(inspectPayload(home, mcp));
      }),
      spawnOptions.env,
      options.closeOnSignal === undefined ? "SIGTERM" : options.closeOnSignal,
    );
    return process.asChild();
  });
  const source = new GrokInspectConfigObservationSource({
    spawn,
    timeoutMs: options.timeoutMs,
    now: () => new Date(NOW),
  });
  return {
    spawn,
    lastEnv: () => lastEnv,
    observe: () => source.observe({
      scope: SCOPE,
      grokHome: options.grokHome ?? AGENT_HOME_A,
      coBindHome: options.coBindHome,
      grant: (options.grant ?? GRANT) as ConfigurationObservationGrantV1,
      signal: options.signal,
    }),
  };
}

function configuration(envelope: CollectorEnvelopeV1): ProviderConfigurationFactV1 {
  const fact = envelope.facts[0];
  expect(fact?.kind).toBe("provider-configuration");
  return fact as ProviderConfigurationFactV1;
}

function unavailable(envelope: CollectorEnvelopeV1): Extract<CollectorEnvelopeV1["facts"][number], { kind: "provider-unavailable" }> {
  const fact = envelope.facts[0];
  expect(fact?.kind).toBe("provider-unavailable");
  return fact as Extract<CollectorEnvelopeV1["facts"][number], { kind: "provider-unavailable" }>;
}

describe("t-032f08 — Grok configuration observation via inspect --json", () => {
  it("projects allowlisted configuration and refuses the quota channel by name", async () => {
    const { observe, spawn } = harness({ grokHome: AGENT_HOME_A });
    const envelope = await observe();

    expect(validateCollectorEnvelopeV1(envelope)).toMatchObject({ ok: true });
    expect(spawn).toHaveBeenCalledWith("grok", ["inspect", "--json"], expect.objectContaining({
      env: expect.objectContaining({ GROK_HOME: AGENT_HOME_A, HOME: AGENT_HOME_A }),
    }));

    const fact = configuration(envelope);
    expect(fact).toMatchObject({
      kind: "provider-configuration",
      runtime: "grok",
      source: "cli",
      confidence: "exact",
      scope: SCOPE,
      grokVersion: "0.2.118",
      projectTrusted: true,
      permissionsLoaded: 0,
      configLayerRoles: ["user"],
      mcpServerNames: ["marker_from_home_a"],
      quotaChannel: { state: "unsupported", reason: "no-quota-channel" },
      freshness: { state: "fresh" },
    });
    expect(fact.externalCompat).toEqual([
      { vendor: "claude", surface: "skills", enabled: false, source: "config" },
      { vendor: "claude", surface: "memory", enabled: false, source: "config" },
    ]);

    // Never invent quota from configuration observation.
    expect(envelope.facts.some((entry) => entry.kind === "provider-quota")).toBe(false);
    expect(envelope.facts).toHaveLength(1);
  });

  it("observes the agent GROK_HOME, not the workspace ambient home", async () => {
    const { observe, lastEnv, spawn } = harness({
      grokHome: AGENT_HOME_B,
      handler: (child, env) => {
        // Prove the child saw home B. A wrong home would project the wrong MCP marker.
        expect(env.GROK_HOME).toBe(AGENT_HOME_B);
        expect(env.HOME).toBe(AGENT_HOME_B);
        expect(env.GROK_HOME).not.toBe(WORKSPACE_AMBIENT);
        child.reply(inspectPayload(env.GROK_HOME ?? "", "marker_from_home_b"));
      },
    });

    const envelope = await observe();
    const fact = configuration(envelope);
    expect(fact.mcpServerNames).toEqual(["marker_from_home_b"]);
    expect(lastEnv()?.GROK_HOME).toBe(AGENT_HOME_B);
    expect(spawn.mock.calls[0]?.[2]?.env.GROK_HOME).toBe(AGENT_HOME_B);
    expect(spawn.mock.calls[0]?.[2]?.env.GROK_HOME).not.toBe(WORKSPACE_AMBIENT);
  });

  it("never projects secrets, session ids, tokens, credentials, or absolute home paths", async () => {
    const { observe } = harness({
      grokHome: AGENT_HOME_A,
      handler: (child) => child.reply(inspectPayload(AGENT_HOME_A, "tachyon_bridge")),
    });
    const envelope = await observe();
    const wire = JSON.stringify(envelope);

    expect(wire).not.toContain(TOKEN);
    expect(wire).not.toContain(SESSION_ID);
    expect(wire).not.toContain(CREDENTIAL);
    expect(wire).not.toContain(AGENT_HOME_A);
    expect(wire).not.toContain("Bearer");
    expect(wire).not.toContain("team-uuid-must-not-leak");
    expect(wire).not.toContain("config.toml");
    expect(wire).not.toContain("Authorization");
    expect(wire).not.toContain("/tmp/repo");

    const fact = configuration(envelope);
    expect(fact.mcpServerNames).toEqual(["tachyon_bridge"]);
    expect(fact.configLayerRoles).toEqual(["user"]);
  });

  it("reports unavailable with a reason when inspect is missing or fails — never a partial success", async () => {
    const missing = await harness({
      handler: (child) => child.close(127),
    }).observe();
    expect(unavailable(missing).reason).toBe("provider-error");
    expect(missing.facts).toHaveLength(1);
    expect(missing.diagnostics[0]?.code).toBe("SOURCE_UNAVAILABLE");

    const malformed = await harness({
      handler: (child) => {
        child.stdout.write("{not-json");
        child.close(0);
      },
    }).observe();
    expect(unavailable(malformed).reason).toBe("invalid-payload");
    expect(malformed.diagnostics[0]?.code).toBe("INVALID_PAYLOAD");

    const emptyObject = await harness({
      handler: (child) => child.reply({}),
    }).observe();
    expect(unavailable(emptyObject).reason).toBe("invalid-payload");

    // A payload that looks like it gained a quota channel must not become config-or-quota success here.
    const withQuotaShape = await harness({
      handler: (child) => child.reply({
        ...inspectPayload(AGENT_HOME_A, "keep"),
        rateLimits: { primary: { usedPercent: 0 } },
      }),
    }).observe();
    expect(unavailable(withQuotaShape).reason).toBe("invalid-payload");
    expect(withQuotaShape.facts.some((entry) => entry.kind === "provider-quota")).toBe(false);
  });

  it("honors disabled grants, missing consent, cancellation, and timeout", async () => {
    const disabled = await harness({ grant: { state: "disabled" } }).observe();
    expect(unavailable(disabled).reason).toBe("source-disabled");

    const noConsent = await harness({
      grant: {
        state: "granted",
        capability: PROVIDER_CONFIGURATION_READ_CAPABILITY,
        source: "cli",
        consent: "ambient",
      },
    }).observe();
    expect(unavailable(noConsent).reason).toBe("unsupported");

    const controller = new AbortController();
    controller.abort();
    const cancelled = await harness({ signal: controller.signal }).observe();
    expect(unavailable(cancelled).reason).toBe("cancelled");
    expect(cancelled.diagnostics[0]?.code).toBe("SOURCE_CANCELLED");

    const timedOut = await harness({
      timeoutMs: 20,
      closeOnSignal: null,
      handler: () => {
        // Never reply — the adapter deadline owns the outcome.
      },
    }).observe();
    expect(unavailable(timedOut).reason).toBe("timeout");
    expect(timedOut.diagnostics[0]?.code).toBe("SOURCE_TIMEOUT");
  });

  it("rejects relative GROK_HOME so ambient resolution cannot observe the wrong agent", async () => {
    const source = new GrokInspectConfigObservationSource({
      now: () => new Date(NOW),
      spawn: () => {
        throw new Error("spawn must not run for unsafe home");
      },
    });
    const envelope = await source.observe({
      scope: SCOPE,
      grokHome: "relative/home",
      grant: GRANT,
    });
    expect(unavailable(envelope).reason).toBe("invalid-payload");
  });
});
