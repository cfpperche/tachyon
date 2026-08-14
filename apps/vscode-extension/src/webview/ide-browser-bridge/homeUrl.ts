/**
 * Workspace home URL for the Integrated Browser (globe status bar).
 *
 * Configured in tachyon.yml:
 *   settings:
 *     ideBrowser:
 *       homeUrl: https://my-app.local:3000
 *
 * When unset or invalid → about:blank (no fixed example.com).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

/** Product default when the workspace has not set a home URL. */
export const IDE_BROWSER_HOME_URL_FALLBACK = "about:blank";

/**
 * Normalize a user/config home URL.
 * - blank → about:blank
 * - host without scheme → https://host
 * - only http(s) and about:blank accepted
 */
export function normalizeIdeBrowserHomeUrl(raw: string | undefined | null): string {
  if (raw == null) return IDE_BROWSER_HOME_URL_FALLBACK;
  let u = String(raw).trim();
  if (!u) return IDE_BROWSER_HOME_URL_FALLBACK;
  if (u === "about:blank") return u;
  // Refuse non-browser schemes before host prefixing.
  if (/^(javascript|data|file|vbscript|blob):/i.test(u)) return IDE_BROWSER_HOME_URL_FALLBACK;
  // Bare host:port must not be parsed as a custom scheme (localhost:3000 ≠ scheme "localhost").
  if (!/^(https?:\/\/|about:)/i.test(u)) {
    u = `https://${u}`;
  }
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
    if (parsed.protocol === "about:" && parsed.pathname === "blank") return "about:blank";
  } catch {
    /* invalid */
  }
  return IDE_BROWSER_HOME_URL_FALLBACK;
}

/**
 * Normalize an explicit command/tool navigation target using the home URL policy, but report
 * rejection instead of silently claiming that the requested target opened as about:blank.
 * Bare hosts intentionally keep the home policy (`localhost:3000` → HTTPS).
 */
export function normalizeIdeBrowserNavigationUrl(raw: string): string {
  const target = String(raw).trim();
  const normalized = normalizeIdeBrowserHomeUrl(target);
  if (normalized !== IDE_BROWSER_HOME_URL_FALLBACK || target === IDE_BROWSER_HOME_URL_FALLBACK) {
    return normalized;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1]?.toLowerCase();
  if (scheme) {
    throw new Error(`IDE Browser navigation scheme '${scheme}:' is not allowed`);
  }
  throw new Error("IDE Browser navigation URL is invalid");
}

/**
 * Resolve home URL from live workspace config, else parse tachyon.yml on disk.
 */
export function resolveIdeBrowserHomeUrl(opts: {
  workspaceRoot: string;
  /** From engine-loaded TachyonConfig when available. */
  configHomeUrl?: string | undefined;
}): string {
  if (opts.configHomeUrl != null && String(opts.configHomeUrl).trim()) {
    return normalizeIdeBrowserHomeUrl(opts.configHomeUrl);
  }
  const fromFile = readHomeUrlFromTachyonYml(opts.workspaceRoot);
  return normalizeIdeBrowserHomeUrl(fromFile);
}

function readHomeUrlFromTachyonYml(workspaceRoot: string): string | undefined {
  for (const name of ["tachyon.yml", "tachyon.yaml"]) {
    const file = path.join(workspaceRoot, name);
    if (!fs.existsSync(file)) continue;
    try {
      const doc = parseYaml(fs.readFileSync(file, "utf8")) as {
        settings?: { ideBrowser?: { homeUrl?: unknown } };
      } | null;
      const home = doc?.settings?.ideBrowser?.homeUrl;
      if (typeof home === "string") return home;
    } catch {
      /* ignore parse errors — loader will surface them separately */
    }
  }
  return undefined;
}
