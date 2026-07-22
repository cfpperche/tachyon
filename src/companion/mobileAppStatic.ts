/**
 * SDD 422 — serve the Companion Mobile PWA from the engine Bridge.
 * Mounted at GET /companion/app/* (same listener as /companion/v1).
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
 * Map request path under /companion/app to a file under distRoot.
 * SPA fallback: missing paths → index.html (client router not used; still safe).
 */
export function companionAppFilePath(urlPath: string, distRoot: string): string | undefined {
  let rel = urlPath.slice(COMPANION_APP_PREFIX.length) || "/";
  if (rel === "/" || rel === "") rel = "/index.html";
  // block traversal
  const decoded = decodeURIComponent(rel).replace(/^\/+/, "");
  if (decoded.includes("..") || path.isAbsolute(decoded)) return undefined;
  const candidate = path.join(distRoot, decoded);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(path.resolve(distRoot) + path.sep) && resolved !== path.resolve(distRoot)) {
    return undefined;
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  // SPA / directory → index.html
  const index = path.join(distRoot, "index.html");
  if (fs.existsSync(index)) return index;
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
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "Companion Mobile app not packaged. Build tachyon-companion apps/mobile into media/companion-mobile/.",
    );
    return true;
  }
  const file = companionAppFilePath(urlPath, distRoot);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return true;
  }
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=300",
    "access-control-allow-origin": "*",
  });
  if (req.method === "HEAD") res.end();
  else res.end(body);
  return true;
}
