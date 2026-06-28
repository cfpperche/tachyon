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
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import * as tarStream from "tar-stream";

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

// ───────────────────────── task 4 — verify + atomic immutable install ─────────────────────────

/** sha256 of a file's bytes (hex). Throws only if the file is unreadable (caller guards). */
export function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export type VerifyErrorCode = "UNREADABLE" | "SHA_MISMATCH";
export type Verify = { ok: true; sha256: string } | { ok: false; code: VerifyErrorCode; detail: string };

/** Verify a downloaded artifact's bytes against the manifest-pinned sha256. Fail-closed on any mismatch. */
export function verifyArtifact(tempPath: string, expectedSha256: string): Verify {
  let actual: string;
  try {
    actual = sha256File(tempPath);
  } catch (e) {
    return { ok: false, code: "UNREADABLE", detail: e instanceof Error ? e.message : String(e) };
  }
  if (actual !== expectedSha256) return { ok: false, code: "SHA_MISMATCH", detail: `expected ${expectedSha256}, got ${actual}` };
  return { ok: true, sha256: actual };
}

export interface InstallOpts {
  /** the root content-addressed store (e.g. `<workspace>/.tachyon/bin`). */
  binDir: string;
  /** the tool's logical name (the first path segment). */
  name: string;
  /** the on-disk executable filename (the leaf). */
  exeName: string;
  /** the EXECUTABLE bytes' sha256 — the install identity (== artifact sha for a raw binary; the extracted
   *  file's sha for an archive). The content-addressed path encodes THIS. */
  binSha256: string;
}

export type InstallErrorCode = "BIN_SHA_MISMATCH" | "INSTALL_COLLISION" | "INSTALL_EXISTS" | "OWNER_MISMATCH" | "NLINK" | "REHASH_MISMATCH" | "IO_ERROR";
export type Install =
  | { ok: true; installPath: string; binSha256: string; reused: boolean }
  | { ok: false; code: InstallErrorCode; detail: string };

function ierr(code: InstallErrorCode, detail: string): Install {
  return { ok: false, code, detail };
}

/**
 * Atomically install a verified executable into the immutable content-addressed store
 * `<binDir>/<name>/<binSha256>/<exeName>` (task-0 D8). Idempotent: an already-present, hash-matching copy
 * is reused. Fail-closed: re-hash the source first, create via `O_EXCL` (no overwrite) under `0700` parents
 * at mode `0500`, assert owner==uid and link-count==1, then RE-HASH the placed file before returning.
 */
export function installExecutable(srcPath: string, opts: InstallOpts): Install {
  let srcHash: string;
  try {
    srcHash = sha256File(srcPath);
  } catch (e) {
    return ierr("IO_ERROR", `unreadable source: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (srcHash !== opts.binSha256) return ierr("BIN_SHA_MISMATCH", `source hash ${srcHash} != expected ${opts.binSha256}`);

  const dir = path.join(opts.binDir, opts.name, opts.binSha256);
  const installPath = path.join(dir, opts.exeName);

  // idempotent reuse: an existing content-addressed copy must still hash-match, else fail closed (corruption).
  if (fs.existsSync(installPath)) {
    let existing: string;
    try {
      existing = sha256File(installPath);
    } catch (e) {
      return ierr("IO_ERROR", `unreadable existing install: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (existing === opts.binSha256) return { ok: true, installPath, binSha256: opts.binSha256, reused: true };
    return ierr("INSTALL_COLLISION", `${installPath} exists with a different hash (${existing})`);
  }

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return ierr("IO_ERROR", `cannot create install dir: ${e instanceof Error ? e.message : String(e)}`);
  }

  const data = fs.readFileSync(srcPath);
  let fd: number;
  try {
    // O_EXCL: refuse to overwrite — a pre-existing path here is a collision we must not clobber.
    fd = fs.openSync(installPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  } catch {
    return ierr("INSTALL_EXISTS", `${installPath} already exists (no-overwrite)`);
  }
  try {
    fs.writeSync(fd, data);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(installPath, { force: true });
    return ierr("IO_ERROR", `write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  fs.closeSync(fd);
  fs.chmodSync(installPath, 0o500); // r-x, no write: the store is immutable

  const st = fs.statSync(installPath);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    fs.rmSync(installPath, { force: true });
    return ierr("OWNER_MISMATCH", `installed file owner ${st.uid} != running uid ${uid}`);
  }
  if (st.nlink !== 1) {
    fs.rmSync(installPath, { force: true });
    return ierr("NLINK", `installed file has link-count ${st.nlink} (expected 1)`);
  }

  // re-hash the PLACED file (defense against a swap between write and now).
  const placed = sha256File(installPath);
  if (placed !== opts.binSha256) {
    fs.rmSync(installPath, { force: true });
    return ierr("REHASH_MISMATCH", `placed file hash ${placed} != expected ${opts.binSha256}`);
  }
  return { ok: true, installPath, binSha256: opts.binSha256, reused: false };
}

// ───────────────────────── spec 284 — DATA artifact install (non-executable, streamed) ─────────────────────────

/** Generous DATA cap — model weights run 100s of MB; this is the runaway/zip-bomb circuit breaker, not a size policy. */
export const MAX_DATA_ARTIFACT_BYTES = 1024 * 1024 * 1024; // 1 GiB

/** sha256 of a file's bytes (hex), STREAMED in bounded chunks — the data sibling of `sha256File`, which reads the
 *  whole blob into memory (fine for small CLIs, wrong for a 140 MB-1 GiB model). Sync; throws if unreadable. */
export function sha256FileStreaming(p: string): string {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20); // 1 MiB chunks
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

export interface InstallDataOpts {
  /** the content-addressed DATA store root (e.g. `<workspace>/.tachyon/data/sha256`). */
  dataDir: string;
  /** the data file's sha256 — the content-address identity (the path encodes THIS, sha-first per dueto D1). */
  sha256: string;
  /** the on-disk leaf filename. */
  fileName: string;
}

export type InstallData =
  | { ok: true; installPath: string; sha256: string; reused: boolean }
  | { ok: false; code: InstallErrorCode; detail: string };

function dierr(code: InstallErrorCode, detail: string): InstallData {
  return { ok: false, code, detail };
}

/**
 * spec 284 — atomically install a verified DATA file into the immutable, sha256-FIRST content-addressed store
 * `<dataDir>/<sha256>/<fileName>`. The non-executable sibling of `installExecutable`: STREAMED (kernel-level
 * `copyFileSync` + chunked hash — never a whole-blob Buffer), installed mode `0o400` (read-only, NO exec bit, NO
 * smoke-check). Idempotent: an already-present, hash-matching copy is reused. Fail-closed throughout.
 */
export function installData(srcPath: string, opts: InstallDataOpts): InstallData {
  let srcHash: string;
  try {
    srcHash = sha256FileStreaming(srcPath);
  } catch (e) {
    return dierr("IO_ERROR", `unreadable source: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (srcHash !== opts.sha256) return dierr("BIN_SHA_MISMATCH", `source hash ${srcHash} != expected ${opts.sha256}`);

  const dir = path.join(opts.dataDir, opts.sha256);
  const installPath = path.join(dir, opts.fileName);

  // idempotent reuse: an existing content-addressed copy must still hash-match AND satisfy the read-only data
  // invariants (codex MEDIUM — a pre-existing blob with a bad mode/owner/nlink would `reuse:true` then fail the
  // resolver later). Re-assert them; repair a safe-but-wrong mode to 0o400, else fail closed.
  if (fs.existsSync(installPath)) {
    let existing: string;
    try {
      existing = sha256FileStreaming(installPath);
    } catch (e) {
      return dierr("IO_ERROR", `unreadable existing install: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (existing !== opts.sha256) return dierr("INSTALL_COLLISION", `${installPath} exists with a different hash (${existing})`);
    const est = fs.statSync(installPath);
    const euid = process.getuid?.();
    if (!est.isFile()) return dierr("IO_ERROR", `existing install ${installPath} is not a regular file`);
    if (euid !== undefined && est.uid !== euid) return dierr("OWNER_MISMATCH", `existing install owner ${est.uid} != running uid ${euid}`);
    if (est.nlink !== 1) return dierr("NLINK", `existing install has link-count ${est.nlink} (expected 1)`);
    if ((est.mode & 0o777) !== 0o400) {
      // group/other-writable is unsafe — fail closed; a benign mode delta (e.g. exec bit, 0o444) is repaired to 0o400.
      if (est.mode & 0o022) return dierr("OWNER_MISMATCH", `existing install ${installPath} is group/other writable`);
      fs.chmodSync(installPath, 0o400);
    }
    return { ok: true, installPath, sha256: opts.sha256, reused: true };
  }

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return dierr("IO_ERROR", `cannot create install dir: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    // COPYFILE_EXCL: kernel-level copy (no JS heap blob) that refuses to overwrite an existing path.
    fs.copyFileSync(srcPath, installPath, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    // EEXIST → collision we must not clobber; anything else → IO error.
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return dierr("INSTALL_EXISTS", `${installPath} already exists (no-overwrite)`);
    return dierr("IO_ERROR", `copy failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  fs.chmodSync(installPath, 0o400); // r--, read-only DATA: immutable + NOT executable

  const st = fs.statSync(installPath);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    fs.rmSync(installPath, { force: true });
    return dierr("OWNER_MISMATCH", `installed file owner ${st.uid} != running uid ${uid}`);
  }
  if (st.nlink !== 1) {
    fs.rmSync(installPath, { force: true });
    return dierr("NLINK", `installed file has link-count ${st.nlink} (expected 1)`);
  }

  // re-hash the PLACED file (defense against a swap between copy and now).
  const placed = sha256FileStreaming(installPath);
  if (placed !== opts.sha256) {
    fs.rmSync(installPath, { force: true });
    return dierr("REHASH_MISMATCH", `placed file hash ${placed} != expected ${opts.sha256}`);
  }
  return { ok: true, installPath, sha256: opts.sha256, reused: false };
}

// ───────────────────────── task 5 — safe archive extraction (tar.gz/tgz only) ─────────────────────────

/** Hard caps on a malicious archive (task-0 gate (a) / H6). */
export const MAX_ARCHIVE_ENTRIES = 4096;
export const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

const CTRL_RE = /[ -]/;

/** Tar entry types we refuse ANYWHERE in a tool archive (a tool tarball is regular files + dirs only). Includes
 *  the pax/GNU meta types as defense-in-depth: tar-stream consumes them internally, so SURFACING one is a red flag. */
const DANGEROUS_TAR_TYPES: ReadonlySet<string> = new Set([
  "symlink", "link", "character-device", "block-device", "fifo", "contiguous-file",
  "pax-global-header", "pax-header", "gnu-long-name", "gnu-long-link",
]);

export type ArchiveErrorCode =
  | "BAD_INNER_PATH"
  | "DECOMPRESS_ERROR"
  | "PARSE_ERROR"
  | "TOO_MANY_ENTRIES"
  | "DECOMPRESSED_TOO_LARGE"
  | "BAD_ENTRY_PATH"
  | "DANGEROUS_ENTRY"
  | "DUPLICATE_ENTRY"
  | "NOT_A_FILE"
  | "INNER_NOT_FOUND"
  | "BIN_SHA_MISMATCH"
  | "IO_ERROR";

export interface ExtractOpts {
  innerPath: string;
  /** sha256 of the EXTRACTED executable bytes (the install identity). */
  binSha256: string;
  /** the temp lands here — same filesystem as the bin store. */
  destDir: string;
  maxEntries?: number;
  maxDecompressedBytes?: number;
}

export type Extract =
  | { ok: true; tempPath: string; binSha256: string }
  | { ok: false; code: ArchiveErrorCode; detail: string };

/** Normalize a tar entry name to a contained POSIX-relative path, or null if it escapes / is malformed.
 *  Strips leading `./`, rejects absolute, backslash, control, and any `..` segment. */
function normTarPath(name: string): string | null {
  if (typeof name !== "string" || name.length === 0 || name.includes("\\") || CTRL_RE.test(name)) return null;
  let n = name;
  while (n.startsWith("./")) n = n.slice(2);
  if (n.startsWith("/")) return null;
  const segs = n.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.length === 0) return null;
  for (const s of segs) if (s === "..") return null;
  return segs.join("/");
}

/**
 * Extract EXACTLY ONE regular file (`innerPath`) from a gzip'd tar artifact, metadata-first: inspect every
 * entry's type/name BEFORE materializing anything, stream only the single matching regular file to a temp,
 * and verify its bytes against `binSha256`. Rejects traversal/absolute, symlink/hardlink/device/special,
 * surfaced pax/GNU meta entries, case-folded duplicates, and over-cap entry-count / decompressed-size.
 * Never throws.
 */
export function extractArchiveMember(artifactPath: string, opts: ExtractOpts): Promise<Extract> {
  return new Promise((resolve) => {
    const maxEntries = opts.maxEntries ?? MAX_ARCHIVE_ENTRIES;
    const maxDecomp = opts.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES;
    const wantInner = normTarPath(opts.innerPath);

    let settled = false;
    let outPath: string | null = null;
    let outStream: fs.WriteStream | null = null;
    let foundTemp: string | null = null;
    const seen = new Set<string>();
    let entryCount = 0;
    let decompressed = 0;

    const src = fs.createReadStream(artifactPath);
    const gunzip = zlib.createGunzip();
    const extract = tarStream.extract();

    const destroyAll = () => {
      src.destroy();
      gunzip.destroy();
      extract.destroy();
      if (outStream) outStream.destroy();
    };
    const done = (r: Extract) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const fail = (code: ArchiveErrorCode, detail: string) => {
      destroyAll();
      if (outPath) fs.rm(outPath, { force: true }, () => {});
      if (foundTemp && foundTemp !== outPath) fs.rm(foundTemp, { force: true }, () => {});
      done({ ok: false, code, detail });
    };

    if (!wantInner) return done({ ok: false, code: "BAD_INNER_PATH", detail: `invalid innerPath: ${opts.innerPath}` });

    // decompressed-size cap (zip-bomb) — observe the gunzip flow; pipe to extract drives backpressure.
    gunzip.on("data", (c: Buffer) => {
      decompressed += c.length;
      if (decompressed > maxDecomp) fail("DECOMPRESSED_TOO_LARGE", `decompressed > ${maxDecomp} bytes`);
    });

    extract.on("entry", (header, stream, next) => {
      if (settled) {
        stream.resume();
        return;
      }
      entryCount++;
      if (entryCount > maxEntries) {
        stream.resume();
        return fail("TOO_MANY_ENTRIES", `archive has > ${maxEntries} entries`);
      }
      if (DANGEROUS_TAR_TYPES.has(header.type ?? "")) {
        stream.resume();
        return fail("DANGEROUS_ENTRY", `${header.type}: ${header.name}`);
      }
      const norm = normTarPath(header.name);
      if (!norm) {
        stream.resume();
        return fail("BAD_ENTRY_PATH", `unsafe entry path: ${header.name}`);
      }
      const folded = norm.toLowerCase();
      if (seen.has(folded)) {
        stream.resume();
        return fail("DUPLICATE_ENTRY", `duplicate (case-folded) entry: ${norm}`);
      }
      seen.add(folded);

      if (norm === wantInner) {
        if ((header.type ?? "file") !== "file") {
          stream.resume();
          return fail("NOT_A_FILE", `${wantInner} is a ${header.type}, not a regular file`);
        }
        outPath = path.join(opts.destDir, `.ex-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`);
        outStream = fs.createWriteStream(outPath, { mode: 0o600 });
        outStream.on("error", (e) => fail("IO_ERROR", e instanceof Error ? e.message : String(e)));
        stream.on("error", (e) => fail("PARSE_ERROR", e instanceof Error ? e.message : String(e)));
        // wait for the WRITE to fully flush (outStream 'finish'), not just the read 'end', before advancing —
        // otherwise the post-`finish` re-hash can race a not-yet-flushed file.
        outStream.on("finish", () => {
          if (!settled) {
            foundTemp = outPath;
            next();
          }
        });
        stream.pipe(outStream);
      } else {
        stream.on("end", next);
        stream.resume();
      }
    });

    extract.on("error", (e) => fail("PARSE_ERROR", e instanceof Error ? e.message : String(e)));
    gunzip.on("error", (e) => fail("DECOMPRESS_ERROR", e instanceof Error ? e.message : String(e)));
    src.on("error", (e) => fail("IO_ERROR", e instanceof Error ? e.message : String(e)));

    extract.on("finish", () => {
      if (settled) return;
      if (!foundTemp) return done({ ok: false, code: "INNER_NOT_FOUND", detail: `no regular file at '${wantInner}'` });
      let h: string;
      try {
        h = sha256File(foundTemp);
      } catch (e) {
        return done({ ok: false, code: "IO_ERROR", detail: e instanceof Error ? e.message : String(e) });
      }
      if (h !== opts.binSha256) {
        fs.rmSync(foundTemp, { force: true });
        return done({ ok: false, code: "BIN_SHA_MISMATCH", detail: `extracted hash ${h} != expected ${opts.binSha256}` });
      }
      done({ ok: true, tempPath: foundTemp, binSha256: opts.binSha256 });
    });

    src.pipe(gunzip).pipe(extract);
  });
}

// ───────────────────────── task 6 — smoke-check + host detect-first ─────────────────────────

export const DEFAULT_SMOKE_TIMEOUT_MS = 5000;
export const DEFAULT_SMOKE_OUTPUT_CAP = 64 * 1024;

export interface SmokeOpts {
  /** the version-probe args (default `["--version"]`). */
  versionArgs?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** an isolation dir used as cwd + HOME/TMPDIR (default a fresh one). */
  sandboxDir?: string;
}

export type SmokeMagic = "elf" | "macho" | "script";
export type SmokeErrorCode = "UNREADABLE" | "BAD_MAGIC" | "NOT_RUNNABLE" | "TIMEOUT";
export type Smoke = { ok: true; magic: SmokeMagic; output: string } | { ok: false; code: SmokeErrorCode; detail: string };

/** Sniff the first bytes for a known executable magic (ELF / Mach-O / `#!` script). */
function sniffMagic(p: string): SmokeMagic | null {
  let fd: number;
  try {
    fd = fs.openSync(p, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    if (n >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return "elf"; // \x7fELF
    const be = buf.readUInt32BE(0);
    if (be === 0xfeedface || be === 0xfeedfacf || be === 0xcafebabe || be === 0xcffaedfe || be === 0xcefaedfe) return "macho";
    if (n >= 2 && buf[0] === 0x23 && buf[1] === 0x21) return "script"; // #!
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Smoke-check an installed executable AFTER hash verification (it is execution — inside the trust boundary):
 * sniff the magic, then run a version probe in a MINIMAL env, no repo cwd, redirected HOME/TMPDIR, a timeout
 * and an output cap. Network isolation is BEST-EFFORT (H10) — a native `--version` could still attempt I/O;
 * we cannot fully sandbox in plain Node v1.
 */
export function smokeCheck(exePath: string, opts: SmokeOpts = {}): Smoke {
  const magic = sniffMagic(exePath);
  if (magic === null) {
    // distinguish unreadable from bad-magic for a clearer diagnostic.
    try {
      fs.accessSync(exePath, fs.constants.R_OK);
    } catch {
      return { ok: false, code: "UNREADABLE", detail: `cannot read ${exePath}` };
    }
    return { ok: false, code: "BAD_MAGIC", detail: "not an ELF/Mach-O/script executable" };
  }

  let sandbox = opts.sandboxDir;
  let madeSandbox = false;
  if (!sandbox) {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tach-smoke-"));
    madeSandbox = true;
  }
  try {
    const res = spawnSync(exePath, opts.versionArgs ?? ["--version"], {
      cwd: sandbox,
      timeout: opts.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS,
      maxBuffer: opts.maxOutputBytes ?? DEFAULT_SMOKE_OUTPUT_CAP,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: sandbox, TMPDIR: sandbox },
    });
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT") return { ok: false, code: "TIMEOUT", detail: `version probe timed out` };
      return { ok: false, code: "NOT_RUNNABLE", detail: res.error.message };
    }
    if (res.signal === "SIGTERM" || res.signal === "SIGKILL") return { ok: false, code: "TIMEOUT", detail: `killed by ${res.signal}` };
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
    return { ok: true, magic, output };
  } finally {
    if (madeSandbox && sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

/** A structural subset of fs.Stats the trust check needs (injectable for tests). */
export interface PathStat {
  uid: number;
  mode: number;
  isFile(): boolean;
}

export interface DetectOpts {
  /** the exact probe to read the host tool's version (required; detect is opt-in). */
  versionCommand: string[];
  /** when declared, the host binary's sha256 must match or it is not trusted. */
  allowedHostSha256?: string;
  /** resolve a bare tool name to an absolute path (default: `command -v`). */
  lookupPath?: (name: string) => string | null;
  /** stat a path (default: fs.statSync wrapper). Injectable so the trust logic is testable off real /usr/bin. */
  statPath?: (p: string) => PathStat | null;
  /** resolve symlinks to the real file (default: fs.realpathSync). Injectable so tests are platform-stable. */
  realpath?: (p: string) => string;
}

export type DetectErrorCode = "NOT_FOUND" | "NOT_ABSOLUTE" | "UNTRUSTED_PATH" | "VERSION_FAILED" | "HASH_NOT_ALLOWED" | "IO_ERROR";
export type Detect = { ok: true; path: string; version: string; hash: string } | { ok: false; code: DetectErrorCode; detail: string };

/** A path is trusted only if the file AND every ancestor dir is owned by the running uid or root, and none is
 *  group/other-writable (so no other user could have swapped the binary). Rejects anything under /tmp (1777). */
export function isTrustedExecPath(abs: string, uid: number, statPath: (p: string) => PathStat | null): { trusted: boolean; reason?: string } {
  const fst = statPath(abs);
  if (!fst) return { trusted: false, reason: `cannot stat ${abs}` };
  if (!fst.isFile()) return { trusted: false, reason: `${abs} is not a regular file` };
  if (fst.uid !== 0 && fst.uid !== uid) return { trusted: false, reason: `${abs} is owned by uid ${fst.uid}` };
  if (fst.mode & 0o022) return { trusted: false, reason: `${abs} is group/other writable` };
  let dir = path.dirname(abs);
  for (;;) {
    const dst = statPath(dir);
    if (!dst) return { trusted: false, reason: `cannot stat ${dir}` };
    if (dst.uid !== 0 && dst.uid !== uid) return { trusted: false, reason: `${dir} is owned by uid ${dst.uid}` };
    if (dst.mode & 0o022) return { trusted: false, reason: `${dir} is group/other writable` };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { trusted: true };
}

function defaultLookupPath(name: string): string | null {
  try {
    const out = execFileSync("command", ["-v", name], { encoding: "utf8", shell: "/bin/sh", timeout: 5000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function defaultStatPath(p: string): PathStat | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * Detect a trusted host-installed tool (opt-in detect-first). Resolves the bare name to an absolute path,
 * enforces full-path ownership+mode trust, reads the EXACT version via the declared probe, records the host
 * binary's sha256, and (when declared) gates on `allowedHostSha256`. Returns the path+version+hash for the
 * caller to compare against the manifest's pinned version. Fail-closed.
 */
export function detectHostTool(name: string, opts: DetectOpts): Detect {
  const lookup = opts.lookupPath ?? defaultLookupPath;
  const statPath = opts.statPath ?? defaultStatPath;
  const looked = lookup(name);
  if (!looked) return { ok: false, code: "NOT_FOUND", detail: `'${name}' not found on PATH` };
  if (!path.isAbsolute(looked)) return { ok: false, code: "NOT_ABSOLUTE", detail: `resolved path is not absolute: ${looked}` };
  // Resolve symlinks to the REAL file (Homebrew/nvm shims are symlinks) — the launcher opens this with
  // O_NOFOLLOW, so the recorded path must already be the concrete target (codex task-7 review, point D).
  const realpath = opts.realpath ?? fs.realpathSync;
  let resolved: string;
  try {
    resolved = realpath(looked);
  } catch (e) {
    return { ok: false, code: "NOT_FOUND", detail: `cannot resolve realpath of ${looked}: ${e instanceof Error ? e.message : String(e)}` };
  }

  const uid = process.getuid?.() ?? 0;
  const trust = isTrustedExecPath(resolved, uid, statPath);
  if (!trust.trusted) return { ok: false, code: "UNTRUSTED_PATH", detail: trust.reason ?? "untrusted path" };

  const probe = spawnSync(opts.versionCommand[0], opts.versionCommand.slice(1), { timeout: 5000, maxBuffer: DEFAULT_SMOKE_OUTPUT_CAP, encoding: "utf8" });
  if (probe.error) return { ok: false, code: "VERSION_FAILED", detail: probe.error.message };
  const version = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
  if (!version) return { ok: false, code: "VERSION_FAILED", detail: "version probe produced no output" };

  let hash: string;
  try {
    hash = sha256File(resolved);
  } catch (e) {
    return { ok: false, code: "IO_ERROR", detail: e instanceof Error ? e.message : String(e) };
  }
  if (opts.allowedHostSha256 && hash !== opts.allowedHostSha256) {
    return { ok: false, code: "HASH_NOT_ALLOWED", detail: `host binary hash ${hash} != allowedHostSha256` };
  }
  return { ok: true, path: resolved, version, hash };
}
