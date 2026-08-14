/**
 * t-47503a / AR-04 — shared versioned route map + decoders for engine↔host HTTP.
 * Fail-before would be free-form strings and untyped body parsing on each side.
 */
import { describe, expect, it } from "vitest";
import {
  IDE_BROWSER_HTTP_PROTOCOL_VERSION,
  IDE_BROWSER_ROUTES,
  IDE_BROWSER_ROUTE_TABLE,
  decodeIdeBrowserHttpRequest,
  isIdeBrowserRoutePath,
  normalizeIdeBrowserRoutePath,
} from "@tachyon/engine/ide-browser/protocol.js";

describe("ide-browser HTTP protocol (t-47503a)", () => {
  it("pins a protocol version and a complete route table", () => {
    expect(IDE_BROWSER_HTTP_PROTOCOL_VERSION).toBe(1);
    const paths = Object.values(IDE_BROWSER_ROUTES);
    expect(paths).toEqual(expect.arrayContaining([
      "/status",
      "/navigate",
      "/eval",
      "/screenshot",
      "/snapshot",
      "/url",
      "/click",
    ]));
    expect(Object.keys(IDE_BROWSER_ROUTE_TABLE).sort()).toEqual([...paths].sort());
  });

  it("decodes known GET routes without a body", () => {
    for (const path of [
      IDE_BROWSER_ROUTES.status,
      IDE_BROWSER_ROUTES.screenshot,
      IDE_BROWSER_ROUTES.snapshot,
      IDE_BROWSER_ROUTES.url,
    ] as const) {
      const decoded = decodeIdeBrowserHttpRequest("GET", path);
      expect(decoded).toEqual({ ok: true, path, body: undefined });
    }
  });

  it("requires navigate url / eval expression / click selector (historical errors)", () => {
    expect(decodeIdeBrowserHttpRequest("POST", "/navigate", {})).toEqual({
      ok: false,
      status: 400,
      error: "url required",
    });
    expect(decodeIdeBrowserHttpRequest("POST", "/eval", { expression: "" })).toEqual({
      ok: false,
      status: 400,
      error: "expression required",
    });
    expect(decodeIdeBrowserHttpRequest("POST", "/click", {})).toEqual({
      ok: false,
      status: 400,
      error: "selector required",
    });
  });

  it("decodes valid mutation bodies", () => {
    expect(decodeIdeBrowserHttpRequest("POST", "/navigate", { url: "https://x.test" })).toEqual({
      ok: true,
      path: "/navigate",
      body: { url: "https://x.test" },
    });
    expect(decodeIdeBrowserHttpRequest("POST", "/eval", { expression: "1+1" })).toEqual({
      ok: true,
      path: "/eval",
      body: { expression: "1+1" },
    });
    expect(decodeIdeBrowserHttpRequest("POST", "/click", { selector: "#go" })).toEqual({
      ok: true,
      path: "/click",
      body: { selector: "#go" },
    });
  });

  it("enforces the MCP eval expression ceiling at the HTTP decode door", () => {
    expect(decodeIdeBrowserHttpRequest("POST", "/eval", { expression: "x".repeat(50_000) })).toMatchObject({
      ok: true,
    });
    expect(decodeIdeBrowserHttpRequest("POST", "/eval", { expression: "x".repeat(50_001) })).toEqual({
      ok: false,
      status: 400,
      error: "expression must be at most 50000 characters",
    });
  });

  it("keeps the historical unknown-route message (pathname only)", () => {
    expect(decodeIdeBrowserHttpRequest("GET", "/nope")).toEqual({
      ok: false,
      status: 404,
      error: "unknown route /nope",
    });
    // Method mismatch is also unknown (not a separate 405).
    expect(decodeIdeBrowserHttpRequest("POST", "/status")).toEqual({
      ok: false,
      status: 404,
      error: "unknown route /status",
    });
  });

  it("normalizes and recognizes route paths", () => {
    expect(normalizeIdeBrowserRoutePath("status")).toBe("/status");
    expect(normalizeIdeBrowserRoutePath("/status")).toBe("/status");
    expect(isIdeBrowserRoutePath("/navigate")).toBe(true);
    expect(isIdeBrowserRoutePath("/missing")).toBe(false);
  });
});
