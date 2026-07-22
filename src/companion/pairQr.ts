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

/** PNG data URL for embedding in Control webview (offline, no CDN). */
export async function companionPairQrDataUrl(qrPayload: string): Promise<string> {
  return QRCode.toDataURL(qrPayload, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 200,
    color: { dark: "#000000", light: "#ffffff" },
  });
}
