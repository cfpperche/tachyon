import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectCodexBarPayload } from "../../scripts/spikes/codexbar-vendor/collectorEnvelope.js";

const OPTIONS = {
  engineVersion: "0.43.0",
  upstreamTag: "v0.43.0",
  upstreamCommit: "5a0cbc07119ac04d998e2fd5267442ed9358fff0",
  generatedAt: "2026-07-14T16:15:00.000Z",
};

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "codex",
    source: "oauth",
    version: "0.144.4",
    usage: {
      primary: null,
      secondary: { usedPercent: 63, windowMinutes: 10_080, resetsAt: "2026-07-19T19:19:41Z" },
      tertiary: null,
      updatedAt: "2026-07-14T16:11:52Z",
      dataConfidence: "exact",
      identity: { accountEmail: "must-not-cross@example.invalid", token: "secret" },
    },
    credits: { remaining: 10 },
    ...overrides,
  };
}

describe("CodexBar vendor spike CollectorEnvelopeV1", () => {
  it("keeps the committed upstream-shape corpus synthetic, redacted, and executable", () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), "test/fixtures/codexbar-vendor-v0.43.0.json"), "utf8")) as {
      cases: Record<string, unknown>;
    };
    const serialized = JSON.stringify(fixture);
    expect(serialized).not.toMatch(/@[a-z0-9]|sk-ant|\/home\/|cookieHeader|accessToken/i);
    expect(projectCodexBarPayload(fixture.cases.codexPartialSuccess, OPTIONS).facts[0]).toMatchObject({ kind: "provider-quota" });
    expect(projectCodexBarPayload(fixture.cases.claudeSuccess, OPTIONS).facts[0]).toMatchObject({ kind: "provider-quota" });
    expect(projectCodexBarPayload(fixture.cases.unavailable, OPTIONS).facts[0]).toMatchObject({ kind: "provider-unavailable" });
    expect(projectCodexBarPayload(fixture.cases.authFailure, OPTIONS).facts[0]).toMatchObject({ kind: "provider-unavailable" });
    expect(projectCodexBarPayload(fixture.cases.staleLastGood, OPTIONS).facts[0]).toMatchObject({
      kind: "provider-quota",
      observedAt: "2026-07-14T15:45:00.000Z",
    });
    expect(projectCodexBarPayload(fixture.cases.hostile, OPTIONS).facts[0]).toMatchObject({ kind: "provider-unavailable" });
  });

  it("projects only allowlisted quota facts with engine and schema provenance", () => {
    const result = projectCodexBarPayload(valid(), OPTIONS);
    expect(result).toMatchObject({
      schemaVersion: 1,
      engine: { name: "codexbar", version: "0.43.0", upstreamTag: "v0.43.0", upstreamCommit: OPTIONS.upstreamCommit },
      facts: [{ kind: "provider-quota", provider: "codex", source: "oauth", confidence: "exact", windows: [{ name: "weekly", usedPercent: 63 }] }],
      diagnostics: [],
    });
    expect(result.facts[0]).toMatchObject({ observedAt: "2026-07-14T16:11:52.000Z" });
    expect(JSON.stringify(result)).not.toMatch(/account|email|token|credits|secret/i);
  });

  it("tolerates unknown additive upstream fields", () => {
    const record = valid({ futureTopLevel: { anything: true } });
    (record.usage as Record<string, unknown>).futureUsageField = ["ignored"];
    expect(projectCodexBarPayload(record, OPTIONS).facts[0]).toMatchObject({ kind: "provider-quota" });
  });

  it.each(["web", "openai-web", "api", "local"])("fails disallowed source %s closed", (source) => {
    const result = projectCodexBarPayload(valid({ source }), OPTIONS);
    expect(result.facts).toEqual([{ kind: "provider-unavailable", provider: "codex", reason: "invalid-payload" }]);
    expect(result.diagnostics).toEqual([{ provider: "codex", code: "INVALID_PAYLOAD" }]);
  });

  it("rejects duplicate provider records", () => {
    expect(() => projectCodexBarPayload([valid(), valid()], OPTIONS)).toThrow("duplicate provider record");
  });

  it.each([
    { usedPercent: Number.NaN, windowMinutes: 300 },
    { usedPercent: 101, windowMinutes: 300 },
    { usedPercent: 10, windowMinutes: 0 },
    { usedPercent: 10, windowMinutes: 300, resetsAt: "not-a-date" },
  ])("fails a malformed critical window closed to bounded unavailable", (secondary) => {
    const record = valid();
    (record.usage as Record<string, unknown>).secondary = secondary;
    const result = projectCodexBarPayload(record, OPTIONS);
    expect(result.facts).toEqual([{ kind: "provider-unavailable", provider: "codex", reason: "invalid-payload" }]);
    expect(result.diagnostics).toEqual([{ provider: "codex", code: "INVALID_PAYLOAD" }]);
  });

  it("fails an invalid observation timestamp closed", () => {
    const record = valid();
    (record.usage as Record<string, unknown>).updatedAt = "yesterday";
    expect(projectCodexBarPayload(record, OPTIONS).facts[0]).toEqual({
      kind: "provider-unavailable",
      provider: "codex",
      reason: "invalid-payload",
    });
  });

  it("maps upstream failures without copying raw messages, paths, or credentials", () => {
    const result = projectCodexBarPayload({
      provider: "claude",
      source: "auto",
      error: { code: 1, kind: "provider", message: "token=secret at /home/user/.claude" },
    }, OPTIONS);
    expect(result.facts).toEqual([{ kind: "provider-unavailable", provider: "claude", reason: "upstream-error" }]);
    expect(result.diagnostics).toEqual([{ provider: "claude", code: "UPSTREAM_ERROR" }]);
    expect(JSON.stringify(result)).not.toMatch(/secret|\/home|message|token/i);
  });
});
