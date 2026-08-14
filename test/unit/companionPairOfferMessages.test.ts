import { describe, expect, it } from "vitest";
import {
  companionPairOfferMessage,
  formatCompanionPairClipboard,
  issueCompanionPairCodeAction,
  type CompanionPairOffer,
} from "../../packages/webview-ui/src/webview/shared/control/messages.js";

describe("companion pair offer messages (Control Settings)", () => {
  it("issueCompanionPairCodeAction carries wsHash", () => {
    expect(issueCompanionPairCodeAction("abc12345")).toEqual({
      type: "issueCompanionPairCode",
      wsHash: "abc12345",
    });
  });

  it("formatCompanionPairClipboard matches command palette blob shape", () => {
    const offer: Extract<CompanionPairOffer, { ok: true }> = {
      ok: true,
      code: "A3F9K2",
      baseUrl: "http://127.0.0.1:17321",
      expiresAt: "2026-07-21T14:30:00.000Z",
    };
    expect(formatCompanionPairClipboard(offer)).toBe(
      "code=A3F9K2 baseUrl=http://127.0.0.1:17321 expires=2026-07-21T14:30:00.000Z",
    );
  });

  it("formatCompanionPairClipboard includes openUrl, qrPayload and baseUrls when present", () => {
    const offer: Extract<CompanionPairOffer, { ok: true }> = {
      ok: true,
      code: "A3F9K2",
      baseUrl: "http://10.0.0.2:41000",
      baseUrls: ["http://10.0.0.2:41000", "http://127.0.0.1:41000"],
      expiresAt: "2026-07-21T14:30:00.000Z",
      openUrl: "http://10.0.0.2:41000/companion/app/#pair=%7B%22pairCode%22%3A%22A3F9K2%22%7D",
      qrPayload: '{"baseUrl":"http://10.0.0.2:41000","pairCode":"A3F9K2","protocolVersion":2}',
    };
    const blob = formatCompanionPairClipboard(offer);
    expect(blob).toContain("openUrl=");
    expect(blob).toContain("qrPayload=");
    expect(blob).toContain("baseUrls=");
  });

  it("companionPairOfferMessage wraps success and failure offers", () => {
    const ok = companionPairOfferMessage({
      ok: true,
      code: "X",
      baseUrl: "http://127.0.0.1:1",
      expiresAt: "2026-07-21T00:00:00.000Z",
    });
    expect(ok).toEqual({
      type: "companionPairOffer",
      offer: {
        ok: true,
        code: "X",
        baseUrl: "http://127.0.0.1:1",
        expiresAt: "2026-07-21T00:00:00.000Z",
      },
    });
    const fail = companionPairOfferMessage({ ok: false, reason: "bridge_down" });
    expect(fail).toEqual({
      type: "companionPairOffer",
      offer: { ok: false, reason: "bridge_down" },
    });
  });
});
