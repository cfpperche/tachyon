import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Stable per-workspace Bridge token. Lives in the extension's global storage —
 * outside the repo and the workspace, never in a committable file. Registered
 * runtime configs reference it via the TACHYON_BRIDGE_TOKEN env var, which
 * Tachyon injects into every agent session it spawns.
 *
 * Honest threat model: this raises the bar against generic local port scanners
 * and accidents; same-user targeted malware could still read the storage file.
 */
export function loadOrCreateToken(storageDir: string, wsHash: string): string {
  fs.mkdirSync(storageDir, { recursive: true });
  const file = path.join(storageDir, `bridge-token-${wsHash}`);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    // not created yet
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

/** Constant-time bearer comparison (hash both sides to fixed length first). */
export function tokenMatches(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const a = crypto.createHash("sha256").update(received).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export const TOKEN_ENV_VAR = "TACHYON_BRIDGE_TOKEN";
export const URL_ENV_VAR = "TACHYON_BRIDGE_URL";
/** spec 351 — the per-agent minted token, injected ALONGSIDE (never instead of) TOKEN_ENV_VAR: an
 *  agent's MCP config prefers this one; the old shared var stays for human/legacy fallback during the
 *  compat window. */
export const AGENT_TOKEN_ENV_VAR = "TACHYON_AGENT_BRIDGE_TOKEN";
