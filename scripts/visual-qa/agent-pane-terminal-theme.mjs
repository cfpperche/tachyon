/**
 * SDD 505 slice 8 (t-5554b4) — two-width, two-theme visual pass for the agent-pane terminal.
 *
 * ANCHOR: docs/specs/505-design-system-audit/visual-qa-agent-pane-anchor.md
 * Written from the task's problem statement BEFORE this session edited a pixel.
 *
 *   A1. The terminal is not a Dark+ rectangle inside a light editor. Background/foreground come
 *       from the editor theme; ANSI-16 come from --vscode-terminal-ansi*.
 *   A2. Theme read, not a redesign. An indistinguishable pair is a finding, not a defect to invent around.
 *   A3. Chrome uses shared --ds-*. No private --agent-pane-* palette, no hand-copied --ds-1…4.
 *   A4. Hold at 880 and 360 in BOTH themes. At 360 stage actions wrap inside the pane.
 *   A5. Inject-marker hexes are not the 21-colour palette.
 *
 * Why a bespoke page: routes.ts excludes agent-pane (live pane needs node-pty). Same pattern as
 * agent-pane-detached.mjs — mount the REAL App, drive the real host protocol, load the same
 * sheets the panel loads (minus faces.css, which is the actual restriction).
 *
 * Run: `node scripts/visual-qa/agent-pane-terminal-theme.mjs [outDir]`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const outDir = path.resolve(process.argv[2] ?? path.join(ROOT, ".vqa/505-slice8-agent-pane"));
mkdirSync(outDir, { recursive: true });

const ANSI_LINE = [
  "\\x1b[30mblack\\x1b[0m \\x1b[31mred\\x1b[0m \\x1b[32mgreen\\x1b[0m \\x1b[33myellow\\x1b[0m \\x1b[34mblue\\x1b[0m \\x1b[35mmagenta\\x1b[0m \\x1b[36mcyan\\x1b[0m \\x1b[37mwhite\\x1b[0m",
  "\\x1b[90mbrightBlack\\x1b[0m \\x1b[91mbrightRed\\x1b[0m \\x1b[92mbrightGreen\\x1b[0m \\x1b[93mbrightYellow\\x1b[0m",
  "\\x1b[94mbrightBlue\\x1b[0m \\x1b[95mbrightMagenta\\x1b[0m \\x1b[96mbrightCyan\\x1b[0m \\x1b[97mbrightWhite\\x1b[0m",
].join("\\r\\n");

const TRANSCRIPT = [
  "\\x1b[1;36m● claude\\x1b[0m — reviewing packages/webview-ui/src/webview/agent-pane",
  "  \\x1b[32m✔\\x1b[0m sampled --vscode-terminal-ansi*",
  "",
  ANSI_LINE,
  "",
  "\\x1b[90m> \\x1b[0mthe terminal follows the editor theme",
].join("\\r\\n");

await build({
  stdin: {
    contents: `
      import { render } from "preact";
      import { App } from ${JSON.stringify(path.join(ROOT, "packages/webview-ui/src/webview/agent-pane/App.tsx"))};
      import { terminalThemeFromComputedStyle, indistinguishableColorPairs } from ${JSON.stringify(path.join(ROOT, "packages/webview-ui/src/webview/agent-pane/terminalTheme.ts"))};

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
        send({ type: "agent-pane/status", status: "working" });
        send({ type: "agent-pane/attach-state", state: "attached" });
        window.__sampledTheme = terminalThemeFromComputedStyle(getComputedStyle(document.documentElement));
        window.__pairs = indistinguishableColorPairs(window.__sampledTheme);
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
  outfile: path.join(outDir, "agent-pane-terminal-theme.js"),
  platform: "browser",
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "warning",
});

function htmlFor(theme) {
  const themeHref = path.join(ROOT, `scripts/webview-preview/theme-${theme}.css`);
  return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${themeHref}">
<link rel="stylesheet" href="${path.join(ROOT, "node_modules/@xterm/xterm/css/xterm.css")}">
<link rel="stylesheet" href="${path.join(ROOT, "packages/webview-ui/src/webview/shared/tokens.css")}">
<link rel="stylesheet" href="${path.join(ROOT, "packages/webview-ui/src/webview/shared/design-system.css")}">
<link rel="stylesheet" href="${path.join(ROOT, "packages/webview-ui/src/webview/shared/quick-picker.css")}">
<link rel="stylesheet" href="${path.join(ROOT, "packages/webview-ui/src/webview/agent-pane/agent-pane.css")}">
</head>
<body class="vscode-${theme === "light" ? "light" : "dark"}">
<div id="root"></div>
<script src="./agent-pane-terminal-theme.js"></script>
</body></html>`;
}

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--allow-file-access-from-files"],
});

const WIDTHS = [880, 360];
const THEMES = ["dark", "light"];
let failures = 0;
const report = {};

for (const theme of THEMES) {
  writeFileSync(path.join(outDir, `agent-pane-terminal-theme-${theme}.html`), htmlFor(theme));
  for (const width of WIDTHS) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 560 });
    await page.goto(`file://${path.join(outDir, `agent-pane-terminal-theme-${theme}.html`)}`, {
      waitUntil: "networkidle0",
      timeout: 45000,
    });
    await page.waitForFunction(() => window.__paneReady === true, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 500));

    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const rootStyle = getComputedStyle(de);
      const pane = document.querySelector(".agent-pane");
      const agent = document.querySelector(".agent-pane__agent");
      const term = document.querySelector(".agent-pane__term");
      const stage = document.querySelector(".agent-pane__stage-actions");
      const buttons = [...document.querySelectorAll(".agent-pane__btn")];
      const rect = (el) => (el ? el.getBoundingClientRect() : null);
      const declared = [...de.style].concat(
        [...document.styleSheets].flatMap((sheet) => {
          try {
            return [...sheet.cssRules].flatMap((rule) =>
              rule.selectorText === ":root" ? [...rule.style] : [],
            );
          } catch {
            return [];
          }
        }),
      );
      return {
        editorBg: rootStyle.getPropertyValue("--vscode-editor-background").trim(),
        editorFg: rootStyle.getPropertyValue("--vscode-editor-foreground").trim(),
        dsFg: rootStyle.getPropertyValue("--ds-fg").trim(),
        ds1: rootStyle.getPropertyValue("--ds-1").trim(),
        paneBg: pane ? getComputedStyle(pane).backgroundColor : "",
        agentColor: agent ? getComputedStyle(agent).color : "",
        termHeight: rect(term)?.height ?? 0,
        stageTop: rect(stage)?.top ?? 0,
        paneHeight: rect(pane)?.height ?? 0,
        pageScrollW: de.scrollWidth,
        pageClientW: de.clientWidth,
        buttonsInside: buttons.every((b) => {
          const r = b.getBoundingClientRect();
          return r.right <= de.clientWidth + 0.5 && r.left >= -0.5;
        }),
        privatePaneTokens: declared.filter((name) => name.startsWith("--agent-pane-")),
        sampled: window.__sampledTheme ?? null,
        pairs: window.__pairs ?? [],
      };
    });

    const sampledBg = (m.sampled?.background ?? "").toLowerCase();
    const editorBg = m.editorBg.toLowerCase();
    const checks = {
      "A1 sampled background is the editor theme": sampledBg === editorBg && editorBg.length > 0,
      "A1 Light+ is not Dark+ #1e1e1e": theme === "dark" || sampledBg !== "#1e1e1e",
      "A1 ANSI green came from the theme var": Boolean(m.sampled?.green),
      "A3 no private --agent-pane-* on :root": m.privatePaneTokens.length === 0,
      "A3 --ds-1 is live (not a pane-local copy we have to redeclare)": m.ds1 === "4px",
      "A4 terminal keeps height": m.termHeight > 150,
      "A4 no horizontal overflow": m.pageScrollW <= m.pageClientW,
      "A4 stage buttons stay inside the pane": m.buttonsInside,
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    if (failed.length) failures += 1;

    const shot = path.join(outDir, `agent-pane-theme-${theme}-${width}.png`);
    await page.screenshot({ path: shot });
    const key = `${theme}@${width}`;
    report[key] = {
      checks,
      failed,
      editorBg: m.editorBg,
      sampledBackground: m.sampled?.background ?? null,
      sampledForeground: m.sampled?.foreground ?? null,
      pairs: m.pairs,
      termHeight: Math.round(m.termHeight),
      shot: path.relative(ROOT, shot),
    };
    console.log(
      `${failed.length ? "FAIL" : "PASS"} ${key} bg=${m.sampled?.background} pairs=${m.pairs.length} `
      + `term=${Math.round(m.termHeight)}px scrollW=${m.pageScrollW}/${m.pageClientW}`
      + `${failed.length ? ` → ${failed.join(", ")}` : ""}`,
    );
    await page.close();
  }
}

await browser.close();
writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(failures === 0
  ? `\nVISUAL QA PASS — ${THEMES.length * WIDTHS.length}/${THEMES.length * WIDTHS.length} against the t-5554b4 anchor`
  : `\nVISUAL QA FAIL — ${failures} of ${THEMES.length * WIDTHS.length}`);
process.exit(failures ? 1 : 0);
