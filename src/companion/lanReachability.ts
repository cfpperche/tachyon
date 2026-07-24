/**
 * SDD 422 — Companion mobile reachability (Tailscale-only for phone).
 *
 * Product path (mobile):
 *   settings.companion.lanAccess: true  → Bridge binds 0.0.0.0; pair/openUrl use Tailscale IP only.
 *   Phone + PC must be on the same Tailnet (app once). No multi-NIC Wi‑Fi candidate list.
 *
 * Same-host (browser Companion / loopback):
 *   lanAccess false → 127.0.0.1 only.
 *
 * `lanAccess` name is historical; semantics are "mobile Companion enabled (via Tailscale)".
 * Self-hosted Headscale later: same Tailscale client, different login-server — no second pair path.
 *
 * Detection is pure OS interface enumeration (no sync child_process — cx wedge / event-loop policy).
 * Operator recovery still uses `tailscale ip -4` manually (doctor copy); we do not shell out here.
 */

import os from "node:os";

/** Host argument for `server.listen`. */
export function companionListenHost(mobileEnabled: boolean): "127.0.0.1" | "0.0.0.0" {
  return mobileEnabled ? "0.0.0.0" : "127.0.0.1";
}

/** Tailscale CGNAT range 100.64.0.0/10 (stable node addresses on a tailnet). */
export function isTailscaleIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Tailscale IPv4 from OS interfaces (name hint and/or CGNAT range).
 * Pure — inject `interfaces` in tests.
 */
export function listTailscaleIPv4Addresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries) continue;
    const nameHint = /tailscale|ts-\d/i.test(name);
    for (const ent of entries) {
      if (ent.family !== "IPv4" && (ent.family as string | number) !== 4) continue;
      if (ent.internal) continue;
      if (ent.address.startsWith("169.254.")) continue;
      if (nameHint || isTailscaleIPv4(ent.address)) {
        if (!out.includes(ent.address)) out.push(ent.address);
      }
    }
  }
  // Prefer classic CGNAT addresses first if mixed
  out.sort((a, b) => Number(isTailscaleIPv4(b)) - Number(isTailscaleIPv4(a)));
  return out;
}

/**
 * Resolve Tailscale IPv4 for mobile pair URLs.
 * Order: injected override → OS interfaces. No CLI shell-out (event-loop policy).
 */
export function resolveTailscaleIPv4(opts?: {
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** Test inject: force a specific IP (empty string → undefined). */
  cliIp?: string | null;
}): string | undefined {
  if (opts?.cliIp !== undefined && opts.cliIp !== null) {
    return opts.cliIp || undefined;
  }
  if (opts?.cliIp === null) return undefined;
  return listTailscaleIPv4Addresses(opts?.interfaces)[0];
}

/**
 * Primary base URL for pairing (no path).
 * - mobile off → loopback
 * - mobile on → Tailscale IP only; undefined if Tailscale not detected
 */
export function companionPairBaseUrl(
  port: number,
  mobileEnabled: boolean,
  opts?: {
    interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    cliIp?: string | null;
  },
): string | undefined {
  if (!mobileEnabled) return `http://127.0.0.1:${port}`;
  const ts = resolveTailscaleIPv4(opts);
  if (!ts) return undefined;
  return `http://${ts}:${port}`;
}

/**
 * Pair URL candidates for Control / QR payload.
 * Mobile: single Tailscale URL (or empty if undetected).
 * Loopback mode: only 127.0.0.1.
 */
export function companionPairBaseUrlCandidates(
  port: number,
  mobileEnabled: boolean,
  opts?: {
    interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    cliIp?: string | null;
  },
): string[] {
  const primary = companionPairBaseUrl(port, mobileEnabled, opts);
  return primary ? [primary] : [];
}

/** @deprecated Wi‑Fi multi-NIC listing removed from product path; kept for unit migration tests. */
export function listLanIPv4Addresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const ent of entries) {
      if (ent.family !== "IPv4" && (ent.family as string | number) !== 4) continue;
      if (ent.internal) continue;
      if (ent.address.startsWith("169.254.")) continue;
      // Exclude Tailscale CGNAT and common docker bridges from "LAN" leftovers
      if (isTailscaleIPv4(ent.address)) continue;
      if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ent.address)) continue;
      if (!out.includes(ent.address)) out.push(ent.address);
    }
  }
  return out;
}
