import { describe, expect, it } from "vitest";
import {
  companionPairOfferMessage,
  formatCompanionPairClipboard,
  issueCompanionPairCodeAction,
  type CompanionPairOffer,
} from "../../src/webview/cockpit/messages.js";

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
