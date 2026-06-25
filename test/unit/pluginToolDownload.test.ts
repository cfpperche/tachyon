import { describe, it, expect, beforeAll, afterAll } from "vitest";
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { downloadToTemp } from "../../src/plugins/toolProvisioning.js";
import { tlsKeypair } from "../helpers/tlsFixture.js";

const kp = tlsKeypair();

/** A configurable https fixture: routes are handler fns keyed by pathname. */
type Routes = Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>;

describe.skipIf(!kp)("downloadToTemp (https fixture)", () => {
  let server: https.Server;
  let base: string;
  let dest: string;
  const PAYLOAD = Buffer.from("the-tool-binary-bytes\n".repeat(64));

  const routes: Routes = {
    "/tool.bin": (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(PAYLOAD);
    },
    "/redirect-once": (_req, res) => {
      res.writeHead(302, { location: "/tool.bin" });
      res.end();
    },
    "/redirect-loop": (_req, res) => {
      res.writeHead(302, { location: "/redirect-loop" });
      res.end();
    },
    "/downgrade": (_req, res) => {
      res.writeHead(302, { location: "http://example.com/evil" });
      res.end();
    },
    "/huge": (_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(1024 * 1024, 7)); // 1 MiB
    },
    "/notfound": (_req, res) => {
      res.writeHead(404);
      res.end();
    },
  };

  beforeAll(async () => {
    server = https.createServer({ key: kp!.key, cert: kp!.cert }, (req, res) => {
      const route = routes[new URL(req.url ?? "/", base).pathname];
      if (route) return route(req, res);
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    base = `https://127.0.0.1:${addr.port}`;
    dest = fs.mkdtempSync(path.join(os.tmpdir(), "tach-dl-"));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dest, { recursive: true, force: true });
  });

  const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

  it("downloads a 200 body to a temp file under destDir", async () => {
    const r = await downloadToTemp(`${base}/tool.bin`, { destDir: dest, tlsCa: kp!.cert });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytes).toBe(PAYLOAD.length);
      expect(path.dirname(r.tempPath)).toBe(dest);
      expect(sha(fs.readFileSync(r.tempPath))).toBe(sha(PAYLOAD));
      expect(r.finalUrl).toBe(`${base}/tool.bin`);
    }
  });

  it("follows a bounded redirect and records the FINAL url", async () => {
    const r = await downloadToTemp(`${base}/redirect-once`, { destDir: dest, tlsCa: kp!.cert });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.finalUrl).toBe(`${base}/tool.bin`);
  });

  it("rejects a non-https initial URL (NON_HTTPS) without a request", async () => {
    const r = await downloadToTemp("http://127.0.0.1/tool.bin", { destDir: dest, tlsCa: kp!.cert });
    expect(r).toMatchObject({ ok: false, code: "NON_HTTPS" });
  });

  it("rejects a redirect that downgrades to http (REDIRECT_DOWNGRADE)", async () => {
    const r = await downloadToTemp(`${base}/downgrade`, { destDir: dest, tlsCa: kp!.cert });
    expect(r).toMatchObject({ ok: false, code: "REDIRECT_DOWNGRADE" });
  });

  it("bounds the redirect chain (TOO_MANY_REDIRECTS)", async () => {
    const r = await downloadToTemp(`${base}/redirect-loop`, { destDir: dest, maxRedirects: 3, tlsCa: kp!.cert });
    expect(r).toMatchObject({ ok: false, code: "TOO_MANY_REDIRECTS" });
  });

  it("enforces the byte cap (TOO_LARGE) and cleans up its OWN temp", async () => {
    // successful downloads intentionally leave their temp for the caller to install; assert only that the
    // FAILED (over-cap) download adds no net temp file of its own.
    const tmps = () => fs.readdirSync(dest).filter((f) => f.startsWith(".dl-") && f.endsWith(".tmp")).length;
    const before = tmps();
    const r = await downloadToTemp(`${base}/huge`, { destDir: dest, maxBytes: 4096, tlsCa: kp!.cert });
    expect(r).toMatchObject({ ok: false, code: "TOO_LARGE" });
    await new Promise((res) => setTimeout(res, 50)); // allow the async unlink
    expect(tmps()).toBe(before);
  });

  it("surfaces a non-200 status (BAD_STATUS)", async () => {
    const r = await downloadToTemp(`${base}/notfound`, { destDir: dest, tlsCa: kp!.cert });
    expect(r).toMatchObject({ ok: false, code: "BAD_STATUS" });
  });

  it("PRODUCTION rejects the self-signed cert when no CA is injected (strict TLS / H11)", async () => {
    const r = await downloadToTemp(`${base}/tool.bin`, { destDir: dest }); // no tlsCa
    expect(r).toMatchObject({ ok: false, code: "REQUEST_ERROR" });
  });
});
