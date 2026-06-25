/**
 * spec 265 — the tool PROVISIONER (security-critical I/O). Download → verify → (archive) → atomic immutable
 * install → smoke-check → host-detect. The highest-trust operation in the plugin system (it fetches AND
 * executes a binary), so every step is fail-closed and bounded.
 *
 * Task 3 (this slice): the secure DOWNLOAD. `node:https` ONLY — reject non-https + redirect downgrades,
 * bound the redirect chain, cap bytes + time, stream to a private temp on the SAME filesystem as the final
 * `.tachyon/bin/` (so the later install is an atomic rename), and clean up on any failure. The redirect-
 * resolved FINAL URL is recorded (the consent↔fetch binding in later tasks rides on it).
 *
 * Tests drive this against a LOCAL self-signed https fixture: the fixture CA is injected ONLY into the test
 * caller via `tlsCa`; production never passes it, so prod keeps strict TLS verification (H11). Adding a CA
 * never disables verification.
 */

import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Generous artifact cap — real CLI tools are MBs; this is a runaway/zip-bomb-source circuit breaker. */
export const MAX_TOOL_ARTIFACT_BYTES = 256 * 1024 * 1024;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_REDIRECTS = 5;

export interface DownloadOpts {
  /** the directory the temp lands in — MUST be on the same filesystem as the final `.tachyon/bin/`. */
  destDir: string;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** TEST-ONLY: an extra trusted CA (PEM). Adding a CA never disables verification; prod passes nothing. */
  tlsCa?: string | Buffer;
}

export interface DownloadResult {
  ok: true;
  /** the downloaded file (in `destDir`) — the caller verifies its sha256 then installs it. */
  tempPath: string;
  bytes: number;
  /** the redirect-resolved final URL actually fetched (recorded for the consent↔fetch binding). */
  finalUrl: string;
}

export type DownloadErrorCode =
  | "BAD_URL"
  | "NON_HTTPS"
  | "REDIRECT_DOWNGRADE"
  | "BAD_REDIRECT"
  | "TOO_MANY_REDIRECTS"
  | "BAD_STATUS"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "READ_ERROR"
  | "WRITE_ERROR"
  | "REQUEST_ERROR";

export interface DownloadError {
  ok: false;
  code: DownloadErrorCode;
  detail: string;
}

export type Download = DownloadResult | DownloadError;

function derr(code: DownloadErrorCode, detail: string): DownloadError {
  return { ok: false, code, detail };
}

/** Is this string an https URL? (the only protocol the provisioner will fetch). */
function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** One hop: GET `url`, follow a 3xx (https-only) or stream a 200 body to a temp file under the caps. */
function fetchOnce(url: string, opts: Required<Omit<DownloadOpts, "tlsCa">> & { tlsCa?: string | Buffer }, redirectsLeft: number): Promise<Download> {
  return new Promise((resolve) => {
    let settled = false;
    let tempPath: string | null = null;
    let out: fs.WriteStream | null = null;
    const done = (r: Download) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const cleanup = () => {
      if (out) out.destroy();
      if (tempPath) fs.rm(tempPath, { force: true }, () => {});
    };
    const fail = (code: DownloadErrorCode, detail: string) => {
      cleanup();
      done(derr(code, detail));
    };

    if (!isHttps(url)) return done(derr("NON_HTTPS", `refusing non-https URL: ${url}`));

    const req = https.get(url, { ca: opts.tlsCa, timeout: opts.timeoutMs }, (res) => {
      const status = res.statusCode ?? 0;

      // redirect: bound the chain, resolve relative, and require the TARGET to be https (no downgrade).
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // drain the redirect body
        if (redirectsLeft <= 0) return done(derr("TOO_MANY_REDIRECTS", `exceeded ${opts.maxRedirects} redirects`));
        let next: string;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch {
          return done(derr("BAD_REDIRECT", `unparseable redirect target: ${res.headers.location}`));
        }
        if (!isHttps(next)) return done(derr("REDIRECT_DOWNGRADE", `refusing redirect to non-https: ${next}`));
        return resolve(fetchOnce(next, opts, redirectsLeft - 1));
      }

      if (status !== 200) {
        res.resume();
        return done(derr("BAD_STATUS", `unexpected HTTP status ${status}`));
      }

      tempPath = path.join(opts.destDir, `.dl-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`);
      out = fs.createWriteStream(tempPath, { mode: 0o600 });
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > opts.maxBytes) fail("TOO_LARGE", `artifact exceeded ${opts.maxBytes} bytes`);
      });
      res.on("error", (e) => fail("READ_ERROR", e instanceof Error ? e.message : String(e)));
      out.on("error", (e) => fail("WRITE_ERROR", e instanceof Error ? e.message : String(e)));
      out.on("finish", () => {
        if (!settled) {
          settled = true;
          resolve({ ok: true, tempPath: tempPath as string, bytes, finalUrl: url });
        }
      });
      res.pipe(out);
    });

    req.on("timeout", () => {
      req.destroy();
      fail("TIMEOUT", `request timed out after ${opts.timeoutMs}ms`);
    });
    req.on("error", (e) => fail("REQUEST_ERROR", e instanceof Error ? e.message : String(e)));
  });
}

/**
 * Download `url` to a private temp file under `opts.destDir`, following bounded https-only redirects.
 * Never throws. The caller verifies the file's sha256 and atomically installs it (task 4).
 */
export async function downloadToTemp(url: string, opts: DownloadOpts): Promise<Download> {
  if (typeof url !== "string" || url.length === 0) return derr("BAD_URL", "empty URL");
  if (!isHttps(url)) return derr("NON_HTTPS", `refusing non-https URL: ${url}`);
  const resolved: Required<Omit<DownloadOpts, "tlsCa">> & { tlsCa?: string | Buffer } = {
    destDir: opts.destDir,
    maxBytes: opts.maxBytes ?? MAX_TOOL_ARTIFACT_BYTES,
    timeoutMs: opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    maxRedirects: opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    tlsCa: opts.tlsCa,
  };
  try {
    fs.mkdirSync(resolved.destDir, { recursive: true });
  } catch (e) {
    return derr("WRITE_ERROR", `cannot create destDir: ${e instanceof Error ? e.message : String(e)}`);
  }
  return fetchOnce(url, resolved, resolved.maxRedirects);
}
