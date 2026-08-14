import { describe, expect, it } from "vitest";
import { CompanionPairingService } from "@tachyon/engine/companion/CompanionPairingService.js";
import { COMPANION_PROTOCOL_VERSION } from "@tachyon/engine/companion/protocol.js";
import { handleCompanionHttp } from "@tachyon/engine/companion/CompanionHttp.js";
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
    expect(issued.baseUrls).toEqual([base]);
    const payload = JSON.parse(issued.qrPayload) as {
      type: string;
      schemaVersion: number;
      baseUrl: string;
      baseUrls: string[];
      pairCode: string;
      protocolVersion: number;
    };
    expect(payload).toMatchObject({
      type: "tachyon.companion.pair",
      schemaVersion: 1,
      baseUrl: base,
      pairCode: issued.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
    });
    expect(payload.baseUrls).toContain(base);
    expect(issued.openUrl).toBe(
      `${base}/companion/app/#pair=${encodeURIComponent(issued.qrPayload)}`,
    );
  });

  it("uses single Tailscale baseUrl when candidates provided (SDD 422 mobile)", () => {
    const svc = new CompanionPairingService({
      engineLabel: "demo",
      engineId: "abc123",
      getBaseUrl: () => "http://100.64.1.2:41000",
      getBaseUrlCandidates: () => ["http://100.64.1.2:41000"],
    });
    const issued = svc.issuePairCode();
    if ("ok" in issued) throw new Error("expected success");
    expect(issued.baseUrl).toBe("http://100.64.1.2:41000");
    expect(issued.baseUrls).toEqual(["http://100.64.1.2:41000"]);
    expect(issued.openUrl.startsWith("http://100.64.1.2:41000/companion/app/#pair=")).toBe(true);
  });

  it("returns tailscale_required when block reason is set", () => {
    const svc = new CompanionPairingService({
      engineLabel: "demo",
      engineId: "abc123",
      getBaseUrl: () => undefined,
      getPairBlockReason: () => "tailscale_required",
    });
    expect(svc.issuePairCode()).toEqual({ ok: false, reason: "tailscale_required" });
  });

  it("same-kind pair replaces prior session only (422 one-per-kind)", () => {
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
    const devices = svc.listDevices(() => true);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      kind: "browser",
      name: "Tachyon Companion",
      version: "0.1.0",
      live: true,
    });
    expect(devices[0]!.id).toMatch(/^[0-9a-f]{12}$/);

    const b = svc.issuePairCode();
    if ("ok" in b) throw new Error("expected code");
    const second = svc.pair({
      pairCode: b.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "browser", name: "Tachyon Companion", version: "0.1.1" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect("replacedSessionToken" in second && second.replacedSessionToken).toBe(first.sessionToken);
    expect(svc.status(first.sessionToken).status).toBe("error");
    expect(svc.status(second.sessionToken).status).toBe("connected");
    expect(svc.hasPairedKind("browser")).toBe(true);
    expect(svc.tokensForKind("browser")).toEqual([second.sessionToken]);
  });

  it("browser and mobile sessions co-exist; same-kind replace leaves the other intact", () => {
    const svc = new CompanionPairingService({
      engineLabel: "demo",
      engineId: "abc123",
      getBaseUrl: () => "http://127.0.0.1:1",
    });
    const codeBrowser = svc.issuePairCode();
    if ("ok" in codeBrowser) throw new Error("expected code");
    const browser = svc.pair({
      pairCode: codeBrowser.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "browser", name: "ext", version: "1" },
    });
    if (!browser.ok) throw new Error("browser pair failed");

    const codeMobile = svc.issuePairCode();
    if ("ok" in codeMobile) throw new Error("expected code");
    const mobile = svc.pair({
      pairCode: codeMobile.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "mobile", name: "phone", version: "1" },
    });
    if (!mobile.ok) throw new Error("mobile pair failed");

    expect(svc.hasPairedKind("browser")).toBe(true);
    expect(svc.hasPairedKind("mobile")).toBe(true);
    expect(svc.status(browser.sessionToken).status).toBe("connected");
    expect(svc.status(mobile.sessionToken).status).toBe("connected");
    expect(svc.listDevices()).toHaveLength(2);
    expect(svc.tokensForKind("browser")).toEqual([browser.sessionToken]);
    expect(svc.tokensForKind("mobile")).toEqual([mobile.sessionToken]);

    // Replacing browser must not kill mobile.
    const codeBrowser2 = svc.issuePairCode();
    if ("ok" in codeBrowser2) throw new Error("expected code");
    const browser2 = svc.pair({
      pairCode: codeBrowser2.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "browser", name: "ext2", version: "2" },
    });
    if (!browser2.ok) throw new Error("browser re-pair failed");
    expect(svc.status(browser.sessionToken).status).toBe("error");
    expect(svc.status(browser2.sessionToken).status).toBe("connected");
    expect(svc.status(mobile.sessionToken).status).toBe("connected");
    expect(svc.listDevices().map((d) => d.kind).sort()).toEqual(["browser", "mobile"]);
  });

  it("forceUnpair clears all or one device by id", () => {
    const svc = new CompanionPairingService({
      engineLabel: "demo",
      engineId: "abc123",
      getBaseUrl: () => "http://127.0.0.1:1",
    });
    const issued = svc.issuePairCode();
    if ("ok" in issued) throw new Error("expected code");
    const browser = svc.pair({
      pairCode: issued.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "browser", name: "Tachyon Companion", version: "0.4.8" },
    });
    expect(browser.ok).toBe(true);
    if (!browser.ok) return;
    const mCode = svc.issuePairCode();
    if ("ok" in mCode) throw new Error("expected code");
    const mobile = svc.pair({
      pairCode: mCode.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "mobile", name: "phone", version: "1" },
    });
    if (!mobile.ok) throw new Error("mobile pair failed");
    const browserId = svc.listDevices().find((d) => d.kind === "browser")!.id;
    const one = svc.forceUnpair(browserId);
    expect(one).toMatchObject({ ok: true, hadSession: true, sessionToken: browser.sessionToken });
    expect(one.sessionTokens).toEqual([browser.sessionToken]);
    expect(svc.hasPairedKind("browser")).toBe(false);
    expect(svc.hasPairedKind("mobile")).toBe(true);

    const cleared = svc.forceUnpair();
    expect(cleared.hadSession).toBe(true);
    expect(cleared.sessionTokens).toEqual([mobile.sessionToken]);
    expect(svc.hasPairedDevice()).toBe(false);
    expect(svc.listDevices()).toEqual([]);
    expect(svc.forceUnpair()).toEqual({ ok: true, hadSession: false, sessionTokens: [] });
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
    // Token-scoped status: revoked token is unknown → error (not bare disconnected).
    expect(svc.status(paired.sessionToken).status).toBe("error");
    expect(svc.status(undefined).status).toBe("disconnected");
  });

  it("reports hasPairedDevice only while a session is live", () => {
    const svc = new CompanionPairingService({
      engineLabel: "demo",
      engineId: "abc123",
      getBaseUrl: () => "http://127.0.0.1:1",
    });
    expect(svc.hasPairedDevice()).toBe(false);
    const issued = svc.issuePairCode();
    if ("ok" in issued) throw new Error("expected code");
    const paired = svc.pair({
      pairCode: issued.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "browser", name: "Tachyon Companion", version: "0.3.4" },
    });
    if (!paired.ok) throw new Error("pair failed");
    expect(svc.hasPairedDevice()).toBe(true);
    expect(svc.unpair(paired.sessionToken)).toEqual({ ok: true });
    expect(svc.hasPairedDevice()).toBe(false);
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
          listApprovals: async () => [
            {
              id: "a-abc123",
              requester: "codex",
              reason: "needs human",
              proposedAction: "delete safety",
              risk: "high",
              exactPrompt: "rm -rf /",
              createdAt: "2026-07-20T00:00:00.000Z",
              status: "pending" as const,
            },
          ],
          resolveApproval: async (id, decision) => ({ ok: true as const, id, status: decision }),
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

    const approvalsRes = await fetch(`${base}/companion/v1/approvals`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(approvalsRes.status).toBe(200);
    const approvalsBody = (await approvalsRes.json()) as {
      ok: true;
      approvals: Array<{ id: string; requester: string }>;
    };
    expect(approvalsBody.ok).toBe(true);
    expect(approvalsBody.approvals[0]?.id).toBe("a-abc123");

    const resolveRes = await fetch(`${base}/companion/v1/approvals/resolve`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "a-abc123", decision: "denied" }),
    });
    expect(resolveRes.status).toBe(200);
    expect(await resolveRes.json()).toMatchObject({ ok: true, id: "a-abc123", status: "denied" });

    const unpairRes = await fetch(`${base}/companion/v1/unpair`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unpairRes.status).toBe(200);

    server.close();
  });

  it("fulfills user tab snapshot via tab.command SSE + POST /tab/result", async () => {
    const { CompanionLiveSync } = await import("@tachyon/engine/companion/CompanionLiveSync.js");
    const { CompanionTabChannel } = await import("@tachyon/engine/companion/CompanionTabChannel.js");
    const pairing = new CompanionPairingService({
      engineLabel: "ws",
      engineId: "hash",
      getBaseUrl: () => `http://127.0.0.1:${port}`,
    });
    let port = 0;
    const live = new CompanionLiveSync({
      statusOf: (token) => pairing.status(token),
      listAgents: async () => [],
      heartbeatMs: 60_000,
      debounceMs: 5,
    });
    const tab = new CompanionTabChannel({
      push: (event, data) => live.pushEvent(event, data),
      defaultTimeoutMs: 5_000,
    });
    const server = http.createServer((req, res) => {
      void handleCompanionHttp(req, res, { pairing, live, tab, ops: {
        listActiveAgents: async () => [],
        sendPrompt: async (agent) => ({ ok: true, status: "notified", agent }),
      }});
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const issued = pairing.issuePairCode();
    if ("ok" in issued) throw new Error("expected code");
    const paired = pairing.pair({
      pairCode: issued.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "browser", name: "t", version: "0" },
    });
    if (!paired.ok) throw new Error("pair failed");
    const token = paired.sessionToken;

    // Open SSE so tab.command can fan out.
    const ac = new AbortController();
    const stream = await fetch(`${base}/companion/v1/events`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: ac.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";

    const waitForCommand = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += dec.decode(value, { stream: true });
        const m = buf.match(/event: tab\.command\ndata: ({[^\n]+})\n/);
        if (m) return JSON.parse(m[1]!) as { id: string; kind: string };
      }
    })();

    // Give the SSE attach a moment to register the client.
    await new Promise((r) => setTimeout(r, 30));

    const toolPromise = tab.requestSnapshot({ tabId: "ctab_test" }, 3_000);
    const cmd = await waitForCommand;
    expect(cmd.kind).toBe("snapshot");
    expect(cmd.id).toBeTruthy();
    expect((cmd as { tabId?: string }).tabId).toBe("ctab_test");

    const post = await fetch(`${base}/companion/v1/tab/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ok: true,
        id: cmd.id,
        kind: "snapshot",
        tabId: "ctab_test",
        documentToken: "doc_1",
        url: "https://example.com/",
        title: "Example",
        capturedAt: new Date().toISOString(),
        outline: "html\n  body\n    h1 \"Example\"",
        refs: [{ ref: "@e1", selector: "h1", tag: "H1" }],
        stats: { nodes: 3, truncated: false, outlineChars: 30 },
      }),
    });
    expect(post.status).toBe(200);
    const result = await toolPromise;
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "snapshot") {
      expect(result.url).toBe("https://example.com/");
      expect(result.outline).toContain("Example");
    }

    ac.abort();
    server.close();
    live.closeAll();
    tab.closeAll();
  });

  it("pushEvent onlyTokens isolates tab.command to browser sessions", async () => {
    const { CompanionLiveSync } = await import("@tachyon/engine/companion/CompanionLiveSync.js");
    const pairing = new CompanionPairingService({
      engineLabel: "ws",
      engineId: "hash",
      getBaseUrl: () => "http://127.0.0.1:1",
    });
    const live = new CompanionLiveSync({
      statusOf: (token) => pairing.status(token),
      listAgents: async () => [],
      heartbeatMs: 60_000,
      debounceMs: 5,
    });
    const server = http.createServer((req, res) => {
      void handleCompanionHttp(req, res, {
        pairing,
        live,
        ops: {
          listActiveAgents: async () => [],
          sendPrompt: async (agent) => ({ ok: true, status: "notified", agent }),
        },
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const bCode = pairing.issuePairCode();
    if ("ok" in bCode) throw new Error("expected code");
    const browser = pairing.pair({
      pairCode: bCode.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "browser", name: "b", version: "0" },
    });
    if (!browser.ok) throw new Error("browser pair failed");
    const mCode = pairing.issuePairCode();
    if ("ok" in mCode) throw new Error("expected code");
    const mobile = pairing.pair({
      pairCode: mCode.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "mobile", name: "m", version: "0" },
    });
    if (!mobile.ok) throw new Error("mobile pair failed");

    const collect = async (token: string, ms: number) => {
      const ac = new AbortController();
      const res = await fetch(`${base}/companion/v1/events`, {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const remaining = end - Date.now();
        if (remaining <= 0) break;
        const read = reader.read();
        const raced = await Promise.race([
          read.then((r) => ({ kind: "chunk" as const, r })),
          new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), remaining)),
        ]);
        if (raced.kind === "timeout") break;
        if (raced.r.done) break;
        buf += dec.decode(raced.r.value, { stream: true });
      }
      ac.abort();
      return buf;
    };

    // Attach both streams, then push tab.command browser-only (Workspace policy).
    const browserBufP = collect(browser.sessionToken, 400);
    const mobileBufP = collect(mobile.sessionToken, 400);
    await new Promise((r) => setTimeout(r, 40));
    live.pushEvent("tab.command", { id: "cmd1", kind: "snapshot" }, pairing.tokensForKind("browser"));
    live.pushEvent("approvals.changed", { n: 1 }); // shared fan-out
    const [browserBuf, mobileBuf] = await Promise.all([browserBufP, mobileBufP]);
    expect(browserBuf).toMatch(/event: tab\.command/);
    expect(mobileBuf).not.toMatch(/event: tab\.command/);
    expect(browserBuf).toMatch(/event: approvals\.changed/);
    expect(mobileBuf).toMatch(/event: approvals\.changed/);

    server.close();
    live.closeAll();
  });

  it("streams live snapshots on GET /companion/v1/events (SSE)", async () => {
    const { CompanionLiveSync } = await import("@tachyon/engine/companion/CompanionLiveSync.js");
    const pairing = new CompanionPairingService({
      engineLabel: "ws",
      engineId: "hash",
      getBaseUrl: () => `http://127.0.0.1:${port}`,
    });
    let agents = [
      { name: "grok", attention: "idle", composerOccupied: false },
    ];
    const live = new CompanionLiveSync({
      statusOf: (token) => pairing.status(token),
      listAgents: async () => agents,
      heartbeatMs: 60_000,
      debounceMs: 10,
    });
    let port = 0;
    const server = http.createServer((req, res) => {
      void handleCompanionHttp(req, res, {
        pairing,
        live,
        ops: {
          listActiveAgents: async () => agents,
          sendPrompt: async (agent) => ({ ok: true, status: "notified", agent }),
        },
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const issued = pairing.issuePairCode();
    if ("ok" in issued) throw new Error("expected code");
    const paired = pairing.pair({
      pairCode: issued.code,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      client: { kind: "browser", name: "t", version: "0" },
    });
    if (!paired.ok) throw new Error("pair failed");
    const token = paired.sessionToken;

    const ac = new AbortController();
    const res = await fetch(`${base}/companion/v1/events`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const first = await (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended before snapshot");
        buf += dec.decode(value, { stream: true });
        const m = buf.match(/event: snapshot\ndata: ({[^\n]+})\n/);
        if (m) return JSON.parse(m[1]!) as { seq: number; agents: Array<{ name: string; attention: string }> };
      }
    })();
    expect(first.agents).toEqual([{ name: "grok", attention: "idle", composerOccupied: false }]);

    agents = [{ name: "grok", attention: "working", composerOccupied: true }];
    live.notifyChanged();
    const second = await (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended before second snapshot");
        buf += dec.decode(value, { stream: true });
        const matches = [...buf.matchAll(/event: snapshot\ndata: ({[^\n]+})\n/g)];
        if (matches.length >= 2) {
          return JSON.parse(matches[matches.length - 1]![1]!) as {
            seq: number;
            agents: Array<{ name: string; attention: string; composerOccupied: boolean }>;
          };
        }
      }
    })();
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(second.agents[0]).toMatchObject({ attention: "working", composerOccupied: true });

    ac.abort();
    server.close();
    live.closeAll();
  });
});
