import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  companionAppFilePath,
  isCompanionAppPath,
  resolveCompanionMobileDist,
  serveCompanionMobileApp,
} from "@tachyon/engine/companion/mobileAppStatic.js";
import { handleCompanionHttp, isCompanionPath } from "@tachyon/engine/companion/CompanionHttp.js";
import { CompanionPairingService } from "@tachyon/engine/companion/CompanionPairingService.js";

describe("companion mobile static serve (SDD 422 one-QR)", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  function makeDist(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-mobile-dist-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>m</title>");
    fs.writeFileSync(path.join(dir, "app.js"), "console.log(1)");
    return dir;
  }

  it("isCompanionAppPath / isCompanionPath cover /companion/app", () => {
    expect(isCompanionAppPath("/companion/app")).toBe(true);
    expect(isCompanionAppPath("/companion/app/")).toBe(true);
    expect(isCompanionAppPath("/companion/app/app.js")).toBe(true);
    expect(isCompanionAppPath("/companion/v1/health")).toBe(false);
    expect(isCompanionPath("/companion/app/app.js")).toBe(true);
    expect(isCompanionPath("/companion/v1/pair")).toBe(true);
  });

  it("maps SPA paths and blocks traversal / encoding tricks", () => {
    const dist = makeDist();
    expect(companionAppFilePath("/companion/app", dist)?.endsWith("index.html")).toBe(true);
    expect(companionAppFilePath("/companion/app/", dist)?.endsWith("index.html")).toBe(true);
    expect(companionAppFilePath("/companion/app/app.js", dist)?.endsWith("app.js")).toBe(true);
    // Traversal
    expect(companionAppFilePath("/companion/app/../secret", dist)).toBeUndefined();
    expect(companionAppFilePath("/companion/app/%2e%2e/secret", dist)).toBeUndefined();
    expect(companionAppFilePath("/companion/app/%2e%2e%2fsecret", dist)).toBeUndefined();
    expect(companionAppFilePath("/companion/app/%252e%252e/secret", dist)).toBeUndefined();
    expect(companionAppFilePath("/companion/app/foo/../../etc/passwd", dist)).toBeUndefined();
    expect(companionAppFilePath("/companion/app/..\\secret", dist)).toBeUndefined();
    // Missing asset → 404 (not SPA HTML spoof)
    expect(companionAppFilePath("/companion/app/missing.js", dist)).toBeUndefined();
    expect(companionAppFilePath("/companion/app/no-such.css", dist)).toBeUndefined();
    // Bare client path → index SPA fallback
    expect(companionAppFilePath("/companion/app/some-route", dist)?.endsWith("index.html")).toBe(true);
  });

  it("resolveCompanionMobileDist finds extension media", () => {
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-ext-"));
    tmpDirs.push(ext);
    const media = path.join(ext, "media", "companion-mobile");
    fs.mkdirSync(media, { recursive: true });
    fs.writeFileSync(path.join(media, "index.html"), "<html></html>");
    expect(resolveCompanionMobileDist({ extensionPath: ext, env: {} })).toBe(media);
  });

  it("serves index + app.js over HTTP via handleCompanionHttp", async () => {
    const dist = makeDist();
    const pairing = new CompanionPairingService({
      engineLabel: "demo",
      engineId: "x",
      getBaseUrl: () => "http://127.0.0.1:1",
    });
    const server = http.createServer((req, res) => {
      void handleCompanionHttp(req, res, { pairing, mobileDistRoot: dist });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const html = await fetch(`http://127.0.0.1:${port}/companion/app/`);
      expect(html.status).toBe(200);
      expect(html.headers.get("content-type")).toMatch(/text\/html/);
      expect(await html.text()).toContain("<!doctype html>");

      const js = await fetch(`http://127.0.0.1:${port}/companion/app/app.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toMatch(/javascript/);
      expect(await js.text()).toBe("console.log(1)");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it("returns 503 when mobile dist is missing", async () => {
    const pairing = new CompanionPairingService({
      engineLabel: "demo",
      engineId: "x",
      getBaseUrl: () => "http://127.0.0.1:1",
    });
    const server = http.createServer((req, res) => {
      void handleCompanionHttp(req, res, { pairing });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/companion/app/`);
      expect(res.status).toBe(503);
      expect(await res.text()).toMatch(/not packaged/i);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it("serveCompanionMobileApp returns false for non-app paths", () => {
    const dist = makeDist();
    const req = { url: "/companion/v1/health", method: "GET" } as http.IncomingMessage;
    const res = { writeHead() {}, end() {} } as unknown as http.ServerResponse;
    expect(serveCompanionMobileApp(req, res, dist)).toBe(false);
  });

  it("rejects POST and 404s missing assets; HEAD has empty body", async () => {
    const dist = makeDist();
    const pairing = new CompanionPairingService({
      engineLabel: "demo",
      engineId: "x",
      getBaseUrl: () => "http://127.0.0.1:1",
    });
    const server = http.createServer((req, res) => {
      void handleCompanionHttp(req, res, { pairing, mobileDistRoot: dist });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const post = await fetch(`http://127.0.0.1:${port}/companion/app/`, { method: "POST" });
      expect(post.status).toBe(405);

      const missing = await fetch(`http://127.0.0.1:${port}/companion/app/nope.js`);
      expect(missing.status).toBe(404);

      const head = await fetch(`http://127.0.0.1:${port}/companion/app/app.js`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await head.text()).toBe("");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});
