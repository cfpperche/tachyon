/**
 * SDD 422 — pair QR payload + PNG data URL for Control.
 *
 * Wire schema (stable for mobile scanners):
 * {
 *   "type": "tachyon.companion.pair",
 *   "schemaVersion": 1,
 *   "baseUrl": string,           // primary
 *   "baseUrls": string[],        // ordered candidates (primary first), max 8
 *   "pairCode": string,
 *   "protocolVersion": number
 * }
 */

import QRCode from "qrcode";

export const COMPANION_PAIR_QR_TYPE = "tachyon.companion.pair" as const;
export const COMPANION_PAIR_QR_SCHEMA_VERSION = 1 as const;
const MAX_BASE_URLS = 8;

/** Build the exact JSON a phone companion should scan/parse. */
export function buildCompanionPairQrPayload(input: {
  baseUrl: string;
  baseUrls?: string[];
  pairCode: string;
  protocolVersion: number;
}): string {
  const primary = input.baseUrl.replace(/\/+$/, "");
  const candidates = (input.baseUrls?.length ? input.baseUrls : [primary])
    .map((u) => u.replace(/\/+$/, ""))
    .filter(Boolean);
  const ordered = [primary, ...candidates.filter((u) => u !== primary)].slice(0, MAX_BASE_URLS);
  return JSON.stringify({
    type: COMPANION_PAIR_QR_TYPE,
    schemaVersion: COMPANION_PAIR_QR_SCHEMA_VERSION,
    baseUrl: primary,
    baseUrls: ordered,
    pairCode: input.pairCode,
    protocolVersion: input.protocolVersion,
  });
}

/**
 * Deep link: phone camera opens the engine-served PWA and auto-pairs.
 * Hash carries the JSON payload (not query) to reduce server access-log leakage.
 */
export function buildCompanionMobileOpenUrl(engineBaseUrl: string, qrPayload: string): string {
  const base = engineBaseUrl.replace(/\/+$/, "");
  return `${base}/companion/app/#pair=${encodeURIComponent(qrPayload)}`;
}

/**
 * PNG data URL for Control. Prefer encoding `openUrl` (scan → browser)
 * over raw JSON (scan → needs a payload-aware app).
 */
export async function companionPairQrDataUrl(content: string): Promise<string> {
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 240,
    color: { dark: "#000000", light: "#ffffff" },
  });
}
