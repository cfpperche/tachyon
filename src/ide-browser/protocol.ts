/**
 * Shared wire shapes for the IDE Integrated Browser bridge (thimo-style).
 * Engine (client) and shell (server) share this contract — no vscode types here.
 *
 * t-47503a / AR-04: versioned route map + shared request decoders. HTTP is the
 * transport; this module is the contract. Both host dispatch and engine tools
 * should prefer these path constants and decode helpers over free-form strings.
 */

export type IdeBrowserEnvelope =
  | { ok: true; data: unknown }
  | { ok: false; error: string; code?: string };

export type IdeBrowserStatus = {
  running: boolean;
  cdp: "disconnected" | "connecting" | "connected";
  transport: "websocket" | "none";
  url: string;
  endpoint: string;
  workspaceRoot: string;
  pid: number;
};

export type IdeBrowserInstanceFile = {
  schemaVersion: 2;
  kind: "tachyon-ide-browser";
  instanceId: string;
  workspaceRoot: string;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
};

export const IDE_BROWSER_INSTANCES_DIR_NAME = "ide-browser-instances";
export const IDE_BROWSER_INSTANCE_HEARTBEAT_MS = 5_000;
export const IDE_BROWSER_INSTANCE_FRESHNESS_MS = 30_000;
export const IDE_BROWSER_INSTANCE_HEADER = "x-tachyon-ide-browser-instance";
/** Request auth header (shell checks equality against the instance token). */
export const IDE_BROWSER_TOKEN_HEADER = "x-tachyon-ide-browser-token";

/**
 * Wire protocol version for the HTTP route map.
 * Bump when adding/removing/renaming routes or changing request/response shapes
 * in a way that would break an old client talking to a new host (or reverse).
 * Discovery files stay on schemaVersion 2 independently.
 */
export const IDE_BROWSER_HTTP_PROTOCOL_VERSION = 1 as const;

/** Stable path constants — one source for tools, client, and host dispatch. */
export const IDE_BROWSER_ROUTES = {
  status: "/status",
  navigate: "/navigate",
  eval: "/eval",
  screenshot: "/screenshot",
  snapshot: "/snapshot",
  url: "/url",
  click: "/click",
  chatReply: "/design-mode/chat-reply",
} as const;

export type IdeBrowserRoutePath = (typeof IDE_BROWSER_ROUTES)[keyof typeof IDE_BROWSER_ROUTES];

/** Optional structured edit attachment on design_mode_chat_reply. */
export type IdeBrowserChatReplyEdit = {
  summary: string;
  files: string[];
  patch: string;
};

/** Request body types per route (void for GET / empty body). */
export type IdeBrowserRouteRequest = {
  [IDE_BROWSER_ROUTES.status]: void;
  [IDE_BROWSER_ROUTES.navigate]: { url: string };
  [IDE_BROWSER_ROUTES.eval]: { expression: string };
  [IDE_BROWSER_ROUTES.screenshot]: void;
  [IDE_BROWSER_ROUTES.snapshot]: void;
  [IDE_BROWSER_ROUTES.url]: void;
  [IDE_BROWSER_ROUTES.click]: { selector: string };
  [IDE_BROWSER_ROUTES.chatReply]: {
    text: string;
    agent?: string;
    turnId?: string;
    edit?: IdeBrowserChatReplyEdit;
  };
};

/** Success `data` payload per route (envelope wraps this). */
export type IdeBrowserRouteResponse = {
  [IDE_BROWSER_ROUTES.status]: IdeBrowserStatus;
  [IDE_BROWSER_ROUTES.navigate]: { url: string };
  [IDE_BROWSER_ROUTES.eval]: { value: unknown };
  [IDE_BROWSER_ROUTES.screenshot]: { mime: "image/png"; base64: string; url: string };
  [IDE_BROWSER_ROUTES.snapshot]: { text: string; url: string };
  [IDE_BROWSER_ROUTES.url]: { url: string };
  [IDE_BROWSER_ROUTES.click]: { clicked: string };
  [IDE_BROWSER_ROUTES.chatReply]: { event: unknown };
};

export type IdeBrowserHttpMethod = "GET" | "POST";

type RouteSpec<P extends IdeBrowserRoutePath> = {
  method: IdeBrowserHttpMethod;
  path: P;
  /** Whether the route expects a JSON body (POST with fields). */
  hasBody: boolean;
};

/**
 * Versioned route table. Order does not matter for matching; paths are unique.
 * Keep in lockstep with host dispatch and MCP tool wiring.
 */
export const IDE_BROWSER_ROUTE_TABLE: {
  [P in IdeBrowserRoutePath]: RouteSpec<P>;
} = {
  [IDE_BROWSER_ROUTES.status]: { method: "GET", path: IDE_BROWSER_ROUTES.status, hasBody: false },
  [IDE_BROWSER_ROUTES.navigate]: { method: "POST", path: IDE_BROWSER_ROUTES.navigate, hasBody: true },
  [IDE_BROWSER_ROUTES.eval]: { method: "POST", path: IDE_BROWSER_ROUTES.eval, hasBody: true },
  [IDE_BROWSER_ROUTES.screenshot]: { method: "GET", path: IDE_BROWSER_ROUTES.screenshot, hasBody: false },
  [IDE_BROWSER_ROUTES.snapshot]: { method: "GET", path: IDE_BROWSER_ROUTES.snapshot, hasBody: false },
  [IDE_BROWSER_ROUTES.url]: { method: "GET", path: IDE_BROWSER_ROUTES.url, hasBody: false },
  [IDE_BROWSER_ROUTES.click]: { method: "POST", path: IDE_BROWSER_ROUTES.click, hasBody: true },
  [IDE_BROWSER_ROUTES.chatReply]: { method: "POST", path: IDE_BROWSER_ROUTES.chatReply, hasBody: true },
};

export type IdeBrowserDecodedRequest =
  | { ok: true; path: typeof IDE_BROWSER_ROUTES.status; body: void }
  | { ok: true; path: typeof IDE_BROWSER_ROUTES.navigate; body: IdeBrowserRouteRequest[typeof IDE_BROWSER_ROUTES.navigate] }
  | { ok: true; path: typeof IDE_BROWSER_ROUTES.eval; body: IdeBrowserRouteRequest[typeof IDE_BROWSER_ROUTES.eval] }
  | { ok: true; path: typeof IDE_BROWSER_ROUTES.screenshot; body: void }
  | { ok: true; path: typeof IDE_BROWSER_ROUTES.snapshot; body: void }
  | { ok: true; path: typeof IDE_BROWSER_ROUTES.url; body: void }
  | { ok: true; path: typeof IDE_BROWSER_ROUTES.click; body: IdeBrowserRouteRequest[typeof IDE_BROWSER_ROUTES.click] }
  | { ok: true; path: typeof IDE_BROWSER_ROUTES.chatReply; body: IdeBrowserRouteRequest[typeof IDE_BROWSER_ROUTES.chatReply] }
  | { ok: false; status: 400 | 404; error: string };

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Decode method + pathname + optional JSON body into a typed route request.
 * Field rules match the historical host handlers (same error strings).
 * Auth is intentionally out of scope — the host checks the token first.
 */
export function decodeIdeBrowserHttpRequest(
  method: string,
  pathname: string,
  body: unknown = undefined,
): IdeBrowserDecodedRequest {
  const m = (method || "GET").toUpperCase();
  const path = pathname || "/";

  const match = (Object.values(IDE_BROWSER_ROUTE_TABLE) as RouteSpec<IdeBrowserRoutePath>[])
    .find((spec) => spec.path === path && spec.method === m);

  if (!match) {
    // Preserve historical 404 message: pathname only (not method).
    return { ok: false, status: 404, error: `unknown route ${path}` };
  }

  const raw = asRecord(body);

  switch (match.path) {
    case IDE_BROWSER_ROUTES.status:
    case IDE_BROWSER_ROUTES.screenshot:
    case IDE_BROWSER_ROUTES.snapshot:
    case IDE_BROWSER_ROUTES.url:
      return { ok: true, path: match.path, body: undefined as void };

    case IDE_BROWSER_ROUTES.navigate: {
      const url = typeof raw.url === "string" ? raw.url : "";
      if (!url) return { ok: false, status: 400, error: "url required" };
      return { ok: true, path: match.path, body: { url } };
    }

    case IDE_BROWSER_ROUTES.eval: {
      const expression = typeof raw.expression === "string" ? raw.expression : "";
      if (!expression) return { ok: false, status: 400, error: "expression required" };
      return { ok: true, path: match.path, body: { expression } };
    }

    case IDE_BROWSER_ROUTES.click: {
      const selector = typeof raw.selector === "string" ? raw.selector : "";
      if (!selector) return { ok: false, status: 400, error: "selector required" };
      return { ok: true, path: match.path, body: { selector } };
    }

    case IDE_BROWSER_ROUTES.chatReply: {
      const text = typeof raw.text === "string" ? raw.text : "";
      const agent = optionalString(raw.agent);
      const turnId = optionalString(raw.turnId);
      // Same gate as the pre-split host: object-ish `edit` is passed through; field
      // validation (summary/files/patch) lives in ingestChatReply — not here.
      const edit = raw.edit && typeof raw.edit === "object"
        ? raw.edit as IdeBrowserChatReplyEdit
        : undefined;
      return {
        ok: true,
        path: match.path,
        body: {
          text,
          ...(agent !== undefined ? { agent } : {}),
          ...(turnId !== undefined ? { turnId } : {}),
          ...(edit ? { edit } : {}),
        },
      };
    }

    default: {
      // Exhaustiveness: TypeScript should never land here.
      const _never: never = match.path;
      return { ok: false, status: 404, error: `unknown route ${String(_never)}` };
    }
  }
}

/** True when `route` is a known protocol path (ignores method). */
export function isIdeBrowserRoutePath(route: string): route is IdeBrowserRoutePath {
  return (Object.values(IDE_BROWSER_ROUTES) as string[]).includes(
    route.startsWith("/") ? route : `/${route}`,
  );
}

/** Normalize a client route string to a path starting with `/`. */
export function normalizeIdeBrowserRoutePath(route: string): string {
  return route.startsWith("/") ? route : `/${route}`;
}
