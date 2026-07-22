import { describe, expect, it } from "vitest";
import { Bridge, isLoopbackRemote, shouldRejectLanNonCompanion } from "../../src/bridge/Bridge.js";
import type { BridgeDeps } from "../../src/bridge/tools.js";
import {
  companionListenHost,
  companionPairBaseUrl,
  companionPairBaseUrlCandidates,
  listLanIPv4Addresses,
} from "../../src/companion/lanReachability.js";

describe("companion LAN reachability (SDD 422 / t-da645b)", () => {
  it("listens on loopback by default and all-interfaces when lanAccess", () => {
    expect(companionListenHost(false)).toBe("127.0.0.1");
    expect(companionListenHost(true)).toBe("0.0.0.0");
  });

  it("pair baseUrl stays loopback when LAN off", () => {
    expect(companionPairBaseUrl(41234, false)).toBe("http://127.0.0.1:41234");
  });

  it("pair baseUrl prefers first non-internal IPv4 when LAN on", () => {
    const ifaces = {
      eth0: [
        {
          address: "10.0.0.42",
          netmask: "255.255.255.0",
          family: "IPv4" as const,
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "10.0.0.42/24",
        },
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4" as const,
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
    };
    expect(listLanIPv4Addresses(ifaces)).toEqual(["10.0.0.42"]);
    expect(companionPairBaseUrl(41000, true, ifaces)).toBe("http://10.0.0.42:41000");
    expect(companionPairBaseUrlCandidates(41000, true, ifaces)).toEqual([
      "http://127.0.0.1:41000",
      "http://10.0.0.42:41000",
    ]);
  });

  it("skips link-local addresses", () => {
    const ifaces = {
      eth0: [
        {
          address: "169.254.1.2",
          netmask: "255.255.0.0",
          family: "IPv4" as const,
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "169.254.1.2/16",
        },
      ],
    };
    expect(listLanIPv4Addresses(ifaces)).toEqual([]);
    expect(companionPairBaseUrl(41000, true, ifaces)).toBe("http://127.0.0.1:41000");
  });
});

describe("Bridge listen host (SDD 422)", () => {
  it("classifies loopback remotes for LAN route filter", () => {
    expect(isLoopbackRemote("127.0.0.1")).toBe(true);
    expect(isLoopbackRemote("::1")).toBe(true);
    expect(isLoopbackRemote("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemote("10.0.0.5")).toBe(false);
    expect(isLoopbackRemote(undefined)).toBe(false);
  });

  it("rejects non-companion routes for non-loopback peers when LAN-bound", () => {
    expect(shouldRejectLanNonCompanion("0.0.0.0", "10.0.0.9", "/mcp")).toBe(true);
    expect(shouldRejectLanNonCompanion("0.0.0.0", "10.0.0.9", "/other")).toBe(true);
    expect(shouldRejectLanNonCompanion("0.0.0.0", "10.0.0.9", "/companion/v1/health")).toBe(false);
    expect(shouldRejectLanNonCompanion("0.0.0.0", "10.0.0.9", "/companion/v1/pair")).toBe(false);
    // SDD 422 one-QR: engine-served mobile PWA must be LAN-reachable too
    expect(shouldRejectLanNonCompanion("0.0.0.0", "10.0.0.9", "/companion/app/")).toBe(false);
    expect(shouldRejectLanNonCompanion("0.0.0.0", "10.0.0.9", "/companion/app/index.html")).toBe(false);
    expect(shouldRejectLanNonCompanion("0.0.0.0", "10.0.0.9", "/companion/app/app.js")).toBe(false);
    // loopback peer still gets MCP
    expect(shouldRejectLanNonCompanion("0.0.0.0", "127.0.0.1", "/mcp")).toBe(false);
    expect(shouldRejectLanNonCompanion("0.0.0.0", "::ffff:127.0.0.1", "/mcp")).toBe(false);
    // loopback-only listen: no LAN filter
    expect(shouldRejectLanNonCompanion("127.0.0.1", "10.0.0.9", "/mcp")).toBe(false);
    // path boundary
    expect(shouldRejectLanNonCompanion("0.0.0.0", "10.0.0.9", "/companion/v1")).toBe(false);
    expect(shouldRejectLanNonCompanion("0.0.0.0", "10.0.0.9", "/companion/v2/x")).toBe(true);
    expect(shouldRejectLanNonCompanion("0.0.0.0", "10.0.0.9", "/companion/apps/x")).toBe(true);
  });

  it("records 0.0.0.0 when started with lan host; MCP url stays loopback", async () => {
    const deps = {
      workspaceRoot: "/tmp",
      manager: {} as BridgeDeps["manager"],
      tmux: {} as BridgeDeps["tmux"],
    } as BridgeDeps;
    const bridge = new Bridge(deps);
    try {
      await bridge.start(0, { host: "0.0.0.0" });
      expect(bridge.listenHost).toBe("0.0.0.0");
      expect(bridge.port).toBeTypeOf("number");
      expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      // From this host, peer is loopback — MCP is not blocked by the LAN route filter.
      const mcp = await fetch(`http://127.0.0.1:${bridge.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(mcp.status).not.toBe(403);
    } finally {
      await bridge.dispose();
    }
  });
});

