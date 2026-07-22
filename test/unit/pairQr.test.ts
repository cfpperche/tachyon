import { describe, expect, it } from "vitest";
import { buildCompanionPairQrPayload, companionPairQrDataUrl } from "../../src/companion/pairQr.js";

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

  it("renders a PNG data URL", async () => {
    const payload = buildCompanionPairQrPayload({
      baseUrl: "http://127.0.0.1:41000",
      pairCode: "TESTCODE",
      protocolVersion: 2,
    });
    const dataUrl = await companionPairQrDataUrl(payload);
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(dataUrl.length).toBeGreaterThan(100);
  });
});
