import { describe, it, expect, beforeAll, afterAll } from "vitest";
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { downloadToTemp } from "../../apps/vscode-extension/src/plugins/toolProvisioning.js";
import { tlsKeypair } from "../helpers/tlsFixture.js";

const kp = tlsKeypair();

/** A configurable https fixture: routes are handler fns keyed by pathname. */
type Routes = Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>;

describe.skipIf(!kp)("downloadToTemp (https fixture)", () => {
  let server: https.Server;
  let base: string;
  let dest: string;
  const PAYLOAD = Buffer.from("the-tool-binary-bytes\n".repeat(64));

  // spec 287 — a body big enough to span several data chunks, WITH a Content-Length.
  const BIG = Buffer.alloc(5 * (1 << 20), 9); // 5 MiB
  const routes: Routes = {
    "/tool.bin": (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(PAYLOAD);
    },
    "/big.bin": (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(BIG.length) });
      res.end(BIG);
    },
    "/big-nolen.bin": (_req, res) => {
      // chunked (no Content-Length) — total is unknowable to the client.
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(BIG);
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

  // spec 287 — best-effort download progress.
  it("emits onProgress with a known total (Content-Length) and a monotonic, final-complete byte count", async () => {
    const events: { downloadedBytes: number; totalBytes: number | null }[] = [];
    const r = await downloadToTemp(`${base}/big.bin`, { destDir: dest, tlsCa: kp!.cert, onProgress: (p) => events.push(p) });
    expect(r.ok).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    // every event carries the real total...
    expect(events.every((e) => e.totalBytes === BIG.length)).toBe(true);
    // ...the count never goes backwards...
    for (let i = 1; i < events.length; i++) expect(events[i].downloadedBytes).toBeGreaterThanOrEqual(events[i - 1].downloadedBytes);
    // ...and the FINAL event reports the whole body (the finish emit is forced).
    expect(events[events.length - 1].downloadedBytes).toBe(BIG.length);
    // throttled: nowhere near one event per chunk (a 5 MiB body streams in many small chunks).
    expect(events.length).toBeLessThan(64);
  });

  it("emits the full-byte terminal event EXACTLY once (no forced-final duplicate) — codex LOW", async () => {
    const events: { downloadedBytes: number; totalBytes: number | null }[] = [];
    const r = await downloadToTemp(`${base}/big.bin`, { destDir: dest, tlsCa: kp!.cert, onProgress: (p) => events.push(p) });
    expect(r.ok).toBe(true);
    const full = events.filter((e) => e.downloadedBytes === BIG.length);
    expect(full.length).toBe(1);
    // and no two consecutive events ever report the same byte count.
    for (let i = 1; i < events.length; i++) expect(events[i].downloadedBytes).not.toBe(events[i - 1].downloadedBytes);
  });

  it("emits onProgress with totalBytes=null when there is no Content-Length", async () => {
    const events: { downloadedBytes: number; totalBytes: number | null }[] = [];
    const r = await downloadToTemp(`${base}/big-nolen.bin`, { destDir: dest, tlsCa: kp!.cert, onProgress: (p) => events.push(p) });
    expect(r.ok).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.totalBytes === null)).toBe(true);
    expect(events[events.length - 1].downloadedBytes).toBe(BIG.length);
  });

  it("a throwing onProgress callback never fails the download (best-effort)", async () => {
    const r = await downloadToTemp(`${base}/big.bin`, { destDir: dest, tlsCa: kp!.cert, onProgress: () => { throw new Error("UI exploded"); } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes).toBe(BIG.length);
  });
});
