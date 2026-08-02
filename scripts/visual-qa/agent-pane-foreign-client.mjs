/**
 * `t-edbe36` — Visual QA for the Agent Pane's FOREIGN CO-ATTACH notice.
 *
 * ANCHOR (from the task problem statement, before the banner existed):
 *
 *  A1. Name what is happening in the reader's terms: another terminal outside Tachyon is
 *      attached and is driving a smaller size. No tmux command jargon as the primary sentence.
 *  A2. Say the dotted padding is TEMPORARY and the WORK IS SAFE — an alarm without that
 *      reassurance is worse than silence.
 *  A3. Never bury the terminal: the co-attach strip cannot become the pane.
 *  A4. Hold at BOTH widths (880 and 360). At 360 the full sentence wraps inside the pane with
 *      no horizontal page overflow.
 *
 * Same harness pattern as agent-pane-detached.mjs: mount the REAL App + stylesheet and drive
 * the real host→webview protocol. No hand-copied mock.
 *
 * Run: `node scripts/visual-qa/agent-pane-foreign-client.mjs`
 * Screenshots land in `.vqa/` (gitignored).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUT = path.join(ROOT, ".vqa");
mkdirSync(OUT, { recursive: true });

const TRANSCRIPT = [
  "\\x1b[1;36m● claude\\x1b[0m — reviewing src/presentation/sessionViewport.ts",
  "  \\x1b[32m✔\\x1b[0m read 2 files",
  "",
  "\\x1b[90m············ (tmux padding while a smaller client is attached) ············\\x1b[0m",
  "\\x1b[90m> \\x1b[0mkeep the work going",
].join("\\r\\n");

await build({
  stdin: {
    contents: `
      import { render } from "preact";
      import { App } from ${JSON.stringify(path.join(ROOT, "src/webview/agent-pane/App.tsx"))};

      let handler = () => {};
      const send = (msg) => handler(msg);

      const postMessage = (msg) => {
        if (msg.type !== "agent-pane/ready") return;
        send({
          type: "agent-pane/init",
          agent: "claude",
          session: "tachyon-ws-claude",
          title: "claude",
          status: "connecting…",
          font: {
            fontFamily: '"DejaVu Sans Mono", "Liberation Mono", monospace',
            fontSize: 12, fontWeight: "normal", fontWeightBold: "bold", lineHeight: 1, letterSpacing: 0,
          },
        });
        send({ type: "agent-pane/data", data: "${TRANSCRIPT}\\r\\n" });
        // Host identity strip + co-attach state — exactly what AgentPanePanel posts.
        send({
          type: "agent-pane/status",
          status: "another tmux client (80×24) is attached — temporary; work is safe",
        });
        send({ type: "agent-pane/attach-state", state: "attached" });
        send({ type: "agent-pane/co-attach", present: true, width: 80, height: 24 });
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
  outfile: path.join(OUT, "agent-pane-foreign-client.js"),
  platform: "browser",
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "warning",
});

writeFileSync(path.join(OUT, "agent-pane-foreign-client.html"), `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(ROOT, "node_modules/@xterm/xterm/css/xterm.css")}">
<link rel="stylesheet" href="${path.join(ROOT, "src/webview/agent-pane/agent-pane.css")}">
</head><body><div id="root"></div><script src="./agent-pane-foreign-client.js"></script></body></html>
`);

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--allow-file-access-from-files"],
});

const WIDTHS = [880, 360];
let failures = 0;

for (const width of WIDTHS) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 560 });
  await page.goto(`file://${path.join(OUT, "agent-pane-foreign-client.html")}`, {
    waitUntil: "networkidle0",
    timeout: 45000,
  });
  await page.waitForFunction(() => window.__paneReady === true, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 500));

  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const banner = document.querySelector(".agent-pane__co-attach");
    const text = document.querySelector(".agent-pane__co-attach-text");
    const status = document.querySelector(".agent-pane__status");
    const term = document.querySelector(".agent-pane__term");
    const pane = document.querySelector(".agent-pane");
    const rect = (el) => (el ? el.getBoundingClientRect() : null);
    return {
      rendered: !!banner && !!term,
      message: text?.textContent?.trim() ?? "",
      status: status?.textContent?.trim() ?? "",
      termHeight: rect(term)?.height ?? 0,
      paneHeight: rect(pane)?.height ?? 0,
      bannerHeight: rect(banner)?.height ?? 0,
      pageScrollW: de.scrollWidth,
      pageClientW: de.clientWidth,
    };
  });

  const checks = {
    "A1 names another terminal / size": /another terminal|80×24|80x24/i.test(m.message),
    "A2 says temporary": /temporary/i.test(m.message) || /temporary/i.test(m.status),
    "A2 says work is safe": /safe/i.test(m.message) || /safe/i.test(m.status),
    "A1 no kill/evict vocabulary": !/kill|evict|lost|ended/i.test(m.message),
    "A3 terminal keeps most of the pane": m.termHeight > m.bannerHeight * 2 && m.termHeight > 150,
    "A4 no horizontal page overflow": m.pageScrollW <= m.pageClientW,
    precondition_rendered: m.rendered,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) failures += 1;

  const shot = path.join(OUT, `agent-pane-foreign-client-${width}.png`);
  await page.screenshot({ path: shot });
  console.log(
    `${failed.length ? "FAIL" : "PASS"} @${width}px `
    + `term=${Math.round(m.termHeight)}px banner=${Math.round(m.bannerHeight)}px `
    + `scrollW=${m.pageScrollW}/${m.pageClientW}`
    + `${failed.length ? ` → ${failed.join(", ")}` : ""}`,
  );
  console.log(`     status: ${JSON.stringify(m.status)}`);
  console.log(`     message: ${JSON.stringify(m.message)}`);
  console.log(`     shot: ${path.relative(ROOT, shot)}`);
  await page.close();
}

await browser.close();
console.log(failures === 0
  ? `\nVISUAL QA PASS — ${WIDTHS.length}/${WIDTHS.length} against the t-edbe36 anchor`
  : `\nVISUAL QA FAIL — ${failures} of ${WIDTHS.length}`);
process.exit(failures ? 1 : 0);
