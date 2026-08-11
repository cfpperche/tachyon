/** t-de3dfc — before/after evidence for two neighbours of the shared picker/token split. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUT = path.join(ROOT, ".vqa", "t-de3dfc");
const PORT = process.env.PREVIEW_PORT ?? "4187";
mkdirSync(OUT, { recursive: true });

const designPath = path.join(ROOT, "dist/webview/design-system.css");
const pickerPath = path.join(ROOT, "dist/webview/quick-picker.css");
const afterDesign = readFileSync(designPath);
const afterPicker = readFileSync(pickerPath);
const beforeDesign = execFileSync("git", ["show", "HEAD:src/webview/shared/design-system.css"], { cwd: ROOT });

const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--disable-gpu"] });
const cases = [
  { view: "sidebar", fixture: "multi-project" },
  { view: "activity", fixture: "default" },
];
try {
  for (const phase of ["before", "after"]) {
    writeFileSync(designPath, phase === "before" ? beforeDesign : afterDesign);
    writeFileSync(pickerPath, phase === "before" ? "" : afterPicker);
    for (const { view, fixture } of cases) {
      for (const width of [880, 360]) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 900 });
        await page.goto(`http://localhost:${PORT}/scripts/webview-preview/index.html?view=${view}&fixture=${fixture}`, { waitUntil: "networkidle0", timeout: 45000 });
        await page.waitForSelector(`body[data-preview-view="${view}"]`, { timeout: 10000 });
        await page.screenshot({ path: path.join(OUT, `${phase}-${view}-${width}.png`) });
        await page.close();
      }
    }
  }
} finally {
  writeFileSync(designPath, afterDesign);
  writeFileSync(pickerPath, afterPicker);
  await browser.close();
}
