import { describe, expect, it } from "vitest";
import {
  classifyDangerousAction,
  evaluateMutationSafety,
  hostAllowed,
  isLikelyFileDownloadUrl,
  redactSecrets,
} from "@tachyon/engine/companion/tabSafety.js";
import { TabRefCache } from "@tachyon/engine/companion/tabRefCache.js";

describe("SDD 420 tabSafety", () => {
  it("classifies delete/buy/submit heuristics", () => {
    expect(classifyDangerousAction({ tool: "user_browser_click", selector: "button.delete" })).toBe("delete");
    expect(classifyDangerousAction({ tool: "user_browser_click", text: "Buy now" })).toBe("buy");
    expect(classifyDangerousAction({ tool: "user_browser_type", submit: true })).toBe("form_submit");
    expect(classifyDangerousAction({ tool: "user_browser_type", text: "hello" })).toBe("none");
  });

  it("classifies delete from resolved @e name/href (t-8f0862)", () => {
    expect(
      classifyDangerousAction({
        tool: "user_browser_click",
        ref: "@e6",
        name: "delete",
        href: "https://the-internet.herokuapp.com/challenging_dom#delete",
      }),
    ).toBe("delete");
    expect(
      evaluateMutationSafety({
        tool: "user_browser_click",
        ref: "@e6",
        name: "delete",
        href: "/challenging_dom#delete",
      }).allow,
    ).toBe(false);
  });

  it("does not treat bare /download path as file download for navigate (t-ca6420)", () => {
    expect(isLikelyFileDownloadUrl("https://the-internet.herokuapp.com/download")).toBe(false);
    expect(isLikelyFileDownloadUrl("https://cdn.example.com/file.zip")).toBe(true);
    expect(
      classifyDangerousAction({
        tool: "user_browser_navigate",
        url: "https://the-internet.herokuapp.com/download",
      }),
    ).toBe("none");
    expect(
      classifyDangerousAction({
        tool: "user_browser_navigate",
        url: "https://cdn.example.com/report.pdf",
      }),
    ).toBe("download");
    expect(classifyDangerousAction({ tool: "user_browser_download" })).toBe("download");
  });

  it("allowlist hosts", () => {
    expect(hostAllowed("https://app.example.com/x", ["*.example.com"])).toBe(true);
    expect(hostAllowed("https://evil.test/", ["example.com"])).toBe(false);
    expect(hostAllowed("https://anywhere.test/", undefined)).toBe(true);
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

describe("TabRefCache", () => {
  it("stores and looks up snapshot refs", () => {
    const c = new TabRefCache();
    c.putFromSnapshot("ctab_x", [
      { ref: "@e6", name: "delete", href: "https://x.test/#delete", selector: "a#del" },
    ]);
    expect(c.lookup("ctab_x", "@e6")?.name).toBe("delete");
    expect(c.hintsFor("ctab_x", "@e6").href).toContain("delete");
    expect(c.lookup("ctab_x", "@e9")).toBeUndefined();
  });
});
