/*
 * spec 274 — a tiny static server for the webview preview harness (dev tooling, never shipped).
 * Serves the repo root so the harness can link the real `dist/webview/*` build output AND its own
 * `scripts/webview-preview/*` files at absolute paths. NOT file:// (which hides asset/CSP/origin issues).
 *
 *   npm run build && node scripts/webview-preview/serve.mjs
 *   → http://localhost:5174/scripts/webview-preview/index.html?fixture=evidence-badge
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PREVIEW_PORT) || 5174;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  // strip query, decode, and refuse traversal outside the repo root (resolve + relative check — NOT a prefix
  // check, which a same-prefix sibling could pass; catch malformed percent-encoding).
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  // The harness links the SHIPPED bundles at `/dist/webview/*`, which was a repo-root path until the
  // monorepoization moved the build output under `apps/vscode-extension/`. Serving the root alone has
  // 404'd every bundle since — the page loads, the shell never mounts, and the harness renders
  // "PREVIEW SHELL DID NOT MOUNT" instead of a surface. Mapping the prefix here keeps the URLs the
  // page (and the generated `routes.json`) already spell, rather than rewriting both.
  const urlPathOnDisk = urlPath.startsWith("/dist/") ? `/apps/vscode-extension${urlPath}` : urlPath;
  const filePath = path.resolve(ROOT, "." + urlPathOnDisk);
  const rel = path.relative(ROOT, filePath);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404).end(`not found: ${urlPath}`);
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(filePath)] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/scripts/webview-preview/index.html`;
  console.log(`[webview-preview] serving the repo root on ${url}`);
  console.log(`[webview-preview] try: ${url}?fixture=evidence-badge`);
});
