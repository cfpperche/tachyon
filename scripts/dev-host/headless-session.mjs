/**
 * Dev Host headless SESSION — a persistent, agent-drivable EDH you operate command-by-command.
 *
 * `headless-interactive.mjs` runs one scenario then exits (good for canned repros / CI). This is the
 * EXPLORATORY companion: `up` launches the pointed Dev Host once under Xvfb with a CDP port and
 * leaves it running detached; every later verb (`cmd`, `click`, `eval`, `shot`, `console`, …) makes
 * a fresh cheap CDP connection to that same live EDH, does ONE thing, prints a JSON result, and
 * disconnects. So an agent can: boot once → look (shot/eval) → act (click/cmd) → look again → decide
 * the next step — real exploratory dogfood, no relaunch between steps. `steps` runs a JSON list for
 * the guided/batch case. `down` tears it all down.
 *
 * Session state: .tachyon/dev-host/session.json  ({ display, port, edhPid, xvfbPid, outDir }).
 * Output dir:    .tachyon/dev-host/session-out/   (screenshots, logs — persists across verbs).
 *
 * Frame targeting: most Control dogfood is on the Control webview, so `control` is a built-in frame
 * alias. Pass any other frame as a JS predicate string that returns truthy inside the target frame.
 *
 * Verbs (all print one JSON line to stdout; screenshots also write a PNG):
 *   up   [--port N] [--display :N] [--force]      launch + wait for CDP + record session
 *   status                                        is a session live? which targets exist?
 *   down                                          kill EDH + Xvfb, clear session
 *   sleep <ms>                                    settle delay (useful between steps in a step list)
 *   cmd  "<Command Palette text>"                 run a VS Code command (keyboard-driven palette)
 *   shot <name>                                   screenshot the workbench → session-out/<name>.png
 *   frames                                        list every frame url across targets
 *   eval  <frame> "<js>"                          eval JS inside the matching frame, print its return
 *   click <frame> "<text>"                        click first element whose text contains <text>
 *   click-testid <frame> <testid> "<text>"        click a button containing <text> inside [data-testid=…]
 *   dom   <frame> "<selector>"                    return [{tag,text,testid,cls}] for matches (peek the UI)
 *   spy-console <frame>                           install a console/error mirror in the frame
 *   console <frame> [n]                           read the last n mirrored console lines (needs spy-console)
 *   steps <file.json>                             run [{verb,args:[…]}, …] in order; print a result array
 *
 *   <frame> is `control` or a JS predicate string.
 *
 * See docs/runbooks/dev-host.md → "Interactive headless" / "Exploratory session".
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SELF = "dev-host-session";
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const PTR = path.join(REPO, ".tachyon", "dev-host");
const SESSION_FILE = path.join(PTR, "session.json");
const META_FILE = path.join(PTR, "meta.json");
const OUT_DIR = path.join(PTR, "session-out");

/** Built-in frame alias: the Control webview. */
const CONTROL_PRED = "!!document.querySelector('.ck-tabs') || !!document.querySelector('.ck-root')";

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const die = (msg) => { out({ ok: false, error: msg }); process.exit(1); };

function readSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); } catch { return undefined; }
}

function readPointerGeneration() {
  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    if (typeof meta.generation !== "string" || !meta.generation) {
      die("Dev Host pointer has no generation — re-run point before starting a session");
    }
    return meta.generation;
  } catch (error) {
    die(`Dev Host pointer metadata unreadable — re-run point (${error instanceof Error ? error.message : String(error)})`);
  }
}

function assertSessionStillOwnsPointer(session) {
  const current = readPointerGeneration();
  if (current !== session.pointerGeneration) {
    die(`pointer changed during session (expected ${session.pointerGeneration}, found ${current}); aborting fail-closed`);
  }
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = ""; res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

function resolveCodeBin() {
  const raw = execFileSync(process.execPath, [path.join(here, "resolve-code.mjs"), REPO], { encoding: "utf8" }).trim();
  const bin = raw.split("\n").filter(Boolean).pop();
  if (!bin || !fs.existsSync(bin)) throw new Error(`resolve-code returned no binary (${raw})`);
  const launcher = path.join(path.dirname(bin), "bin", "code");
  return fs.existsSync(launcher) ? launcher : bin;
}

async function connect(session) {
  const { default: puppeteer } = await import("puppeteer-core");
  return puppeteer.connect({ browserURL: `http://127.0.0.1:${session.port}`, defaultViewport: null, protocolTimeout: 30_000 });
}

async function workbenchPage(browser) {
  for (let i = 0; i < 20; i++) {
    const pages = await browser.pages();
    const wb = pages.find((p) => p.url().includes("workbench.html") || p.url().includes("vscode-file://"));
    if (wb) return wb;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("no workbench page");
}

/** Resolve `<frame>` (alias or predicate) to a puppeteer Frame. */
async function resolveFrame(browser, frameArg) {
  const pred = frameArg === "control" ? CONTROL_PRED : frameArg;
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const t of browser.targets()) {
      if (!["page", "webview", "other"].includes(t.type())) continue;
      let page;
      try { page = await t.page(); } catch { continue; }
      if (!page) continue;
      for (const frame of page.frames()) {
        try { if (await frame.evaluate(pred)) return frame; } catch { /* detached/cross-origin */ }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// ---------- up / down / status ----------

async function up(opts) {
  const existing = readSession();
  if (existing && !opts.force) {
    // is it actually alive?
    try { process.kill(existing.edhPid, 0); die(`session already live (edhPid=${existing.edhPid}); use down first, or up --force`); }
    catch { /* stale — fall through */ }
  }
  const extensionDir = path.join(PTR, "extension");
  if (!fs.existsSync(extensionDir)) die(`Dev Host pointer not armed (missing ${extensionDir}) — run: npm run dogfood:dev-host -- point …`);
  const extensionPath = fs.realpathSync(extensionDir);
  if (!fs.existsSync(path.join(extensionPath, "dist", "extension.js"))) die(`pointed extension has no dist/extension.js — build it (TACHYON_ENGINE_CHANNEL=dev npm run build)`);
  const workspaceDir = path.join(PTR, "workspace");
  const pointerGeneration = readPointerGeneration();

  try { execFileSync("which", ["Xvfb"]); } catch { die("Xvfb required (apt install xvfb)"); }
  const codeBin = resolveCodeBin();

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  const udd = path.join(OUT_DIR, "udd");
  const extDir = path.join(OUT_DIR, "extensions");
  fs.mkdirSync(path.join(udd, "User"), { recursive: true });
  fs.mkdirSync(extDir, { recursive: true });
  fs.mkdirSync(path.join(PTR, "profile-home"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(udd, "User", "settings.json"), JSON.stringify({
    "workbench.startupEditor": "none",
    "workbench.colorTheme": "Default Dark Modern",
    "update.mode": "none",
    "telemetry.telemetryLevel": "off",
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "window.dialogStyle": "custom",
    "window.newWindowDimensions": "maximized",
  }, null, 2));

  const xvfb = spawn("Xvfb", [opts.display, "-screen", "0", "1600x1000x24"], { stdio: "ignore", detached: true });
  await new Promise((r) => setTimeout(r, 800));
  if (xvfb.exitCode !== null) die(`Xvfb failed on ${opts.display} (in use? try --display :98)`);
  xvfb.unref();

  const hostLog = fs.openSync(path.join(OUT_DIR, "host.log"), "w");
  const env = {
    ...process.env,
    DISPLAY: opts.display,
    DONT_PROMPT_WSL_INSTALL: "1",
    TACHYON_DEV_HOST: "1",
    TACHYON_DEV_HOST_ENGINE_RUNTIME: path.join(PTR, "runtime"),
    TACHYON_DEV_HOST_PROFILE_HOME: path.join(PTR, "profile-home"),
    TMUX_TMPDIR: path.join(PTR, "tmux"),
    XDG_CACHE_HOME: path.join(PTR, "cache"),
    XDG_STATE_HOME: path.join(PTR, "state"),
    XDG_DATA_HOME: path.join(PTR, "data"),
  };
  delete env.VSCODE_IPC_HOOK_CLI;      // would forward to the human's live window
  delete env.ELECTRON_RUN_AS_NODE;     // would turn the binary into plain node

  const edh = spawn(codeBin, [
    `--extensionDevelopmentPath=${extensionPath}`,
    `--user-data-dir=${udd}`,
    `--extensions-dir=${extDir}`,
    `--remote-debugging-port=${opts.port}`,
    "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust",
    "--use-inmemory-secretstorage", "--disable-gpu", "--disable-updates", "--new-window",
    workspaceDir,
  ], { env, stdio: ["ignore", hostLog, hostLog], detached: true });
  edh.unref();

  // wait for CDP
  let version;
  for (let i = 0; i < 60; i++) {
    try { version = await httpJson(`http://127.0.0.1:${opts.port}/json/version`); break; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (!version) die("CDP never came up — see session-out/host.log");

  const session = {
    sessionId: randomUUID(),
    display: opts.display, port: opts.port, edhPid: edh.pid, xvfbPid: xvfb.pid,
    outDir: OUT_DIR, extension: extensionPath, pointerGeneration, startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  // settle for extension activation
  await new Promise((r) => setTimeout(r, 8000));
  out({ ok: true, up: true, browser: version.Browser, port: opts.port, edhPid: edh.pid, outDir: OUT_DIR });
}

function down() {
  const s = readSession();
  if (!s) return out({ ok: true, down: true, note: "no session" });
  for (const [name, pid] of [["edh", s.edhPid], ["xvfb", s.xvfbPid]]) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  // hard kill after a beat
  setTimeout(() => {
    for (const pid of [s.edhPid, s.xvfbPid]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    const current = readSession();
    if (current?.sessionId === s.sessionId) fs.rmSync(SESSION_FILE, { force: true });
    out({ ok: true, down: true, killed: { edhPid: s.edhPid, xvfbPid: s.xvfbPid } });
  }, 1200);
}

async function status() {
  const s = readSession();
  if (!s) return out({ ok: true, live: false });
  const currentGeneration = readPointerGeneration();
  let alive = false;
  try { process.kill(s.edhPid, 0); alive = true; } catch { /* dead */ }
  let targets;
  if (alive) {
    try {
      const browser = await connect(s);
      targets = browser.targets().map((t) => `${t.type()} ${t.url().slice(0, 100)}`);
      await browser.disconnect();
    } catch (e) { targets = [`connect failed: ${e}`]; }
  }
  out({ ok: true, live: alive, ownsPointer: currentGeneration === s.pointerGeneration, session: s, targets });
}

// ---------- verbs against a live session ----------

async function withBrowser(fn) {
  const s = readSession();
  if (!s) die("no live session — run: node scripts/dev-host/headless-session.mjs up");
  assertSessionStillOwnsPointer(s);
  const browser = await connect(s);
  try { return await fn(browser, s); }
  finally { try { await browser.disconnect(); } catch { /* ignore */ } }
}

async function cmd(text) {
  await withBrowser(async (browser) => {
    const wb = await workbenchPage(browser);
    await wb.keyboard.down("Control"); await wb.keyboard.down("Shift"); await wb.keyboard.press("KeyP");
    await wb.keyboard.up("Shift"); await wb.keyboard.up("Control");
    await new Promise((r) => setTimeout(r, 500));
    await wb.keyboard.type(text, { delay: 12 });
    await new Promise((r) => setTimeout(r, 700));
    await wb.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, 600));
    out({ ok: true, cmd: text });
  });
}

async function shot(name) {
  await withBrowser(async (browser) => {
    const wb = await workbenchPage(browser);
    const file = path.join(OUT_DIR, `${name}.png`);
    await wb.screenshot({ path: file });
    out({ ok: true, shot: file });
  });
}

async function frames() {
  await withBrowser(async (browser) => {
    const list = [];
    for (const t of browser.targets()) {
      let page; try { page = await t.page(); } catch { continue; }
      if (!page) continue;
      for (const f of page.frames()) list.push({ type: t.type(), url: f.url().slice(0, 140) });
    }
    out({ ok: true, frames: list });
  });
}

async function evalIn(frameArg, js) {
  await withBrowser(async (browser) => {
    const frame = await resolveFrame(browser, frameArg);
    if (!frame) return out({ ok: false, error: `frame not found for ${frameArg}` });
    try { out({ ok: true, result: await frame.evaluate(js) }); }
    catch (e) { out({ ok: false, error: String(e) }); }
  });
}

async function clickText(frameArg, text) {
  await withBrowser(async (browser) => {
    const frame = await resolveFrame(browser, frameArg);
    if (!frame) return out({ ok: false, error: `frame not found for ${frameArg}` });
    const r = await frame.evaluate((t) => {
      const els = [...document.querySelectorAll("button, a, [role='button'], .ck-tabs button")];
      const el = els.find((e) => (e.textContent || "").trim().includes(t));
      if (!el) return { ok: false, seen: els.map((e) => (e.textContent || "").trim()).filter(Boolean).slice(0, 40) };
      el.click(); return { ok: true, clicked: (el.textContent || "").trim() };
    }, text);
    out(r.ok ? { ok: true, ...r } : { ok: false, error: `no element containing "${text}"`, seen: r.seen });
  });
}

async function clickTestid(frameArg, testid, text) {
  await withBrowser(async (browser) => {
    const frame = await resolveFrame(browser, frameArg);
    if (!frame) return out({ ok: false, error: `frame not found for ${frameArg}` });
    const r = await frame.evaluate((id, t) => {
      const scope = document.querySelector(`[data-testid='${id}']`);
      if (!scope) return { ok: false, error: `no [data-testid=${id}]` };
      const els = [...scope.querySelectorAll("button, a, [role='button']")];
      const el = t ? els.find((e) => (e.textContent || "").trim().includes(t)) : els[0];
      if (!el) return { ok: false, seen: els.map((e) => (e.textContent || "").trim()) };
      el.click(); return { ok: true, clicked: (el.textContent || "").trim() };
    }, testid, text ?? "");
    out(r.ok ? { ok: true, ...r } : { ok: false, ...r });
  });
}

async function dom(frameArg, selector) {
  await withBrowser(async (browser) => {
    const frame = await resolveFrame(browser, frameArg);
    if (!frame) return out({ ok: false, error: `frame not found for ${frameArg}` });
    const nodes = await frame.evaluate((sel) => [...document.querySelectorAll(sel)].slice(0, 60).map((e) => ({
      tag: e.tagName.toLowerCase(),
      text: (e.textContent || "").trim().slice(0, 80),
      testid: e.getAttribute("data-testid") || undefined,
      cls: e.className && typeof e.className === "string" ? e.className.slice(0, 80) : undefined,
    })), selector);
    out({ ok: true, count: nodes.length, nodes });
  });
}

async function spyConsole(frameArg) {
  await withBrowser(async (browser) => {
    const frame = await resolveFrame(browser, frameArg);
    if (!frame) return out({ ok: false, error: `frame not found for ${frameArg}` });
    await frame.evaluate(() => {
      if (window.__consolelog) return;
      window.__consolelog = [];
      const push = (level, args) => {
        try { window.__consolelog.push(`${Date.now()} [${level}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`); }
        catch { window.__consolelog.push(`${Date.now()} [${level}] <unserializable>`); }
        if (window.__consolelog.length > 500) window.__consolelog.shift();
      };
      for (const level of ["log", "info", "warn", "error", "debug"]) {
        const orig = console[level].bind(console);
        console[level] = (...a) => { push(level, a); orig(...a); };
      }
      window.addEventListener("error", (e) => push("uncaught", [String(e.message), e.filename + ":" + e.lineno]));
      window.addEventListener("unhandledrejection", (e) => push("rejection", [String(e.reason)]));
    });
    out({ ok: true, spy: frameArg });
  });
}

async function consoleTail(frameArg, n) {
  await withBrowser(async (browser) => {
    const frame = await resolveFrame(browser, frameArg);
    if (!frame) return out({ ok: false, error: `frame not found for ${frameArg}` });
    const lines = await frame.evaluate((count) => (window.__consolelog || []).slice(-count), n);
    out({ ok: true, lines });
  });
}

async function steps(file) {
  const list = JSON.parse(fs.readFileSync(file, "utf8"));
  const results = [];
  for (const step of list) {
    const { verb, args = [] } = step;
    // run each verb by re-dispatching, capturing its printed JSON
    const captured = await captureVerb(verb, args);
    results.push({ verb, args, result: captured });
    if (captured && captured.ok === false && !step.continueOnError) break;
  }
  out({ ok: results.every((r) => r.result && r.result.ok !== false), results });
}

/** Run one verb and RETURN its result object instead of printing (used by `steps`). */
async function captureVerb(verb, args) {
  let captured;
  const realOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { try { captured = JSON.parse(s); } catch { /* non-json */ } return true; };
  try { await dispatch(verb, args, { fromSteps: true }); }
  finally { process.stdout.write = realOut; }
  return captured;
}

// ---------- dispatch ----------

async function dispatch(verb, args, ctx = {}) {
  switch (verb) {
    case "up": {
      const o = { display: ":97", port: 9333, force: false };
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--display") o.display = args[++i];
        else if (args[i] === "--port") o.port = Number(args[++i]);
        else if (args[i] === "--force") o.force = true;
      }
      return up(o);
    }
    case "down": return down();
    case "status": return status();
    case "sleep": { await new Promise((r) => setTimeout(r, Number(args[0] || 1000))); return out({ ok: true, slept: Number(args[0] || 1000) }); }
    case "cmd": return cmd(args[0]);
    case "shot": return shot(args[0] || "shot");
    case "frames": return frames();
    case "eval": return evalIn(args[0], args[1]);
    case "click": return clickText(args[0], args[1]);
    case "click-testid": return clickTestid(args[0], args[1], args[2]);
    case "dom": return dom(args[0], args[1]);
    case "spy-console": return spyConsole(args[0]);
    case "console": return consoleTail(args[0], Number(args[1] || 50));
    case "steps": return steps(args[0]);
    default:
      if (ctx.fromSteps) { out({ ok: false, error: `unknown verb ${verb}` }); return; }
      die(`unknown verb "${verb}" — see the header of ${path.relative(REPO, fileURLToPath(import.meta.url))}`);
  }
}

const [verb, ...args] = process.argv.slice(2);
if (!verb) die("usage: headless-session.mjs <up|down|status|cmd|shot|frames|eval|click|click-testid|dom|spy-console|console|steps> …");
dispatch(verb, args).catch((e) => die(String(e && e.stack ? e.stack : e)));
