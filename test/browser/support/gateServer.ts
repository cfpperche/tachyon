import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { renderGatePage } from "../../../src/webview/ui-gate/gatePage.js";
import { PREFLIGHT_FIXTURE_HTML } from "../../../packages/webview-ui/src/webview/ui-gate/preflightFixture.js";
import { SHELL_BASE_STYLESHEETS } from "../../../apps/vscode-extension/src/webview/shared/shell.js";
import { renderPluginFrameGatePage } from "../../../scripts/webview-preview/pluginFrameGate.js";

// spec 342 — a tiny static server for the ui-gate browser tests, modeled on scripts/webview-preview/serve.mjs
// (same repo-root-relative traversal guard). The ONE addition: a `/ui-gate` route that renders the page with
// the REAL `renderGatePage`/`renderWebviewShell` (not a hand-copied HTML string), so the gate exercises the
// same CSP shape + stylesheet order every shipped webview gets. `cspSource` is the server's own origin — the
// closest a plain HTTP server gets to a VS Code webview's `vscode-webview://<uuid>` origin (same directive
// shape, different scheme).
const ROOT = path.resolve(__dirname, "..", "..", "..");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export interface GateServer {
  url: string;
  /** the SAME `PREFLIGHT_FIXTURE_HTML` markup as the `/ui-gate` page's own fixture section, on a bare page
   *  linking only the shared baseline — no vscode-theme.css, no Tailwind. The before/after comparison in
   *  test/browser/preflightFixture.test.ts diffs this page's computed styles against the real gate page's. */
  preflightFixtureNoTailwindUrl: string;
  /** spec 349 T1 — the opaque-origin iframe contract gate page. */
  pluginFrameGateUrl: string;
  /** the server's own origin — this server ALSO serves the whole repo root as static files (the fallback
   *  branch below), so `${origin}/scripts/webview-preview/index.html?view=…&fixture=…` drives the REAL dev
   *  preview harness (the actual shipped bundle + a captured fixture VM), not just the synthetic gate page. */
  origin: string;
  close: () => Promise<void>;
}

/** Start the gate server on an ephemeral port. Caller must `close()` it (tests use afterAll). */
export async function startGateServer(): Promise<GateServer> {
  const server = http.createServer((req, res) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }
    if (urlPath === "/ui-gate") {
      const html = renderGatePage(`http://${req.headers.host}`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      return;
    }
    if (urlPath === "/plugin-frame-gate") {
      // spec 349 T1 — the opaque-origin iframe contract gate page (see pluginFrameGate.ts + the
      // plugin-frame-relay.js it references, served below by this same server's static fallback).
      const html = renderPluginFrameGatePage(`http://${req.headers.host}`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      return;
    }
    if (urlPath === "/preflight-fixture-no-tailwind") {
      const cspSource = `http://${req.headers.host}`;
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
${SHELL_BASE_STYLESHEETS.map((sheet) => `<link rel="stylesheet" href="${cspSource}/dist/webview/${sheet}">`).join("\n")}
<title>preflight fixture (no Tailwind)</title></head><body>${PREFLIGHT_FIXTURE_HTML}</body></html>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      return;
    }
    const filePath = path.resolve(ROOT, "." + urlPath);
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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/ui-gate`,
    preflightFixtureNoTailwindUrl: `${origin}/preflight-fixture-no-tailwind`,
    pluginFrameGateUrl: `${origin}/plugin-frame-gate`,
    origin,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
