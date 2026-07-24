/**
 * Loopback HTTP surface for Tachyon Companion (SDD 414).
 * Mounted on the Bridge listener at /companion/v1/* — companion auth, not Bridge agent tokens.
 * SDD 422 also mounts the Mobile PWA at /companion/app/* (static files, no companion auth).
 */

import type http from "node:http";
import type { CompanionPairingService } from "./CompanionPairingService.js";
import type { CompanionLiveSync } from "./CompanionLiveSync.js";
import type { CompanionTabChannel } from "./CompanionTabChannel.js";
import {
  COMPANION_HTTP_PREFIX,
  COMPANION_PROTOCOL_VERSION,
  type CompanionTabResult,
  type CompanionWorkspaceOps,
  type PairRequestBody,
  type SendPromptRequest,
} from "./protocol.js";
import { isCompanionAppPath, serveCompanionMobileApp } from "./mobileAppStatic.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
};

export interface CompanionHttpSurface {
  pairing: CompanionPairingService;
  ops?: CompanionWorkspaceOps;
  /** Live SSE fan-out (GET /events). Optional until workspace wires CompanionLiveSync. */
  live?: CompanionLiveSync;
  /** Tab command channel (agent tools ↔ extension). */
  tab?: CompanionTabChannel;
  /**
   * SDD 422 — absolute path to Companion Mobile PWA dist (index.html + app.js).
   * When set, GET /companion/app/* is served from this directory.
   */
  mobileDistRoot?: string;
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

/**
 * Paths allowed for companion surface + LAN non-loopback peers (API + engine-served PWA).
 * MCP and other Bridge routes stay loopback-only.
 */
export function isCompanionPath(urlPath: string): boolean {
  return (
    urlPath === COMPANION_HTTP_PREFIX ||
    urlPath.startsWith(`${COMPANION_HTTP_PREFIX}/`) ||
    isCompanionAppPath(urlPath)
  );
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
  const live = "pairing" in surface ? surface.live : undefined;
  const tab = "pairing" in surface ? surface.tab : undefined;
  const mobileDistRoot = "pairing" in surface ? surface.mobileDistRoot : undefined;

  const urlPath = (req.url ?? "").split("?")[0] ?? "";
  if (!isCompanionPath(urlPath)) return false;

  // SDD 422 — engine-served Companion Mobile PWA (no session auth; pair via #pair= hash).
  if (isCompanionAppPath(urlPath)) {
    return serveCompanionMobileApp(req, res, mobileDistRoot);
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...CORS });
    res.end();
    return true;
  }

  // API routes only under /companion/v1
  if (!(urlPath === COMPANION_HTTP_PREFIX || urlPath.startsWith(`${COMPANION_HTTP_PREFIX}/`))) {
    return false;
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
      if (result.ok && live) {
        // Same-kind replace only — do not kill the other kind's SSE (422 multi-session).
        const replaced =
          "replacedSessionToken" in result && typeof result.replacedSessionToken === "string"
            ? result.replacedSessionToken
            : undefined;
        if (replaced) live.dropSession(replaced);
      }
      // Strip server-only field from the wire response (mobile clients ignore unknown keys, but keep payload clean).
      if (result.ok && "replacedSessionToken" in result) {
        const { replacedSessionToken: _r, ...wire } = result;
        json(res, 200, wire);
      } else {
        json(res, result.ok ? 200 : 400, result);
      }
      return true;
    }

    if (req.method === "POST" && (sub === "/unpair" || sub === "unpair")) {
      const token = bearer(req);
      const result = pairing.unpair(token);
      if (result.ok && live && token) live.dropSession(token);
      json(res, result.ok ? 200 : 401, result);
      return true;
    }

    // --- Live state stream (SSE) — SW owns the connection; UI never polls ---
    if (req.method === "GET" && (sub === "/events" || sub === "events")) {
      const token = bearer(req);
      const auth = requireSession(pairing, token);
      if (!auth.ok) {
        json(res, auth.status, auth.body);
        return true;
      }
      if (!live) {
        json(res, 501, {
          ok: false,
          code: "unknown",
          message: "Live sync not wired on this engine.",
        });
        return true;
      }
      await live.attach(req, res, token!);
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
      // Prompt can change queue/attention; push a fresh snapshot if anyone is listening.
      live?.notifyChanged();
      json(res, result.ok ? 200 : 400, result);
      return true;
    }

    // --- Tab control: pending commands + extension results (t-2a7010) ---
    if (req.method === "GET" && (sub === "/tab/pending" || sub === "tab/pending")) {
      const auth = requireSession(pairing, bearer(req));
      if (!auth.ok) {
        json(res, auth.status, auth.body);
        return true;
      }
      if (!tab) {
        json(res, 501, { ok: false, code: "unknown", message: "Tab channel not wired on this engine." });
        return true;
      }
      json(res, 200, { ok: true, commands: tab.listPending() });
      return true;
    }

    if (req.method === "POST" && (sub === "/tab/result" || sub === "tab/result")) {
      const auth = requireSession(pairing, bearer(req));
      if (!auth.ok) {
        json(res, auth.status, auth.body);
        return true;
      }
      if (!tab) {
        json(res, 501, { ok: false, code: "unknown", message: "Tab channel not wired on this engine." });
        return true;
      }
      let body: CompanionTabResult;
      try {
        // Screenshots (jpeg data URLs) need a larger cap than text outlines.
        body = JSON.parse((await readBody(req, 8 * 1024 * 1024)) || "{}") as CompanionTabResult;
      } catch {
        json(res, 400, { ok: false, code: "unknown", message: "Invalid JSON body." });
        return true;
      }
      if (!body || typeof body !== "object" || typeof body.id !== "string") {
        json(res, 400, { ok: false, code: "unknown", message: "Required field: id (string)." });
        return true;
      }
      const submitted = tab.submitResult(body);
      json(res, submitted.ok ? 200 : 404, submitted.ok ? { ok: true } : submitted);
      return true;
    }

    // --- Approvals (host-authoritative Accept/Deny — t-a45c6b) ---
    if (req.method === "GET" && (sub === "/approvals" || sub === "approvals")) {
      const auth = requireSession(pairing, bearer(req));
      if (!auth.ok) {
        json(res, auth.status, auth.body);
        return true;
      }
      if (!ops?.listApprovals) {
        json(res, 501, { ok: false, code: "unknown", message: "Approvals not wired on this engine." });
        return true;
      }
      const approvals = await ops.listApprovals();
      json(res, 200, { ok: true, approvals });
      return true;
    }

    if (req.method === "POST" && (sub === "/approvals/resolve" || sub === "approvals/resolve")) {
      const auth = requireSession(pairing, bearer(req));
      if (!auth.ok) {
        json(res, auth.status, auth.body);
        return true;
      }
      if (!ops?.resolveApproval) {
        json(res, 501, { ok: false, code: "unknown", message: "Approvals resolve not wired on this engine." });
        return true;
      }
      let body: { id?: string; decision?: string };
      try {
        body = JSON.parse((await readBody(req)) || "{}") as { id?: string; decision?: string };
      } catch {
        json(res, 400, { ok: false, code: "unknown", message: "Invalid JSON body." });
        return true;
      }
      if (typeof body.id !== "string" || (body.decision !== "approved" && body.decision !== "denied")) {
        json(res, 400, {
          ok: false,
          code: "unknown",
          message: "Required fields: id (string), decision ('approved' | 'denied').",
        });
        return true;
      }
      const result = await ops.resolveApproval(body.id.trim(), body.decision);
      live?.pushEvent("approvals.changed", { id: body.id, decision: body.decision });
      json(res, result.ok ? 200 : 400, result);
      return true;
    }

    if (req.method === "POST" && (sub === "/capture" || sub === "capture")) {
      json(res, 501, {
        ok: false,
        code: "unknown",
        message: "Tab-to-task capture not in this increment.",
      });
      return true;
    }

    json(res, 404, {
      error: "not found",
      hint: `${COMPANION_HTTP_PREFIX}/health|pair|status|unpair|agents|prompt|events|tab/pending|tab/result|approvals`,
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
