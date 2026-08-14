/**
 * SDD 422 — serve the Companion Mobile PWA from the engine Bridge.
 * Mounted at GET /companion/app/* (same listener as /companion/v1).
 *
 * Unauthenticated by design (pair secrets live in #pair= hash, not paths).
 * Path resolution is fail-closed against traversal.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { COMPANION_APP_PREFIX } from "./protocol.js";

export { COMPANION_APP_PREFIX };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Asset extensions: missing file → 404 (never SPA-fallback HTML). */
const ASSET_EXT = new Set(Object.keys(MIME).filter((e) => e !== ".html"));

function distIfPresent(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const resolved = path.resolve(dir);
  if (fs.existsSync(path.join(resolved, "index.html"))) return resolved;
  return undefined;
}

/**
 * Resolve directory containing index.html + app.js for the mobile PWA.
 * Order: env override → extension media/companion-mobile → cwd media → sibling monorepo dist.
 */
export function resolveCompanionMobileDist(opts?: {
  extensionPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.cwd() for dev/media checkout resolution. */
  cwd?: string;
}): string | undefined {
  const env = opts?.env ?? process.env;
  const fromEnv = env.TACHYON_COMPANION_MOBILE_DIST?.trim();
  const hit = distIfPresent(fromEnv);
  if (hit) return hit;

  if (opts?.extensionPath) {
    const media = distIfPresent(path.join(opts.extensionPath, "media", "companion-mobile"));
    if (media) return media;
  }

  const cwd = opts?.cwd ?? process.cwd();
  const mediaInCwd = distIfPresent(path.join(cwd, "media", "companion-mobile"));
  if (mediaInCwd) return mediaInCwd;

  // Dev: ADE checkout next to tachyon-companion
  const sibling = distIfPresent(path.join(cwd, "..", "tachyon-companion", "apps", "mobile", "dist"));
  if (sibling) return sibling;

  return undefined;
}

export function isCompanionAppPath(urlPath: string): boolean {
  return urlPath === COMPANION_APP_PREFIX || urlPath.startsWith(`${COMPANION_APP_PREFIX}/`);
}

/**
 * Fully decode URI path; reject if any residual encoding of `.` / `/` / `\` or control chars.
 * Single-pass fails closed on double-encoding tricks that leave encoded dots/slashes.
 */
export function safeDecodeAppRel(rel: string): string | undefined {
  let cur = rel;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return undefined;
    }
    if (next === cur) break;
    cur = next;
  }
  // Reject anything that still looks encoded or contains traversal / separators we don't allow
  if (/%[0-9a-fA-F]{2}/.test(cur)) return undefined;
  if (cur.includes("\0") || /[\u0000-\u001f\u007f]/.test(cur)) return undefined;
  // Normalize separators; never allow backslash
  if (cur.includes("\\")) return undefined;
  const stripped = cur.replace(/^\/+/, "");
  if (!stripped) return "index.html";
  // Reject absolute (posix or win drive) and any `..` segment
  if (path.isAbsolute(stripped) || /^[a-zA-Z]:/.test(stripped)) return undefined;
  const segments = stripped.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "." || s === "..")) return undefined;
  return segments.join(path.sep);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root);
  const candResolved = path.resolve(candidate);
  const rel = path.relative(rootResolved, candResolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Map request path under /companion/app to a file under distRoot.
 * - Known asset extensions: exact file or 404 (no HTML spoof)
 * - Extensionless / .html: existing file or SPA index.html
 */
export function companionAppFilePath(urlPath: string, distRoot: string): string | undefined {
  if (!isCompanionAppPath(urlPath)) return undefined;
  let rel = urlPath.slice(COMPANION_APP_PREFIX.length) || "/";
  if (rel === "/" || rel === "") rel = "/index.html";

  const safeRel = safeDecodeAppRel(rel);
  if (safeRel === undefined) return undefined;

  const rootResolved = path.resolve(distRoot);
  const candidate = path.resolve(rootResolved, safeRel);
  if (!isInsideRoot(rootResolved, candidate)) return undefined;

  const ext = path.extname(safeRel).toLowerCase();
  const isAsset = ASSET_EXT.has(ext);

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  // Missing assets must 404 — never return HTML as JS/CSS/etc.
  if (isAsset) return undefined;

  // SPA / bare routes → index.html only
  const index = path.join(rootResolved, "index.html");
  if (fs.existsSync(index) && isInsideRoot(rootResolved, index)) return index;
  return undefined;
}

export function serveCompanionMobileApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  distRoot: string | undefined,
): boolean {
  const urlPath = (req.url ?? "").split("?")[0] ?? "";
  if (!isCompanionAppPath(urlPath)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return true;
  }
  if (!distRoot) {
    res.writeHead(503, {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    res.end(
      "Companion Mobile app not packaged. Build tachyon-companion apps/mobile into media/companion-mobile/.",
    );
    return true;
  }
  const file = companionAppFilePath(urlPath, distRoot);
  if (!file) {
    res.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    res.end("not found");
    return true;
  }
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  const body = fs.readFileSync(file);
  const cacheControl =
    ext === ".html" || path.basename(file) === "sw.js" ? "no-store" : "public, max-age=300";
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
  });
  if (req.method === "HEAD") res.end();
  else res.end(body);
  return true;
}
