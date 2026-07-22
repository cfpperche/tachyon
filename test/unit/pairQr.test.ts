import { describe, expect, it } from "vitest";
import {
  buildCompanionMobileOpenUrl,
  buildCompanionPairQrPayload,
  companionPairQrDataUrl,
} from "../../src/companion/pairQr.js";

describe("companion pair QR (SDD 422 / t-0e1f58)", () => {
  it("builds versioned JSON payload with baseUrls", () => {
    const raw = buildCompanionPairQrPayload({
      baseUrl: "http://10.0.0.2:41000/",
      baseUrls: ["http://127.0.0.1:41000", "http://10.0.0.2:41000"],
      pairCode: "ABCD2345",
      protocolVersion: 2,
    });
    expect(JSON.parse(raw)).toEqual({
      type: "tachyon.companion.pair",
      schemaVersion: 1,
      baseUrl: "http://10.0.0.2:41000",
      baseUrls: ["http://10.0.0.2:41000", "http://127.0.0.1:41000"],
      pairCode: "ABCD2345",
      protocolVersion: 2,
    });
  });

  it("builds openUrl deep link for one-QR dogfood (engine-served PWA + hash payload)", () => {
    const payload = buildCompanionPairQrPayload({
      baseUrl: "http://10.0.0.2:41000",
      pairCode: "ABCD2345",
      protocolVersion: 2,
    });
    const openUrl = buildCompanionMobileOpenUrl("http://10.0.0.2:41000/", payload);
    expect(openUrl.startsWith("http://10.0.0.2:41000/companion/app/#pair=")).toBe(true);
    const encoded = openUrl.slice("http://10.0.0.2:41000/companion/app/#pair=".length);
    expect(JSON.parse(decodeURIComponent(encoded))).toMatchObject({
      pairCode: "ABCD2345",
      baseUrl: "http://10.0.0.2:41000",
    });
  });

  it("renders a PNG data URL (openUrl or payload)", async () => {
    const payload = buildCompanionPairQrPayload({
      baseUrl: "http://127.0.0.1:41000",
      pairCode: "TESTCODE",
      protocolVersion: 2,
    });
    const openUrl = buildCompanionMobileOpenUrl("http://127.0.0.1:41000", payload);
    const dataUrl = await companionPairQrDataUrl(openUrl);
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(dataUrl.length).toBeGreaterThan(100);
  });
});
