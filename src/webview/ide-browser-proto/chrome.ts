import { existsSync } from "node:fs";

const CANDIDATE_PATHS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/opt/google/chrome/chrome",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/**
 * Resolve a system Chrome/Chromium for the IDE browser prototype.
 * Honors PUPPETEER_EXECUTABLE_PATH or TACHYON_CHROME_PATH first.
 */
export function resolveIdeBrowserChrome(): string {
  const override = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.TACHYON_CHROME_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `PUPPETEER_EXECUTABLE_PATH/TACHYON_CHROME_PATH set to "${override}" but that file does not exist.`,
      );
    }
    return override;
  }
  const found = CANDIDATE_PATHS.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "No system Chrome/Chromium found for IDE Browser prototype. Install Chrome, or set " +
        "TACHYON_CHROME_PATH / PUPPETEER_EXECUTABLE_PATH to the executable.",
    );
  }
  return found;
}

export function ideBrowserHeadedPreferred(): boolean {
  const v = (process.env.TACHYON_IDE_BROWSER_HEADED || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
