/**
 * SDD 422 / t-da645b — Companion LAN reachability helpers.
 *
 * Default is loopback-only (browser Companion era). When settings.companion.lanAccess
 * is true, the Bridge listener binds all interfaces so a phone on the LAN can reach
 * /companion/v1. MCP remains on the same port and still requires agent/bridge tokens.
 */

import os from "node:os";

/** Host argument for `server.listen`. */
export function companionListenHost(lanAccess: boolean): "127.0.0.1" | "0.0.0.0" {
  return lanAccess ? "0.0.0.0" : "127.0.0.1";
}

/**
 * Non-internal IPv4 addresses for QR / pair baseUrl candidates.
 * Excludes loopback and link-local (169.254/16).
 */
export function listLanIPv4Addresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const ent of entries) {
      if (ent.family !== "IPv4" && ent.family !== 4) continue;
      if (ent.internal) continue;
      if (ent.address.startsWith("169.254.")) continue;
      if (!out.includes(ent.address)) out.push(ent.address);
    }
  }
  return out;
}

/**
 * Primary base URL advertised for pairing (no path suffix).
 * Loopback when LAN off; first LAN IPv4 when on (fallback loopback if none).
 */
export function companionPairBaseUrl(
  port: number,
  lanAccess: boolean,
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string {
  if (!lanAccess) return `http://127.0.0.1:${port}`;
  const lan = listLanIPv4Addresses(interfaces)[0];
  return `http://${lan ?? "127.0.0.1"}:${port}`;
}

/** All base URLs a phone might use (loopback always first when present on host). */
export function companionPairBaseUrlCandidates(
  port: number,
  lanAccess: boolean,
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string[] {
  const urls = [`http://127.0.0.1:${port}`];
  if (lanAccess) {
    for (const ip of listLanIPv4Addresses(interfaces)) {
      const u = `http://${ip}:${port}`;
      if (!urls.includes(u)) urls.push(u);
    }
  }
  return urls;
}
