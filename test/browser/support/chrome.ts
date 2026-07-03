import { existsSync } from "node:fs";

// spec 342 — system Chrome detection for the compat-gate browser tests. puppeteer-core (chosen over full
// puppeteer/playwright per plan.md — no bundled browser download) needs an explicit executablePath; this
// resolves it the same way a dev host actually has Chrome installed, honoring an env override first.
const CANDIDATE_PATHS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/opt/google/chrome/chrome",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/** Resolve a system Chrome/Chromium executable, or throw with a message that says exactly what to set. */
export function resolveChromeExecutable(): string {
  const override = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.TACHYON_CHROME_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`PUPPETEER_EXECUTABLE_PATH/TACHYON_CHROME_PATH set to "${override}" but that file does not exist.`);
    }
    return override;
  }
  const found = CANDIDATE_PATHS.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "No system Chrome/Chromium found for the ui-gate browser tests. Install Google Chrome, or set " +
        "PUPPETEER_EXECUTABLE_PATH to its executable.",
    );
  }
  return found;
}
