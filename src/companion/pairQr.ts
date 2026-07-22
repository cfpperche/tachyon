/**
 * SDD 422 — pair QR payload + PNG data URL for Control.
 */

import QRCode from "qrcode";

/** Build the exact JSON a phone companion should scan/parse. */
export function buildCompanionPairQrPayload(input: {
  baseUrl: string;
  pairCode: string;
  protocolVersion: number;
}): string {
  return JSON.stringify({
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
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
