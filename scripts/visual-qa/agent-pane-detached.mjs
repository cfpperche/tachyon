/**
 * `t-feaaea` — Visual QA for the Agent Pane's DETACHED state.
 *
 * ANCHOR (written from the task's problem statement, before the banner existed — not from what the
 * screen ended up looking like). The reported experience is: the pane fills with `·`, then says
 * `attach ended (signal 0)` and tells the human to reopen it. What the screen must do instead:
 *
 *  A1. Say, in the reader's terms, that the AGENT KEPT RUNNING and only this view stopped. No exit
 *      code, no signal number, no tmux vocabulary as the primary message.
 *  A2. Offer one obvious way back in, on screen, without the human knowing which sidebar icon
 *      reopens the pane.
 *  A3. Never bury the terminal: the transcript stays the biggest thing in the pane, so the banner
 *      cannot be what the pane becomes.
 *  A4. Hold at BOTH widths. At 360 the banner wraps and the Reattach control stays fully inside the
 *      pane — a control that leaves the viewport is the same as no control.
 *
 * Why a bespoke page instead of the preview catalog: `scripts/webview-preview/routes.ts` excludes
 * `agent-pane` because the live pane needs a node-pty attach to a tmux session. The DETACHED state
 * needs no attach at all — so this mounts the REAL `App` component with the real stylesheet and
 * drives it through the real host→webview protocol. Nothing here re-implements the markup; a
 * hand-copied mock would only prove the screenshot matches itself.
 *
 * Run: `node scripts/visual-qa/agent-pane-detached.mjs`   (screenshots land in `.vqa/`, gitignored)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUT = path.join(ROOT, ".vqa");
mkdirSync(OUT, { recursive: true });

// A realistic transcript so the banner is judged against a pane with content in it, not an empty box.
const TRANSCRIPT = [
  "\\x1b[1;36m● claude\\x1b[0m — reviewing src/presentation/Terminals.ts",
  "  \\x1b[32m✔\\x1b[0m read 3 files",
  "  \\x1b[32m✔\\x1b[0m ran 14 unit tests",
  "",
  "\\x1b[90m> \\x1b[0mkeep going with the handoff path",
].join("\\r\\n");

await build({
  stdin: {
    contents: `
      import { render } from "preact";
      import { App } from ${JSON.stringify(path.join(ROOT, "src/webview/agent-pane/App.tsx"))};

      const reason = new URLSearchParams(location.search).get("reason") ?? "handoff";
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
        // The state under test — exactly what AgentPanePanel.ts posts on handoff / clean exit.
        send({ type: "agent-pane/status", status: reason === "handoff"
          ? "detached — the integrated terminal has this session"
          : "detached — the agent session is still running" });
        send({ type: "agent-pane/attach-state", state: "detached", reason, sessionAlive: true });
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
  outfile: path.join(OUT, "agent-pane-detached.js"),
  platform: "browser",
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "warning",
});

writeFileSync(path.join(OUT, "agent-pane-detached.html"), `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(ROOT, "node_modules/@xterm/xterm/css/xterm.css")}">
<link rel="stylesheet" href="${path.join(ROOT, "src/webview/agent-pane/agent-pane.css")}">
</head><body><div id="root"></div><script src="./agent-pane-detached.js"></script></body></html>
`);

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--allow-file-access-from-files"],
});

const WIDTHS = [880, 360];
const REASONS = ["handoff", "ended"];
let failures = 0;

for (const reason of REASONS) {
  for (const width of WIDTHS) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 560 });
    await page.goto(`file://${path.join(OUT, "agent-pane-detached.html")}?reason=${reason}`, {
      waitUntil: "networkidle0",
      timeout: 45000,
    });
    await page.waitForFunction(() => window.__paneReady === true, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 500));

    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const banner = document.querySelector(".agent-pane__detached");
      const text = document.querySelector(".agent-pane__detached-text");
      const btn = [...document.querySelectorAll(".agent-pane__btn")].find((b) => b.textContent?.trim() === "Reattach");
      const term = document.querySelector(".agent-pane__term");
      const pane = document.querySelector(".agent-pane");
      const rect = (el) => (el ? el.getBoundingClientRect() : null);
      const b = rect(btn);
      return {
        rendered: !!banner && !!term,
        message: text?.textContent?.trim() ?? "",
        button: b ? { top: b.top, right: b.right, height: b.height, width: b.width } : null,
        termHeight: rect(term)?.height ?? 0,
        paneHeight: rect(pane)?.height ?? 0,
        bannerHeight: rect(banner)?.height ?? 0,
        pageScrollW: de.scrollWidth,
        pageClientW: de.clientWidth,
      };
    });

    // A1/A2 are about words and affordance; A3/A4 are geometry. Each maps to one anchor line.
    const checks = {
      "A1 says the agent kept running": /kept running|still running|no longer running/.test(m.message),
      "A1 no exit-code/signal vocabulary": !/signal|exit code/i.test(m.message),
      "A2 Reattach control present": !!m.button,
      "A3 terminal keeps most of the pane": m.termHeight > m.bannerHeight * 2 && m.termHeight > 150,
      "A4 control fully inside the pane": !!m.button && m.button.right <= m.pageClientW + 0.5 && m.button.height >= 18,
      "A4 no horizontal page overflow": m.pageScrollW <= m.pageClientW,
      precondition_rendered: m.rendered,
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    if (failed.length) failures += 1;

    const shot = path.join(OUT, `agent-pane-detached-${reason}-${width}.png`);
    await page.screenshot({ path: shot });
    console.log(
      `${failed.length ? "FAIL" : "PASS"} reason=${reason} @${width}px `
      + `term=${Math.round(m.termHeight)}px banner=${Math.round(m.bannerHeight)}px `
      + `btnRight=${m.button ? Math.round(m.button.right) : "—"} scrollW=${m.pageScrollW}/${m.pageClientW}`
      + `${failed.length ? ` → ${failed.join(", ")}` : ""}`,
    );
    console.log(`     message: ${JSON.stringify(m.message)}`);
    console.log(`     shot: ${path.relative(ROOT, shot)}`);
    await page.close();
  }
}

await browser.close();
console.log(failures === 0
  ? `\nVISUAL QA PASS — ${REASONS.length * WIDTHS.length}/${REASONS.length * WIDTHS.length} against the t-feaaea anchor`
  : `\nVISUAL QA FAIL — ${failures} of ${REASONS.length * WIDTHS.length}`);
process.exit(failures ? 1 : 0);
