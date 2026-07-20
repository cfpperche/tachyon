/**
 * Loopback HTTP surface for Tachyon Companion (SDD 414).
 * Mounted on the Bridge listener at /companion/v1/* — companion auth, not Bridge agent tokens.
 */

import type http from "node:http";
import type { CompanionPairingService } from "./CompanionPairingService.js";
import {
  COMPANION_HTTP_PREFIX,
  COMPANION_PROTOCOL_VERSION,
  type CompanionWorkspaceOps,
  type PairRequestBody,
  type SendPromptRequest,
} from "./protocol.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
};

export interface CompanionHttpSurface {
  pairing: CompanionPairingService;
  ops?: CompanionWorkspaceOps;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...CORS,
  });
  res.end(payload);
}

function bearer(req: http.IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return undefined;
  return auth.slice(7).trim() || undefined;
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
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

export function isCompanionPath(urlPath: string): boolean {
  return urlPath === COMPANION_HTTP_PREFIX || urlPath.startsWith(`${COMPANION_HTTP_PREFIX}/`);
}

function requireSession(
  pairing: CompanionPairingService,
  token: string | undefined,
): { ok: true } | { ok: false; status: number; body: unknown } {
  if (!token) {
    return {
      ok: false,
      status: 401,
      body: { ok: false, code: "unpaired", message: "Missing companion session token." },
    };
  }
  const st = pairing.status(token);
  if (st.status === "connected") return { ok: true };
  if (st.status === "error") {
    return {
      ok: false,
      status: 401,
      body: { ok: false, code: "unpaired", message: st.lastError ?? "Unknown companion session." },
    };
  }
  return {
    ok: false,
    status: 401,
    body: { ok: false, code: st.status === "expired" ? "expired" : "unpaired", message: "Not paired or session expired." },
  };
}

/**
 * Handle a companion HTTP request. Returns true if handled.
 */
export async function handleCompanionHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  surface: CompanionHttpSurface | CompanionPairingService,
): Promise<boolean> {
  // Back-compat: older call sites passed pairing only.
  const pairing = "pairing" in surface ? surface.pairing : surface;
  const ops = "pairing" in surface ? surface.ops : undefined;

  const urlPath = (req.url ?? "").split("?")[0] ?? "";
  if (!isCompanionPath(urlPath)) return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...CORS });
    res.end();
    return true;
  }

  const sub = urlPath.slice(COMPANION_HTTP_PREFIX.length) || "/";

  try {
    if (req.method === "GET" && (sub === "/status" || sub === "status")) {
      json(res, 200, pairing.status(bearer(req)));
      return true;
    }

    if (req.method === "GET" && (sub === "/health" || sub === "health")) {
      json(res, 200, {
        ok: true,
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        service: "tachyon-companion",
      });
      return true;
    }

    if (req.method === "POST" && (sub === "/pair" || sub === "pair")) {
      let body: PairRequestBody;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw || "{}") as PairRequestBody;
      } catch {
        json(res, 400, {
          ok: false,
          code: "unknown",
          message: "Invalid JSON body.",
        });
        return true;
      }
      if (!body || typeof body !== "object") {
        json(res, 400, { ok: false, code: "unknown", message: "Expected JSON object." });
        return true;
      }
      if (typeof body.pairCode !== "string" || typeof body.protocolVersion !== "number" || !body.client) {
        json(res, 400, {
          ok: false,
          code: "unknown",
          message: "Required fields: pairCode (string), protocolVersion (number), client { kind, name, version }.",
        });
        return true;
      }
      const result = pairing.pair(body);
      json(res, result.ok ? 200 : 400, result);
      return true;
    }

    if (req.method === "POST" && (sub === "/unpair" || sub === "unpair")) {
      const result = pairing.unpair(bearer(req));
      json(res, result.ok ? 200 : 401, result);
      return true;
    }

    // --- MVP item 3: list active agents + send prompt (idle-safe) ---
    if (req.method === "GET" && (sub === "/agents" || sub === "agents")) {
      const auth = requireSession(pairing, bearer(req));
      if (!auth.ok) {
        json(res, auth.status, auth.body);
        return true;
      }
      if (!ops) {
        json(res, 501, { ok: false, code: "unknown", message: "Agent list not wired on this engine." });
        return true;
      }
      const agents = await ops.listActiveAgents();
      json(res, 200, { ok: true, agents });
      return true;
    }

    if (req.method === "POST" && (sub === "/prompt" || sub === "prompt")) {
      const auth = requireSession(pairing, bearer(req));
      if (!auth.ok) {
        json(res, auth.status, auth.body);
        return true;
      }
      if (!ops) {
        json(res, 501, { ok: false, code: "unknown", message: "Send-prompt not wired on this engine." });
        return true;
      }
      let body: SendPromptRequest;
      try {
        body = JSON.parse((await readBody(req)) || "{}") as SendPromptRequest;
      } catch {
        json(res, 400, { ok: false, code: "unknown", message: "Invalid JSON body." });
        return true;
      }
      if (typeof body.agent !== "string" || typeof body.text !== "string") {
        json(res, 400, {
          ok: false,
          code: "unknown",
          message: "Required fields: agent (string), text (string).",
        });
        return true;
      }
      const result = await ops.sendPrompt(body.agent.trim(), body.text);
      json(res, result.ok ? 200 : 400, result);
      return true;
    }

    // Approvals / tab-capture — later increments.
    if (
      (req.method === "POST" && (sub === "/capture" || sub === "capture")) ||
      (req.method === "GET" && (sub === "/approvals" || sub === "approvals")) ||
      (req.method === "POST" && (sub === "/approvals/resolve" || sub === "approvals/resolve"))
    ) {
      json(res, 501, {
        ok: false,
        code: "unknown",
        message: "Not in this increment — approvals / tab-capture come after send-prompt dogfood.",
      });
      return true;
    }

    json(res, 404, {
      error: "not found",
      hint: `${COMPANION_HTTP_PREFIX}/health|pair|status|unpair|agents|prompt`,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
    });
    return true;
  } catch (err) {
    json(res, 500, {
      ok: false,
      code: "unknown",
      message: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}
