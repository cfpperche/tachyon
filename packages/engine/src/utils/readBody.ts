import type http from "node:http";

/**
 * The one request-body reader for the product's HTTP doors, with named ceilings both
 * doors import (t-75f094). readJsonBody on /mcp shipped unbounded in 6bdfb77c (2026-06-09)
 * while the Companion door counted bytes from e4563ffa (SDD 414) — drift between
 * generations, closed by moving the single mechanism here so the values cannot diverge
 * silently again.
 *
 * Two sizes, because the doors carry different payloads:
 * - DEFAULT: pairing, prompt and status bodies — small structured requests.
 * - LARGE: doors carrying agent-authored artifacts (/mcp JSON-RPC tool calls, companion
 *   tab results). Declared field maxima reach 512KB (prototype HTML, workflow scripts);
 *   JSON escaping expands a realistic max-size field to ~586KB and bounds at 3MB
 *   (every char → \u00XX), so 8MB — the cap the tab-result door already used — fits the
 *   largest legitimate body with headroom.
 */
export const HTTP_BODY_LIMIT_DEFAULT_BYTES = 64 * 1024;
export const HTTP_BODY_LIMIT_LARGE_BYTES = 8 * 1024 * 1024;

export function readBody(
  req: http.IncomingMessage,
  limit = HTTP_BODY_LIMIT_DEFAULT_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
