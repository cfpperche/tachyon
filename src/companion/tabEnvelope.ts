/**
 * SDD 420 — shared agent-facing envelope for user_browser_* tools.
 */

import { COMPANION_PROTOCOL_VERSION } from "./protocol.js";

export type UserBrowserStatus =
  | "applied"
  | "not_applied"
  | "timeout"
  | "error"
  | "unknown_outcome";

export interface UserBrowserEnvelope {
  ok: boolean;
  status: UserBrowserStatus;
  requestId: string;
  protocolVersion: number;
  tabId?: string;
  urlBefore?: string;
  urlAfter?: string;
  documentTokenBefore?: string;
  documentTokenAfter?: string;
  tool: string;
  code?: string;
  message?: string;
  /** When false, agents must not auto-retry. */
  retrySafe: boolean;
  /** Tool-specific payload (snapshot outline, act detail, …). */
  result?: unknown;
}

export function envelopeFromTabResult(opts: {
  tool: string;
  tabId?: string;
  raw: unknown;
}): UserBrowserEnvelope {
  const raw = opts.raw as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      status: "error",
      requestId: "unknown",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      tabId: opts.tabId,
      tool: opts.tool,
      code: "unknown",
      message: "Empty tab result from Companion.",
      retrySafe: false,
    };
  }

  const id = typeof raw.id === "string" ? raw.id : "unknown";
  const url = typeof raw.url === "string" ? raw.url : undefined;
  const documentToken =
    typeof raw.documentToken === "string" ? raw.documentToken : undefined;

  if (raw.ok === true) {
    return {
      ok: true,
      status: "applied",
      requestId: id,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      tabId: opts.tabId ?? (typeof raw.tabId === "string" ? raw.tabId : undefined),
      urlBefore: typeof raw.urlBefore === "string" ? raw.urlBefore : url,
      urlAfter: typeof raw.urlAfter === "string" ? raw.urlAfter : url,
      documentTokenBefore:
        typeof raw.documentTokenBefore === "string" ? raw.documentTokenBefore : documentToken,
      documentTokenAfter:
        typeof raw.documentTokenAfter === "string" ? raw.documentTokenAfter : documentToken,
      tool: opts.tool,
      retrySafe: true,
      result: raw,
    };
  }

  const code = typeof raw.code === "string" ? raw.code : "unknown";
  const message = typeof raw.message === "string" ? raw.message : "Tab command failed.";
  let status: UserBrowserStatus = "error";
  if (code === "timeout") status = "timeout";
  else if (
    code === "not_applied" ||
    code === "stale_tab" ||
    code === "stale_ref" ||
    code === "denied" ||
    code === "restricted" ||
    code === "not_found" ||
    code === "needs_confirm"
  ) {
    status = "not_applied";
  } else if (code === "unknown_outcome") {
    status = "unknown_outcome";
  }

  return {
    ok: false,
    status,
    requestId: id,
    protocolVersion: COMPANION_PROTOCOL_VERSION,
    tabId: opts.tabId ?? (typeof raw.tabId === "string" ? raw.tabId : undefined),
    urlBefore: typeof raw.urlBefore === "string" ? raw.urlBefore : url,
    urlAfter: typeof raw.urlAfter === "string" ? raw.urlAfter : url,
    documentTokenBefore:
      typeof raw.documentTokenBefore === "string" ? raw.documentTokenBefore : documentToken,
    documentTokenAfter:
      typeof raw.documentTokenAfter === "string" ? raw.documentTokenAfter : documentToken,
    tool: opts.tool,
    code,
    message,
    retrySafe: false,
    result: raw,
  };
}
