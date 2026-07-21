import { describe, expect, it } from "vitest";
import {
  classifyDangerousAction,
  evaluateMutationSafety,
  hostAllowed,
  redactSecrets,
} from "../../src/companion/tabSafety.js";

describe("SDD 420 tabSafety", () => {
  it("classifies delete/buy/submit heuristics", () => {
    expect(classifyDangerousAction({ tool: "user_browser_click", selector: "button.delete" })).toBe("delete");
    expect(classifyDangerousAction({ tool: "user_browser_click", text: "Buy now" })).toBe("buy");
    expect(classifyDangerousAction({ tool: "user_browser_type", submit: true })).toBe("form_submit");
    expect(classifyDangerousAction({ tool: "user_browser_type", text: "hello" })).toBe("none");
  });

  it("allowlist hosts", () => {
    expect(hostAllowed("https://app.example.com/x", ["*.example.com"])).toBe(true);
    expect(hostAllowed("https://evil.test/", ["example.com"])).toBe(false);
    expect(hostAllowed("https://anywhere.test/", undefined)).toBe(true);
    // Missing URL is not a deny (act tools may not know host yet).
    expect(hostAllowed(undefined, ["example.com"])).toBe(true);
  });

  it("needs_confirm for dangerous unconfirmed actions", () => {
    const d = evaluateMutationSafety({
      tool: "user_browser_click",
      selector: "#checkout-buy",
      url: "https://shop.test/cart",
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("needs_confirm");
  });

  it("allows after confirmed", () => {
    const d = evaluateMutationSafety({
      tool: "user_browser_click",
      selector: "#checkout-buy",
      url: "https://shop.test/cart",
      confirmed: true,
    });
    expect(d.allow).toBe(true);
  });

  it("restricts outside allowlist", () => {
    const d = evaluateMutationSafety({
      tool: "user_browser_click",
      selector: "a",
      url: "https://evil.test/",
      allowedHosts: ["good.test"],
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe("restricted");
  });

  it("redacts secrets", () => {
    expect(redactSecrets("password: supersecret Bearer abc.def")).toMatch(/redacted/i);
  });
});
