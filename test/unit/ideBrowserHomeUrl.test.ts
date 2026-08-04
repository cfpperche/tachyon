import { describe, expect, it } from "vitest";
import {
  IDE_BROWSER_HOME_URL_FALLBACK,
  normalizeIdeBrowserHomeUrl,
} from "../../src/webview/ide-browser-bridge/homeUrl.js";

describe("normalizeIdeBrowserHomeUrl", () => {
  it("falls back to about:blank when empty", () => {
    expect(normalizeIdeBrowserHomeUrl(undefined)).toBe(IDE_BROWSER_HOME_URL_FALLBACK);
    expect(normalizeIdeBrowserHomeUrl("")).toBe("about:blank");
    expect(normalizeIdeBrowserHomeUrl("   ")).toBe("about:blank");
  });

  it("keeps about:blank", () => {
    expect(normalizeIdeBrowserHomeUrl("about:blank")).toBe("about:blank");
  });

  it("accepts absolute http(s) URLs", () => {
    expect(normalizeIdeBrowserHomeUrl("https://app.local:3000/ui")).toBe("https://app.local:3000/ui");
    expect(normalizeIdeBrowserHomeUrl("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173/");
  });

  it("prefixes bare hosts with https", () => {
    expect(normalizeIdeBrowserHomeUrl("localhost:3000")).toBe("https://localhost:3000/");
    expect(normalizeIdeBrowserHomeUrl("my.app.dev/path")).toBe("https://my.app.dev/path");
  });

  it("rejects non-http schemes", () => {
    expect(normalizeIdeBrowserHomeUrl("file:///tmp/x")).toBe("about:blank");
    expect(normalizeIdeBrowserHomeUrl("javascript:alert(1)")).toBe("about:blank");
  });
});
