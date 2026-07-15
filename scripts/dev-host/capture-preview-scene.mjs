#!/usr/bin/env node
/**
 * Headless Chromium screenshot of a webview-preview harness route.
 * Used by the UI shortlist dogfood (mermaid / grok activity / handoff distill).
 *
 * Usage:
 *   node scripts/dev-host/capture-preview-scene.mjs \
 *     --view activity --fixture mermaid-nav --out /tmp/shot.png [--width 900] [--theme dark]
 */
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function findChrome() {
  if (process.env.TACHYON_CHROME && fs.existsSync(process.env.TACHYON_CHROME)) return process.env.TACHYON_CHROME;
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  ];
  return candidates.find((c) => fs.existsSync(c));
}

function waitHttp(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else if (Date.now() - start > timeoutMs) reject(new Error(`timeout waiting ${url}`));
        else setTimeout(tick, 200);
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`timeout waiting ${url}`));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

async function main() {
  const view = arg("view", "activity");
  const fixture = arg("fixture", "default");
  const out = arg("out");
  const width = Number(arg("width", "900"));
  const height = Number(arg("height", "1100"));
  const theme = arg("theme", "dark"); // dark | light
  if (!out) {
    console.error("missing --out <png>");
    process.exit(2);
  }

  const chrome = findChrome();
  if (!chrome) {
    console.error("no Chrome/Chromium found (set TACHYON_CHROME)");
    process.exit(2);
  }

  // Prefer a free high port so parallel shortlist scenes don't clash with a human preview.
  const port = Number(process.env.PREVIEW_PORT) || 5179 + Math.floor(Math.random() * 20);
  const serve = spawn(process.execPath, ["scripts/webview-preview/serve.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PREVIEW_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serveLog = "";
  serve.stdout.on("data", (d) => {
    serveLog += d.toString();
  });
  serve.stderr.on("data", (d) => {
    serveLog += d.toString();
  });

  const qs = new URLSearchParams({ view, fixture, width: String(width) });
  if (theme === "light") qs.set("theme", "light");
  const pageUrl = `http://127.0.0.1:${port}/scripts/webview-preview/index.html?${qs}`;

  try {
    await waitHttp(`http://127.0.0.1:${port}/scripts/webview-preview/index.html`);
    // Server is up; Chrome will load the page. Mermaid/handoff need extra wall time after load.
    const settleMs =
      view === "activity" && fixture === "mermaid-nav"
        ? 8000
        : view === "handoff"
          ? 5000
          : 2500;

    fs.mkdirSync(path.dirname(out), { recursive: true });
    const absOut = path.resolve(out);

    // virtual-time-budget advances page timers so async hydrate + mermaid can finish before --screenshot.
    const budget = String(Math.max(settleMs, 3000));
    const chromeArgs = [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      `--window-size=${width},${height}`,
      `--virtual-time-budget=${budget}`,
      `--screenshot=${absOut}`,
      pageUrl,
    ];
    // Windows chrome.exe via WSL needs different path handling; prefer Linux chrome.
    await new Promise((resolve, reject) => {
      const child = spawn(chrome, chromeArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => {
        err += d.toString();
      });
      // Hard wall clock: virtual-time can finish before mermaid paints; give a grace sleep after chrome exits? 
      // Better: run chrome, then if still loading pattern we re-shot — for now wait on exit.
      child.on("exit", (code) => {
        if (code === 0 && fs.existsSync(absOut) && fs.statSync(absOut).size > 2000) resolve();
        else reject(new Error(`chrome screenshot failed code=${code} size=${fs.existsSync(absOut) ? fs.statSync(absOut).size : 0}\n${err.slice(-500)}`));
      });
    });

    // Fail closed if we clearly shot a spinner state (handoff load / mermaid rendering).
    // Optional second pass with longer budget when first frame looks empty-ish.
    const bytes = fs.statSync(absOut).size;
    if (bytes < 15000 && (view === "handoff" || fixture === "mermaid-nav")) {
      const retryOut = absOut.replace(/\.png$/, "-retry.png");
      await new Promise((resolve, reject) => {
        const child = spawn(
          chrome,
          [
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--hide-scrollbars",
            `--window-size=${width},${height}`,
            `--virtual-time-budget=15000`,
            `--screenshot=${retryOut}`,
            pageUrl,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        child.on("exit", (code) => {
          if (code === 0 && fs.existsSync(retryOut) && fs.statSync(retryOut).size > bytes) {
            fs.renameSync(retryOut, absOut);
            resolve();
          } else if (code === 0 && fs.existsSync(retryOut)) {
            fs.renameSync(retryOut, absOut);
            resolve();
          } else reject(new Error(`retry screenshot failed code=${code}`));
        });
      });
    }

    console.log(JSON.stringify({ ok: true, view, fixture, out: absOut, bytes: fs.statSync(absOut).size, url: pageUrl }));
  } catch (err) {
    console.error(serveLog.slice(-800));
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    serve.kill("SIGTERM");
  }
}

main();
