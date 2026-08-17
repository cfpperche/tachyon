/**
 * SDD 505 slice 8 (t-e16954) — two-width visual pass for agent-pane type sizes onto the
 * operator ramp. Distance was already clean; this is type + the two raw hexes.
 *
 * ANCHOR, written from the task problem statement BEFORE the sheet was touched
 * (journal j-ac909f083e7d). An anchor written afterwards only proves the screenshot
 * matches itself.
 *
 *   Superfície de operador. Cada tamanho vira papel da rampa pela FUNÇÃO, não pelo número.
 *   12 → --ds-operator-label1 (chrome base). 11 → --ds-operator-label2 (identidade, avisos,
 *   botões, flash). 10 → --ds-operator-label3 (glifo do inject-mark). A dobradiça 13px
 *   (--vscode-font-size) não aparece nestes 8. Hex #4ec9b0 do Pin armado fica cru: cor de
 *   sintaxe Dark+ type, a mesma de MARK_COLOR.stage, sem papel --ds. Caso da sidebar.
 *   A ÚNICA diferença aceitável é o número virar o papel cuja queda é o mesmo px (10/11/12).
 *   Nada some. Em 880 identidade e stage numa linha; em 360 os botões dobram DENTRO do pane,
 *   sem overflow horizontal. Terminal continua o maior bloco.
 *
 * Why a bespoke page: routes.ts excludes agent-pane (live pane needs node-pty). Same pattern
 * as agent-pane-terminal-theme.mjs — mount the REAL App, drive the real host protocol, load
 * the same sheets the panel loads (minus faces.css).
 *
 * The numbers are read as computed style rather than by eye: a before/after of this JSON is
 * the evidence that the deltas are the scale's and nobody else's.
 *
 * Run: `node scripts/visual-qa/agent-pane-token-scale.mjs [outDir]`
 * Screenshots land under `.vqa/` (gitignored) — never the project root.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const outDir = path.resolve(process.argv[2] ?? path.join(ROOT, ".vqa/505-slice8-agent-pane-type"));
mkdirSync(outDir, { recursive: true });

const TRANSCRIPT = [
  "\\x1b[1;36m● claude\\x1b[0m — reviewing packages/webview-ui/src/webview/agent-pane",
  "  \\x1b[32m✔\\x1b[0m type sizes now read the operator ramp",
  "",
  "\\x1b[90m> \\x1b[0mchrome stays operator; the terminal keeps the rest",
].join("\\r\\n");

await build({
  stdin: {
    contents: `
      import { render } from "preact";
      import { App } from ${JSON.stringify(path.join(ROOT, "packages/webview-ui/src/webview/agent-pane/App.tsx"))};

      const scene = new URLSearchParams(location.search).get("scene") ?? "chrome";
      let handler = () => {};
      const send = (msg) => handler(msg);

      const postMessage = (msg) => {
        if (msg.type !== "agent-pane/ready") return;
        send({
          type: "agent-pane/init",
          agent: "claude",
          session: "tachyon-ws-claude",
          title: "claude",
          status: "working",
          font: {
            fontFamily: '"DejaVu Sans Mono", "Liberation Mono", monospace',
            fontSize: 12, fontWeight: "normal", fontWeightBold: "bold", lineHeight: 1, letterSpacing: 0,
          },
        });
        send({ type: "agent-pane/data", data: "${TRANSCRIPT}\\r\\n" });
        if (scene === "detached") {
          send({ type: "agent-pane/status", status: "detached — the agent session is still running" });
          send({ type: "agent-pane/attach-state", state: "detached", reason: "ended", sessionAlive: true });
        } else if (scene === "co-attach") {
          send({ type: "agent-pane/status", status: "working" });
          send({ type: "agent-pane/attach-state", state: "attached" });
          send({ type: "agent-pane/co-attach", present: true, width: 80, height: 24 });
        } else {
          send({ type: "agent-pane/status", status: "working" });
          send({ type: "agent-pane/attach-state", state: "attached" });
          send({ type: "agent-pane/mark", kind: "stage" });
          send({ type: "agent-pane/pin-result", ok: true, message: "Pinned 3 lines to the project checklist." });
        }
        window.__paneReady = true;
      };

      render(
        <App postMessage={postMessage} onHostMessage={(h) => { handler = h; return () => {}; }} />,
        document.getElementById("root"),
      );
    `,
    resolveDir: ROOT,
    loader: "tsx",
  },
  bundle: true,
  outfile: path.join(outDir, "agent-pane-token-scale.js"),
  platform: "browser",
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "warning",
});

writeFileSync(path.join(outDir, "agent-pane-token-scale.html"), `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(ROOT, "scripts/webview-preview/theme-dark.css")}">
<link rel="stylesheet" href="${path.join(ROOT, "node_modules/@xterm/xterm/css/xterm.css")}">
<link rel="stylesheet" href="${path.join(ROOT, "packages/webview-ui/src/webview/shared/tokens.css")}">
<link rel="stylesheet" href="${path.join(ROOT, "packages/webview-ui/src/webview/shared/design-system.css")}">
<link rel="stylesheet" href="${path.join(ROOT, "packages/webview-ui/src/webview/shared/quick-picker.css")}">
<link rel="stylesheet" href="${path.join(ROOT, "packages/webview-ui/src/webview/agent-pane/agent-pane.css")}">
</head>
<body class="vscode-dark">
<div id="root"></div>
<script src="./agent-pane-token-scale.js"></script>
</body></html>`);

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--allow-file-access-from-files"],
});

const WIDTHS = [880, 360];
const SCENES = ["chrome", "detached", "co-attach"];
let failures = 0;
const report = {};

for (const scene of SCENES) {
  for (const width of WIDTHS) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 560 });
    await page.goto(`file://${path.join(outDir, "agent-pane-token-scale.html")}?scene=${scene}`, {
      waitUntil: "networkidle0",
      timeout: 45000,
    });
    await page.waitForFunction(() => window.__paneReady === true, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 500));

    if (scene === "chrome") {
      await page.evaluate(() => {
        document.querySelector(".agent-pane__btn")?.classList.add("agent-pane__btn--armed");
      });
    }

    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const root = document.getElementById("root");
      const pane = document.querySelector(".agent-pane");
      const identity = document.querySelector(".agent-pane__identity");
      const detached = document.querySelector(".agent-pane__detached");
      const coAttach = document.querySelector(".agent-pane__co-attach");
      const btn = document.querySelector(".agent-pane__btn");
      const flash = document.querySelector(".agent-pane__flash");
      const mark = document.querySelector(".agent-pane__inject-mark");
      const term = document.querySelector(".agent-pane__term");
      const stage = document.querySelector(".agent-pane__stage-actions");
      const buttons = [...document.querySelectorAll(".agent-pane__btn")];
      const rect = (el) => (el ? el.getBoundingClientRect() : null);
      const size = (el) => (el ? getComputedStyle(el).fontSize : null);
      const tokens = {
        label1: getComputedStyle(de).getPropertyValue("--ds-operator-label1").trim(),
        label2: getComputedStyle(de).getPropertyValue("--ds-operator-label2").trim(),
        label3: getComputedStyle(de).getPropertyValue("--ds-operator-label3").trim(),
      };
      return {
        tokens,
        sizes: {
          root: size(root),
          pane: size(pane),
          identity: size(identity),
          detached: size(detached),
          coAttach: size(coAttach),
          btn: size(btn),
          flash: size(flash),
          mark: size(mark),
        },
        armed: btn?.classList.contains("agent-pane__btn--armed")
          ? { color: getComputedStyle(btn).color, borderColor: getComputedStyle(btn).borderColor }
          : null,
        termHeight: rect(term)?.height ?? 0,
        bannerHeight: rect(detached || coAttach)?.height ?? 0,
        stageTop: rect(stage)?.top ?? 0,
        paneHeight: rect(pane)?.height ?? 0,
        pageScrollW: de.scrollWidth,
        pageClientW: de.clientWidth,
        buttonsInside: buttons.every((b) => {
          const r = b.getBoundingClientRect();
          return r.right <= de.clientWidth + 0.5 && r.left >= -0.5;
        }),
        identityOneRow: identity ? identity.getBoundingClientRect().height < 28 : null,
      };
    });

    const expect = {
      root: "12px",
      pane: "12px",
      identity: "11px",
      btn: "11px",
    };
    if (scene === "detached") expect.detached = "11px";
    if (scene === "co-attach") expect.coAttach = "11px";
    if (scene === "chrome") {
      expect.flash = "11px";
      expect.mark = "10px";
    }

    const checks = {
      "label tokens live (fallbacks 12/11/10)":
        m.tokens.label1 === "12px" && m.tokens.label2 === "11px" && m.tokens.label3 === "10px",
      "A4 no horizontal overflow": m.pageScrollW <= m.pageClientW,
      "A4 stage buttons stay inside the pane": m.buttonsInside,
      "terminal keeps height": m.termHeight > 150,
    };
    if (width === 880) {
      checks["A4 identity stays one row at 880"] = m.identityOneRow === true;
    }
    for (const [key, want] of Object.entries(expect)) {
      checks[`${scene} ${key} font-size ${want}`] = m.sizes[key] === want;
    }
    if (scene === "chrome" && m.armed) {
      checks["armed Pin keeps raw #4ec9b0"] =
        m.armed.color === "rgb(78, 201, 176)" && m.armed.borderColor.includes("78, 201, 176");
    }

    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    if (failed.length) failures += 1;

    const shot = path.join(outDir, `agent-pane-type-${scene}-${width}.png`);
    await page.screenshot({ path: shot });
    const key = `${scene}@${width}`;
    report[key] = {
      checks,
      failed,
      sizes: m.sizes,
      tokens: m.tokens,
      armed: m.armed,
      termHeight: Math.round(m.termHeight),
      bannerHeight: Math.round(m.bannerHeight),
      overflow: `${m.pageScrollW}/${m.pageClientW}`,
      shot: path.relative(ROOT, shot),
    };
    console.log(
      `${failed.length ? "FAIL" : "PASS"} ${key} `
      + `root=${m.sizes.root} id=${m.sizes.identity} btn=${m.sizes.btn} `
      + `term=${Math.round(m.termHeight)}px scrollW=${m.pageScrollW}/${m.pageClientW}`
      + `${failed.length ? ` → ${failed.join(", ")}` : ""}`,
    );
    await page.close();
  }
}

await browser.close();
writeFileSync(path.join(outDir, "measurements.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(failures === 0
  ? `\nVISUAL QA PASS — ${SCENES.length * WIDTHS.length}/${SCENES.length * WIDTHS.length} against the t-e16954 anchor`
  : `\nVISUAL QA FAIL — ${failures} of ${SCENES.length * WIDTHS.length}`);
process.exit(failures ? 1 : 0);
