import { describe, expect, it } from "vitest";
import { buildCompanionPairQrPayload, companionPairQrDataUrl } from "../../src/companion/pairQr.js";

describe("companion pair QR (SDD 422 / t-0e1f58)", () => {
  it("builds compact JSON payload", () => {
    expect(
      buildCompanionPairQrPayload({
        baseUrl: "http://10.0.0.2:41000/",
        pairCode: "ABCD2345",
        protocolVersion: 2,
      }),
    ).toBe('{"baseUrl":"http://10.0.0.2:41000","pairCode":"ABCD2345","protocolVersion":2}');
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
