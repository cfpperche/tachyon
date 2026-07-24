import { describe, expect, it } from "vitest";
import { Bridge, isLoopbackRemote, shouldRejectLanNonCompanion } from "../../src/bridge/Bridge.js";
import type { BridgeDeps } from "../../src/bridge/tools.js";
import {
  companionListenHost,
  companionPairBaseUrl,
  companionPairBaseUrlCandidates,
  isTailscaleIPv4,
  listTailscaleIPv4Addresses,
  resolveTailscaleIPv4,
} from "../../src/companion/lanReachability.js";

describe("companion Tailscale reachability (SDD 422)", () => {
  it("listens on loopback by default and all-interfaces when mobile on", () => {
    expect(companionListenHost(false)).toBe("127.0.0.1");
    expect(companionListenHost(true)).toBe("0.0.0.0");
  });

  it("recognizes Tailscale CGNAT addresses", () => {
    expect(isTailscaleIPv4("100.64.0.1")).toBe(true);
    expect(isTailscaleIPv4("100.100.50.2")).toBe(true);
    expect(isTailscaleIPv4("100.127.255.255")).toBe(true);
    expect(isTailscaleIPv4("100.63.0.1")).toBe(false);
    expect(isTailscaleIPv4("192.168.1.1")).toBe(false);
    expect(isTailscaleIPv4("10.0.0.1")).toBe(false);
  });

  it("pair baseUrl stays loopback when mobile off", () => {
    expect(companionPairBaseUrl(41234, false)).toBe("http://127.0.0.1:41234");
  });

  it("pair baseUrl uses Tailscale IP when mobile on (not eth0 LAN)", () => {
    const ifaces = {
      eth0: [
        {
          address: "192.168.15.28",
          netmask: "255.255.255.0",
          family: "IPv4" as const,
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "192.168.15.28/24",
        },
      ],
      tailscale0: [
        {
          address: "100.101.102.103",
          netmask: "255.255.255.255",
          family: "IPv4" as const,
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "100.101.102.103/32",
        },
      ],
      "br-docker": [
        {
          address: "172.17.0.1",
          netmask: "255.255.0.0",
          family: "IPv4" as const,
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "172.17.0.1/16",
        },
      ],
    };
    expect(listTailscaleIPv4Addresses(ifaces)).toEqual(["100.101.102.103"]);
    expect(companionPairBaseUrl(41000, true, { interfaces: ifaces })).toBe(
      "http://100.101.102.103:41000",
    );
    expect(companionPairBaseUrlCandidates(41000, true, { interfaces: ifaces })).toEqual([
      "http://100.101.102.103:41000",
    ]);
  });

  it("pair baseUrl is undefined when mobile on but Tailscale missing", () => {
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
      ],
    };
    expect(resolveTailscaleIPv4({ interfaces: ifaces })).toBeUndefined();
    expect(companionPairBaseUrl(41000, true, { interfaces: ifaces })).toBeUndefined();
    expect(companionPairBaseUrlCandidates(41000, true, { interfaces: ifaces })).toEqual([]);
  });

  it("accepts CGNAT IP on any interface name", () => {
    const ifaces = {
      "weird-if": [
        {
          address: "100.86.1.2",
          netmask: "255.255.255.255",
          family: "IPv4" as const,
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "100.86.1.2/32",
        },
      ],
    };
    expect(listTailscaleIPv4Addresses(ifaces)).toEqual(["100.86.1.2"]);
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

  it("rejects non-companion routes for non-loopback peers when mesh-bound", () => {
    expect(shouldRejectLanNonCompanion("0.0.0.0", "10.0.0.9", "/mcp")).toBe(true);
    expect(shouldRejectLanNonCompanion("0.0.0.0", "100.64.1.2", "/companion/v1/health")).toBe(false);
    expect(shouldRejectLanNonCompanion("0.0.0.0", "100.64.1.2", "/companion/app/")).toBe(false);
    expect(shouldRejectLanNonCompanion("0.0.0.0", "127.0.0.1", "/mcp")).toBe(false);
    expect(shouldRejectLanNonCompanion("127.0.0.1", "10.0.0.9", "/mcp")).toBe(false);
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
