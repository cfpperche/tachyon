/**
 * Dev Host headless INTERACTIVE harness — agent-drivable EDH with full webview access.
 *
 * The existing `dogfood:dev-host -- headless` lane runs an extensionTestsPath runner INSIDE the
 * extension host: full vscode API, but NO access to webview DOM/console (webviews are separate
 * renderer targets the host-side runner cannot see). This harness closes that gap: it launches the
 * SAME pointed Dev Host (extension + fixture mirror armed by `point`) on Xvfb with
 * `--remote-debugging-port`, then connects puppeteer-core over CDP to the workbench renderer —
 * every webview iframe becomes reachable for console capture, DOM queries, clicks, and screenshots.
 *
 * This is the "agent runs the dogfood loop end-to-end" primitive: reproduce a UI bug, watch the
 * webview console while doing it, and capture evidence — no human clicking, no GUI window.
 *
 * Usage (from monorepo root, pointer already armed via `dogfood:dev-host -- point`):
 *   node scripts/dev-host/headless-interactive.mjs --scenario scripts/dev-host/scenarios/<name>.mjs
 *   node scripts/dev-host/headless-interactive.mjs            # no scenario: boot, settle, dump targets, exit
 *
 * Options:
 *   --scenario PATH   scenario module (see Scenario contract below); default: none (boot smoke)
 *   --out DIR         output dir (default .tachyon/dev-host/interactive-out) — wiped per run
 *   --timeout SEC     hard wall clock for the whole run (default 180)
 *   --display :N      Xvfb display (default :97 — distinct from the S1 headless lane's :96)
 *   --keep            do not kill the EDH at the end (debug aid)
 *
 * Scenario contract: an ES module exporting `run(ctx)`.
 *   ctx.workbench   puppeteer Page for the VS Code workbench renderer
 *   ctx.findWebviewFrame(predicate) -> Frame|null   locate a webview iframe (e.g. Control) by
 *                    evaluating `predicate` (string of JS returning bool) inside each candidate frame
 *   ctx.command(id) run a VS Code command via the workbench Command Palette (keyboard-driven)
 *   ctx.shot(name)  CDP screenshot of the workbench page -> <out>/<name>.png
 *   ctx.log(msg)    timestamped line into <out>/driver.log (also stdout)
 *   ctx.sleep(ms)
 * Console from EVERY target (workbench + all webviews) is captured continuously into
 * <out>/console.log regardless of what the scenario does.
 *
 * Output layout (out dir): console.log · driver.log · host.log · result.json · *.png
 * result.json: { ok, scenario, startedAt, finishedAt, error?, asserts?: [...] } — asserts come from
 * whatever the scenario returns ({ asserts: [{id, ok, detail}] } shape, same as headless-runner.js).
 *
 * Documented in docs/runbooks/dev-host.md ("Interactive headless" section).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureDevHostTmuxLaunchEnv } from "./pointer.mjs";

const SELF = "dev-host-interactive";
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");

function parseArgs(argv) {
  const out = { scenario: undefined, out: undefined, timeout: 180, display: ":97", keep: false, port: 9333 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scenario") out.scenario = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--timeout") out.timeout = Number(argv[++i]) || 180;
    else if (a === "--display") out.display = argv[++i];
    else if (a === "--port") out.port = Number(argv[++i]) || 9333;
    else if (a === "--keep") out.keep = true;
    else throw new Error(`${SELF}: unknown arg ${a}`);
  }
  return out;
}

function resolveCodeBin() {
  const out = execFileSync(process.execPath, [path.join(here, "resolve-code.mjs"), REPO], { encoding: "utf8" }).trim();
  const bin = out.split("\n").filter(Boolean).pop();
  if (!bin || !fs.existsSync(bin)) throw new Error(`${SELF}: resolve-code returned no usable binary (${out})`);
  // resolve-code returns the download root's raw ELF, which on current builds is the tunnel CLI
  // ("bad option: --extensionDevelopmentPath"); the sh launcher at bin/code is what forwards app
  // args to the real Electron. Prefer it when present.
  const launcher = path.join(path.dirname(bin), "bin", "code");
  return fs.existsSync(launcher) ? launcher : bin;
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
  });
}

/**
 * spec 448 — the dev-host belongs to the checkout this script lives in, so its root is just
 * `<checkout>/.tachyon/dev-host`. This replaces an `active` → `slots/<id>/` resolution: there is
 * exactly one dev-host per checkout now, so there is nothing to select.
 */
function resolvePointerSlotRoot(repoRoot) {
  return path.join(repoRoot, ".tachyon", "dev-host");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ptr = path.join(REPO, ".tachyon", "dev-host");
  const slotRoot = resolvePointerSlotRoot(REPO);
  const extensionDir = path.join(slotRoot, "extension");
  const workspaceDir = fs.existsSync(path.join(slotRoot, "workspace"))
    ? path.join(slotRoot, "workspace")
    : path.join(ptr, "workspace");
  if (!fs.existsSync(extensionDir)) {
    throw new Error(`${SELF}: Dev Host pointer not armed (missing ${extensionDir}) — run: npm run dogfood:dev-host -- point --worktree … --fixture …`);
  }
  const extensionPath = fs.realpathSync(extensionDir);
  if (!fs.existsSync(path.join(extensionPath, "dist", "extension.js"))) {
    throw new Error(`${SELF}: pointed extension has no dist/extension.js — build it first (TACHYON_ENGINE_CHANNEL=dev npm run build in the pointed worktree)`);
  }

  const outDir = args.out ? path.resolve(args.out) : path.join(ptr, "interactive-out");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const consoleLogPath = path.join(outDir, "console.log");
  const driverLogPath = path.join(outDir, "driver.log");
  const hostLogPath = path.join(outDir, "host.log");
  fs.writeFileSync(consoleLogPath, "");
  fs.writeFileSync(driverLogPath, "");

  const log = (msg) => {
    const line = `${new Date().toISOString()} ${msg}`;
    fs.appendFileSync(driverLogPath, `${line}\n`);
    console.log(`[${SELF}] ${line}`);
  };
  const clog = (line) => fs.appendFileSync(consoleLogPath, `${new Date().toISOString()} ${line}\n`);

  const codeBin = resolveCodeBin();
  log(`code binary: ${codeBin}`);
  log(`extension:   ${extensionPath}`);
  log(`workspace:   ${workspaceDir}`);
  log(`out:         ${outDir}`);

  // ---- Xvfb ----
  let xvfb;
  try {
    execFileSync("which", ["Xvfb"]);
  } catch {
    throw new Error(`${SELF}: Xvfb required (apt install xvfb)`);
  }
  xvfb = spawn("Xvfb", [args.display, "-screen", "0", "1600x1000x24"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  if (xvfb.exitCode !== null) throw new Error(`${SELF}: Xvfb failed to start on ${args.display} (already in use?)`);
  log(`Xvfb up on ${args.display}`);

  // ---- private profile dirs (never touch the human's) ----
  const udd = path.join(outDir, "udd");
  const extDir = path.join(outDir, "extensions");
  fs.mkdirSync(path.join(udd, "User"), { recursive: true });
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(udd, "User", "settings.json"), JSON.stringify({
    "workbench.startupEditor": "none",
    "workbench.colorTheme": "Default Dark Modern",
    "update.mode": "none",
    "telemetry.telemetryLevel": "off",
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "window.dialogStyle": "custom",         // native modals would hang a headless run
    "window.newWindowDimensions": "maximized",
  }, null, 2));

  // ---- launch EDH with CDP ----
  const hostLog = fs.openSync(hostLogPath, "w");
  const child = spawn(codeBin, [
    `--extensionDevelopmentPath=${extensionPath}`,
    `--user-data-dir=${udd}`,
    `--extensions-dir=${extDir}`,
    `--remote-debugging-port=${args.port}`,
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    "--use-inmemory-secretstorage",
    "--disable-gpu",
    "--disable-updates",
    "--new-window",
    workspaceDir,
  ], {
    env: (() => {
      const env = {
        ...process.env,
        DISPLAY: args.display,
        DONT_PROMPT_WSL_INSTALL: "1",
        TACHYON_DEV_HOST: "1",
        TACHYON_DEV_HOST_ENGINE_RUNTIME: path.join(slotRoot, "runtime"),
        // Short AF_UNIX-safe path (deep worktree …/dev-host/tmux overflows sun_path).
        TMUX_TMPDIR: ensureDevHostTmuxLaunchEnv(path.resolve(slotRoot, "../..")).tmuxTmpDir,
        XDG_CACHE_HOME: path.join(slotRoot, "cache"),
        XDG_STATE_HOME: path.join(slotRoot, "state"),
        XDG_DATA_HOME: path.join(slotRoot, "data"),
      };
      // Inherited from an agent terminal these would hijack the launch: the IPC hook makes
      // bin/code forward to the HUMAN's live window's remote CLI instead of spawning our own
      // Electron; ELECTRON_RUN_AS_NODE would turn the binary into plain node.
      delete env.VSCODE_IPC_HOOK_CLI;
      delete env.ELECTRON_RUN_AS_NODE;
      return env;
    })(),
    stdio: ["ignore", hostLog, hostLog],
  });
  log(`EDH launched pid=${child.pid} cdp=${args.port}`);

  const hardDeadline = setTimeout(() => {
    log(`TIMEOUT after ${args.timeout}s — killing EDH`);
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    try { xvfb.kill(); } catch { /* gone */ }
    process.exit(3);
  }, args.timeout * 1000);

  const cleanup = () => {
    clearTimeout(hardDeadline);
    if (!args.keep) {
      try { child.kill(); } catch { /* gone */ }
    }
    try { xvfb.kill(); } catch { /* gone */ }
  };
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  const result = { ok: false, scenario: args.scenario ?? null, startedAt: new Date().toISOString() };
  try {
    // ---- wait for CDP ----
    let version;
    for (let i = 0; i < 60; i++) {
      try { version = await httpJson(`http://127.0.0.1:${args.port}/json/version`); break; }
      catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!version) throw new Error("CDP endpoint never came up — check host.log");
    log(`CDP up: ${version.Browser}`);

    const { default: puppeteer } = await import("puppeteer-core");
    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${args.port}`,
      defaultViewport: null,
      protocolTimeout: 60_000,
    });

    // ---- console capture from every target, present and future ----
    const attachConsole = async (target) => {
      try {
        const page = await target.page();
        if (!page) return;
        const url = target.url().slice(0, 120);
        page.on("console", (m) => clog(`[${m.type()}] (${url}) ${m.text()}`));
        page.on("pageerror", (e) => clog(`[pageerror] (${url}) ${e}`));
      } catch { /* some targets are not attachable — fine */ }
    };
    for (const t of browser.targets()) await attachConsole(t);
    browser.on("targetcreated", (t) => { void attachConsole(t); });

    // ---- find the workbench page ----
    let workbench;
    for (let i = 0; i < 30 && !workbench; i++) {
      const pages = await browser.pages();
      workbench = pages.find((p) => p.url().includes("workbench.html") || p.url().includes("vscode-file://"));
      if (!workbench) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!workbench) throw new Error(`no workbench page among targets: ${(await browser.pages()).map((p) => p.url()).join(", ")}`);
    log(`workbench: ${workbench.url().slice(0, 100)}`);
    await new Promise((r) => setTimeout(r, 8000)); // extension activation settle

    // ---- ctx for scenarios ----
    const ctx = {
      workbench,
      browser,
      outDir,
      log,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      shot: async (name) => {
        const file = path.join(outDir, `${name}.png`);
        await workbench.screenshot({ path: file });
        log(`shot: ${file}`);
        return file;
      },
      command: async (id) => {
        // keyboard-driven Command Palette — works regardless of UI state
        await workbench.keyboard.down("Control");
        await workbench.keyboard.down("Shift");
        await workbench.keyboard.press("KeyP");
        await workbench.keyboard.up("Shift");
        await workbench.keyboard.up("Control");
        await ctx.sleep(600);
        await workbench.keyboard.type(id, { delay: 12 });
        await ctx.sleep(800);
        await workbench.keyboard.press("Enter");
        await ctx.sleep(500);
        log(`command: ${id}`);
      },
      findWebviewFrame: async (predicate, { tries = 20, delayMs = 500 } = {}) => {
        for (let attempt = 0; attempt < tries; attempt++) {
          for (const t of browser.targets()) {
            if (t.type() !== "page" && t.type() !== "webview" && t.type() !== "other") continue;
            let page;
            try { page = await t.page(); } catch { continue; }
            if (!page) continue;
            for (const frame of page.frames()) {
              try {
                if (await frame.evaluate(predicate)) return frame;
              } catch { /* cross-origin/detached — skip */ }
            }
          }
          await new Promise((r) => setTimeout(r, delayMs));
        }
        return null;
      },
    };

    if (args.scenario) {
      const mod = await import(pathToFileURL(path.resolve(args.scenario)).href);
      if (typeof mod.run !== "function") throw new Error(`${args.scenario} does not export run(ctx)`);
      const ret = await mod.run(ctx);
      if (ret && Array.isArray(ret.asserts)) {
        result.asserts = ret.asserts;
        result.ok = ret.asserts.every((a) => a.ok);
      } else {
        result.ok = true;
      }
    } else {
      // boot smoke: settle, dump targets, one screenshot
      await ctx.shot("boot");
      const targets = browser.targets().map((t) => `${t.type()} ${t.url().slice(0, 140)}`);
      fs.writeFileSync(path.join(outDir, "targets.txt"), targets.join("\n") + "\n");
      log(`targets:\n  ${targets.join("\n  ")}`);
      result.ok = true;
    }
  } catch (err) {
    result.error = String(err && err.stack ? err.stack : err);
    log(`ERROR: ${result.error}`);
  } finally {
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
    log(`result: ok=${result.ok} → ${path.join(outDir, "result.json")}`);
    cleanup();
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`[${SELF}] fatal:`, err);
  process.exit(2);
});
