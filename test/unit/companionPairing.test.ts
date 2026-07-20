import { describe, expect, it } from "vitest";
import { CompanionPairingService } from "../../src/companion/CompanionPairingService.js";
import { COMPANION_PROTOCOL_VERSION } from "../../src/companion/protocol.js";
import { handleCompanionHttp } from "../../src/companion/CompanionHttp.js";
import http from "node:http";
import { AddressInfo } from "node:net";

describe("CompanionPairingService (SDD 414 slice 2)", () => {
  it("issues a pair code only when base URL is available", () => {
    let base: string | undefined;
    const svc = new CompanionPairingService({
      engineLabel: "demo",
      engineId: "abc123",
      getBaseUrl: () => base,
    });
    expect(svc.issuePairCode()).toEqual({ ok: false, reason: "bridge_down" });
    base = "http://127.0.0.1:41234";
    const issued = svc.issuePairCode();
    expect(issued).toMatchObject({
      baseUrl: base,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
    });
    if ("ok" in issued) throw new Error("expected success");
    expect(issued.code).toMatch(/^[A-Z2-9]{8}$/);
  });

  it("pairs with a valid code and replaces a prior session (one active pair)", () => {
    const svc = new CompanionPairingService({
      engineLabel: "demo",
      engineId: "abc123",
      getBaseUrl: () => "http://127.0.0.1:1",
    });
    const a = svc.issuePairCode();
    if ("ok" in a) throw new Error("expected code");
    const first = svc.pair({
      pairCode: a.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "browser", name: "Tachyon Companion", version: "0.1.0" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.sessionToken).toHaveLength(64);
    expect(svc.status(first.sessionToken).status).toBe("connected");

    const b = svc.issuePairCode();
    if ("ok" in b) throw new Error("expected code");
    const second = svc.pair({
      pairCode: b.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "browser", name: "Tachyon Companion", version: "0.1.1" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(svc.status(first.sessionToken).status).toBe("error");
    expect(svc.status(second.sessionToken).status).toBe("connected");
  });

  it("rejects wrong code, expired code, and protocol mismatch", () => {
    let now = 1_000_000;
    const svc = new CompanionPairingService({
      engineLabel: "demo",
      engineId: "abc123",
      getBaseUrl: () => "http://127.0.0.1:1",
      now: () => now,
      pairCodeTtlMs: 1000,
    });
    const issued = svc.issuePairCode();
    if ("ok" in issued) throw new Error("expected code");

    const bad = svc.pair({
      pairCode: "ZZZZZZZZ",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "browser", name: "x", version: "0" },
    });
    expect(bad).toMatchObject({ ok: false, code: "invalid_code" });

    const mismatch = svc.pair({
      pairCode: issued.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION + 1,
      client: { kind: "browser", name: "x", version: "0" },
    });
    expect(mismatch).toMatchObject({
      ok: false,
      code: "protocol_mismatch",
      serverProtocolVersion: COMPANION_PROTOCOL_VERSION,
    });

    now += 5000;
    const expired = svc.pair({
      pairCode: issued.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "browser", name: "x", version: "0" },
    });
    expect(expired).toMatchObject({ ok: false, code: "expired_code" });
  });

  it("unpairs a live session", () => {
    const svc = new CompanionPairingService({
      engineLabel: "demo",
      engineId: "abc123",
      getBaseUrl: () => "http://127.0.0.1:1",
    });
    const issued = svc.issuePairCode();
    if ("ok" in issued) throw new Error("expected code");
    const paired = svc.pair({
      pairCode: issued.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "browser", name: "x", version: "0" },
    });
    if (!paired.ok) throw new Error("pair failed");
    expect(svc.unpair(paired.sessionToken)).toEqual({ ok: true });
    expect(svc.status(paired.sessionToken).status).toBe("disconnected");
  });
});

describe("Companion HTTP loopback (SDD 414)", () => {
  it("serves health, pair, status, unpair, agents, and prompt on /companion/v1", async () => {
    const pairing = new CompanionPairingService({
      engineLabel: "ws",
      engineId: "hash",
      getBaseUrl: () => `http://127.0.0.1:${port}`,
    });
    const sent: Array<{ agent: string; text: string }> = [];
    let port = 0;
    const server = http.createServer((req, res) => {
      void handleCompanionHttp(req, res, {
        pairing,
        ops: {
          listActiveAgents: async () => [
            { name: "grok", attention: "idle", composerOccupied: false },
            { name: "codex", attention: "working", composerOccupied: false },
          ],
          sendPrompt: async (agent, text) => {
            sent.push({ agent, text });
            return agent === "codex"
              ? { ok: true, status: "queued", agent, queued: 1 }
              : { ok: true, status: "notified", agent };
          },
        },
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/companion/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, protocolVersion: COMPANION_PROTOCOL_VERSION });

    const issued = pairing.issuePairCode();
    if ("ok" in issued) throw new Error("expected code");

    const pairRes = await fetch(`${base}/companion/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairCode: issued.code,
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        client: { kind: "browser", name: "Tachyon Companion", version: "0.1.0" },
      }),
    });
    expect(pairRes.status).toBe(200);
    const paired = (await pairRes.json()) as { ok: true; sessionToken: string };
    expect(paired.ok).toBe(true);
    const token = paired.sessionToken;

    const statusRes = await fetch(`${base}/companion/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toMatchObject({ status: "connected" });

    const agentsRes = await fetch(`${base}/companion/v1/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(agentsRes.status).toBe(200);
    const agentsBody = (await agentsRes.json()) as {
      ok: true;
      agents: Array<{ name: string; attention: string }>;
    };
    expect(agentsBody.ok).toBe(true);
    expect(agentsBody.agents.map((a) => a.name).sort()).toEqual(["codex", "grok"]);
    expect(agentsBody.agents.find((a) => a.name === "codex")).toMatchObject({ attention: "working" });
    expect(agentsBody.agents.find((a) => a.name === "grok")).toMatchObject({ attention: "idle" });

    const promptIdle = await fetch(`${base}/companion/v1/prompt`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ agent: "grok", text: "hello from companion" }),
    });
    expect(promptIdle.status).toBe(200);
    expect(await promptIdle.json()).toMatchObject({ ok: true, status: "notified", agent: "grok" });

    const promptBusy = await fetch(`${base}/companion/v1/prompt`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ agent: "codex", text: "queue me" }),
    });
    expect(promptBusy.status).toBe(200);
    expect(await promptBusy.json()).toMatchObject({ ok: true, status: "queued", agent: "codex" });
    expect(sent).toEqual([
      { agent: "grok", text: "hello from companion" },
      { agent: "codex", text: "queue me" },
    ]);

    const unauth = await fetch(`${base}/companion/v1/agents`);
    expect(unauth.status).toBe(401);

    const unpairRes = await fetch(`${base}/companion/v1/unpair`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unpairRes.status).toBe(200);

    server.close();
  });
});
