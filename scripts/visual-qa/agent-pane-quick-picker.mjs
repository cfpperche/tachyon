/**
 * t-de3dfc — Agent Pane QuickPicker keyboard isolation + two-width visual evidence.
 *
 * ANCHOR (written before the picker was wired into the pane): the prompt-template and delivery
 * questions belong in the Agent Pane chrome that raised them. The picker must sit clearly above
 * the live terminal, retain the product QuickPicker hierarchy/filter/key legend, stay within the
 * pane at 880px and 360px, and leave the terminal transcript and stage controls recognisable behind
 * it. While open, filter text, arrows, Enter, and Escape must be consumed by the picker — none may
 * reach xterm's agent-pane/input channel.
 *
 * Before the production wiring exists, run with `--risk-only`: this mounts the real Agent Pane and
 * real QuickPicker together solely to settle the keyboard-leakage precondition. The default mode
 * opens the picker through the real Template button/host-message door.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUT = path.join(ROOT, ".vqa", "t-de3dfc");
const riskOnly = process.argv.includes("--risk-only");
mkdirSync(OUT, { recursive: true });

await build({
  stdin: {
    contents: `
      import { render } from "preact";
      import { useState } from "preact/hooks";
      import { App } from ${JSON.stringify(path.join(ROOT, "packages/webview-ui/src/webview/agent-pane/App.tsx"))};
      import { QuickPicker } from ${JSON.stringify(path.join(ROOT, "packages/webview-ui/src/webview/shared/ui/QuickPicker.tsx"))};

      let handler = () => {};
      const messages = [];
      window.__messages = messages;
      const templates = [
        { id: "review", label: "Review the current change", description: "review", detail: "Inspect correctness and regressions" },
        { id: "handoff", label: "Write a concise handoff", description: "handoff", detail: "Summarize state and next action" },
      ];

      function Harness() {
        const [riskOpen, setRiskOpen] = useState(${riskOnly ? "true" : "false"});
        const postMessage = (msg) => {
          messages.push(msg);
          if (msg.type === "agent-pane/ready") {
            handler({ type: "agent-pane/init", agent: "claude", session: "tachyon-ws-claude", title: "claude", status: "working", font: {
              fontFamily: '"DejaVu Sans Mono", monospace', fontSize: 12, fontWeight: "normal", fontWeightBold: "bold", lineHeight: 1, letterSpacing: 0,
            }});
            handler({ type: "agent-pane/data", data: "\\x1b[1;36m● claude\\x1b[0m — reviewing the prompt flow\\r\\n  ready for input\\r\\n" });
          }
          if (${riskOnly ? "false" : "true"} && msg.type === "agent-pane/inject-template") {
            handler({ type: "agent-pane/picker", requestId: "visual-template", title: "Inject prompt template", placeholder: "Choose a template", items: templates });
          }
        };
        return <>
          <App postMessage={postMessage} onHostMessage={(h) => { handler = h; return () => {}; }} />
          ${riskOnly ? `<QuickPicker open={riskOpen} data-testid="agent-pane-template-picker" title="Inject prompt template" placeholder="Choose a template" items={templates} onClose={() => setRiskOpen(false)} onSelect={(item) => { messages.push({ type: "risk/select", id: item.id }); setRiskOpen(false); }} />` : ""}
        </>;
      }
      render(<Harness />, document.getElementById("root"));
    `,
    resolveDir: ROOT,
    loader: "tsx",
  },
  bundle: true,
  outfile: path.join(OUT, "agent-pane-quick-picker.js"),
  platform: "browser",
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "warning",
});

writeFileSync(path.join(OUT, "agent-pane-quick-picker.html"), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(ROOT, "node_modules/@xterm/xterm/css/xterm.css")}">
<link rel="stylesheet" href="${path.join(ROOT, "packages/webview-ui/src/webview/shared/quick-picker.css")}">
<link rel="stylesheet" href="${path.join(ROOT, "packages/webview-ui/src/webview/agent-pane/agent-pane.css")}">
</head><body><div id="root"></div><script src="./agent-pane-quick-picker.js"></script></body></html>`);

const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--disable-gpu", "--allow-file-access-from-files"] });
const report = [];
for (const width of [880, 360]) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 620 });
  await page.goto(`file://${path.join(OUT, "agent-pane-quick-picker.html")}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".xterm-screen", { timeout: 15000 });
  if (!riskOnly) {
    await page.screenshot({ path: path.join(OUT, `before-agent-pane-${width}.png`) });
    await page.click('button[title="Open prompt template picker (spec 381)"]');
  }
  await page.waitForSelector('[data-testid="agent-pane-template-picker-filter"]', { visible: true, timeout: 5000 });
  if (!riskOnly) {
    const shot = path.join(OUT, `after-agent-pane-${width}.png`);
    await page.screenshot({ path: shot });
  }
  await page.focus('[data-testid="agent-pane-template-picker-filter"]');
  const before = await page.evaluate(() => window.__messages.length);
  await page.keyboard.type("hand");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await page.keyboard.press("ArrowDown");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await page.keyboard.press("ArrowUp");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await page.keyboard.press("Enter");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const afterEnter = await page.evaluate((n) => window.__messages.slice(n), before);
  const leakedEnter = afterEnter.filter((m) => m.type === "agent-pane/input");
  const selected = afterEnter.some((m) => m.type === "risk/select" || (m.type === "agent-pane/picker-result" && m.selectedId));

  if (riskOnly) await page.reload({ waitUntil: "networkidle0" });
  else {
    await page.click('button[title="Open prompt template picker (spec 381)"]');
    await page.waitForSelector('[data-testid="agent-pane-template-picker-filter"]', { visible: true });
  }
  const beforeEscape = await page.evaluate(() => window.__messages.length);
  await page.keyboard.press("Escape");
  const afterEscape = await page.evaluate((n) => window.__messages.slice(n), beforeEscape);
  const leakedEscape = afterEscape.filter((m) => m.type === "agent-pane/input");
  const closed = await page.$('[data-testid="agent-pane-template-picker"]') === null;
  report.push({ width, leakedEnter, leakedEscape, selected, closed });
  await page.close();
}
await browser.close();
writeFileSync(path.join(OUT, `${riskOnly ? "risk-only" : "after"}-keyboard-report.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
const failed = report.some((r) => r.leakedEnter.length || r.leakedEscape.length || !r.selected || !r.closed);
process.exit(failed ? 1 : 0);
