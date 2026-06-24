/**
 * spec 254 Step 1 — pure parser/validator for a plugin's NEUTRAL MCP-server payload (`mcp.json` at the
 * plugin root). A plugin declares its MCP servers ONCE in a runtime-neutral shape; the per-runtime adapters
 * (Step 2+) render each server into that runtime's config FORMAT (claude `.mcp.json` `mcpServers.<name>`,
 * codex `.codex/config.toml` `[mcp_servers.<name>]`). The declaration is portable; only the syntax differs —
 * the same common-denominator shape as skills, unlike hooks.
 *
 * UNTRUSTED-author boundary (mirrors manifest.ts / skill.ts): fail-closed, error-accumulating, never throws,
 * size-capped, key-closed. Security model (codex debate, folded):
 *  - D4 secrets: NO literal secret ever lives in the committed payload. `env` values are EXACT `${VAR}`
 *    references — the H7 rule already enforced for harness MCP (`loadConfig.ts`); http header values must
 *    reference ≥1 `${VAR}` and carry no bare `$`. The required-env list is DERIVED from those references
 *    (OQ3 — no hand-maintained `requiresEnv`, which would drift).
 *  - OQ4 `${PLUGIN_ROOT}`: allowed ONLY as a LEADING token in path-like fields (`command`, a path arg); its
 *    suffix is validated by the same contained-relative-path rule as the rest of the plugin system
 *    (`paths.ts`). No general string substitution anywhere else.
 *  - Server `name`: lowercase kebab (a safe TOML bare key + JSON key, no quoting/escaping needed); the Bridge
 *    names `tachyon`/`tachyon_bridge` are reserved (injected automatically — a plugin must not shadow them).
 */

import { checkContainedRelPath } from "./paths.js";

/** server names: lowercase kebab — also a safe `[mcp_servers.<name>]` TOML bare key and JSON object key. */
const SERVER_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** an env value must be EXACTLY `${VAR}` — a literal would commit a secret to disk (H7, loadConfig.ts). */
const ENV_REF_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
/** an env-var NAME (env key, and the inside of a `${…}` reference). */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** extract every `${VAR}` reference from a header template (for the derived required-env list). */
const ENV_REF_TOKEN_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** a bare command token (no separators, no `${…}`): `npx`, `node`, `python3`, `uvx`, `deno`. */
const BARE_COMMAND_RE = /^[A-Za-z0-9_.-]+$/;
/** an http header NAME — a token, no `:`/controls/whitespace/underscore (so `__proto__` can't be a key). */
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
/** a header VALUE: a SINGLE exact `${VAR}`, optionally prefixed by ONE KNOWN auth scheme keyword
 *  (Bearer/Basic/Token, case-insensitive) — nothing else. Permits `${TOKEN}` and `Bearer ${TOKEN}` while
 *  forbidding any other literal text, incl. a secret-shaped token masquerading as a scheme (`sk-live ${T}`)
 *  or a secret beside a ref (`Bearer ${T} sk-live`). Multi-ref / arbitrary-literal headers are a follow pass. */
const HEADER_VALUE_RE = /^(?:(?:bearer|basic|token) )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/i;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
/** object keys that would pollute the prototype chain / break the own-key contract — rejected everywhere. */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const PLUGIN_ROOT = "${PLUGIN_ROOT}";
const PLUGIN_ROOT_PREFIX = "${PLUGIN_ROOT}/";
const RESERVED_NAMES: ReadonlySet<string> = new Set(["tachyon", "tachyon_bridge"]);

// Resource caps — untrusted payload, bound everything before trusting it.
const MAX_MCP_BYTES = 64 * 1024;
const MAX_SERVERS = 32;
const MAX_ARGS = 64;
const MAX_ENV = 64;
const MAX_HEADERS = 32;
const MAX_STR = 1024;

const KNOWN_STDIO_KEYS: ReadonlySet<string> = new Set(["name", "transport", "command", "args", "env"]);
const KNOWN_HTTP_KEYS: ReadonlySet<string> = new Set(["name", "transport", "url", "headers"]);

export interface McpServerStdio {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  /** env-var name → exact `${VAR}` reference (never a literal value). */
  env: Record<string, string>;
}

export interface McpServerHttp {
  name: string;
  transport: "http";
  url: string;
  /** header name → template that references ≥1 `${VAR}` (e.g. `Bearer ${TOKEN}`); never a bare secret. */
  headers: Record<string, string>;
}

export type McpServer = McpServerStdio | McpServerHttp;

export interface McpPayload {
  servers: McpServer[];
  /** env-var names referenced by ANY server (stdio env + http header refs), deduped + sorted. DERIVED from
   *  the references themselves (OQ3) — the consent drawer lists these as the vars the user must provide. */
  requiresEnv: string[];
}

export interface McpParseResult {
  payload?: McpPayload;
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A plain string of bounded length with no control/null chars. */
function isCleanStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_STR && !CONTROL_RE.test(v);
}

/**
 * Validate a `command`: either a `${PLUGIN_ROOT}/<contained>` path to a bundled binary, or a bare command
 * token (`npx`, `node`, …) resolved on PATH. Never an absolute path, a `..` escape, or a `${…}` other than a
 * leading `${PLUGIN_ROOT}/`.
 */
function validCommand(raw: unknown, where: string, errors: string[]): string | null {
  if (!isCleanStr(raw)) {
    errors.push(`${where}.command: required, a non-empty string (no control characters)`);
    return null;
  }
  if (raw.startsWith(PLUGIN_ROOT_PREFIX)) {
    const rest = raw.slice(PLUGIN_ROOT_PREFIX.length);
    const check = checkContainedRelPath(rest);
    if (!check.ok) {
      errors.push(`${where}.command: '\${PLUGIN_ROOT}/…' suffix ${check.reason}`);
      return null;
    }
    return raw;
  }
  if (raw.includes(PLUGIN_ROOT) || raw.includes("${")) {
    errors.push(`${where}.command: '\${PLUGIN_ROOT}' is only allowed as a leading path token ('\${PLUGIN_ROOT}/…'); no other substitution`);
    return null;
  }
  if (!BARE_COMMAND_RE.test(raw)) {
    errors.push(`${where}.command: must be a bare command name (e.g. 'npx', 'node') or a '\${PLUGIN_ROOT}/…' path — no separators, absolute paths, or metacharacters`);
    return null;
  }
  return raw;
}

/** Validate one `args` entry: a `${PLUGIN_ROOT}/<contained>` path or a literal with NO `${…}` substitution. */
function validArg(raw: unknown, where: string, errors: string[]): string | null {
  if (typeof raw !== "string" || raw.length > MAX_STR || CONTROL_RE.test(raw)) {
    errors.push(`${where}: must be a string (no control characters)`);
    return null;
  }
  if (raw.startsWith(PLUGIN_ROOT_PREFIX)) {
    const rest = raw.slice(PLUGIN_ROOT_PREFIX.length);
    const check = checkContainedRelPath(rest);
    if (!check.ok) {
      errors.push(`${where}: '\${PLUGIN_ROOT}/…' suffix ${check.reason}`);
      return null;
    }
    return raw;
  }
  if (raw.includes("${")) {
    errors.push(`${where}: '\${…}' substitution is only allowed as a leading '\${PLUGIN_ROOT}/…' path (no env/secret substitution in args)`);
    return null;
  }
  return raw;
}

/** Validate `env`: name → exact `${VAR}` reference (H7). Built on a null-proto map; dangerous keys rejected. */
function validEnv(raw: unknown, where: string, errors: string[]): Record<string, string> | null {
  if (!isPlainObject(raw)) {
    errors.push(`${where}.env: must be a mapping of NAME -> \${VAR}`);
    return null;
  }
  const keys = Object.keys(raw);
  if (keys.length > MAX_ENV) {
    errors.push(`${where}.env: too many entries (max ${MAX_ENV})`);
    return null;
  }
  const env: Record<string, string> = Object.create(null);
  let ok = true;
  for (const [k, v] of Object.entries(raw)) {
    if (DANGEROUS_KEYS.has(k)) {
      errors.push(`${where}.env: '${k}' is not an allowed key`);
      ok = false;
      continue;
    }
    if (!ENV_NAME_RE.test(k)) {
      errors.push(`${where}.env: '${k}' is not a valid environment variable name`);
      ok = false;
      continue;
    }
    if (typeof v !== "string" || !ENV_REF_RE.test(v)) {
      errors.push(`${where}.env.${k}: must be an exact \${VAR} reference (a literal value would commit a secret to disk)`);
      ok = false;
      continue;
    }
    env[k] = v;
  }
  return ok ? env : null;
}

/** Validate `headers`: name -> `[scheme ]${VAR}` (exactly one ref, no other literal — closes the secret-
 *  beside-a-ref bypass). Case-insensitive uniqueness; null-proto map. */
function validHeaders(raw: unknown, where: string, errors: string[]): Record<string, string> | null {
  if (!isPlainObject(raw)) {
    errors.push(`${where}.headers: must be a mapping of header name -> value`);
    return null;
  }
  const keys = Object.keys(raw);
  if (keys.length > MAX_HEADERS) {
    errors.push(`${where}.headers: too many entries (max ${MAX_HEADERS})`);
    return null;
  }
  const headers: Record<string, string> = Object.create(null);
  const seenLower = new Set<string>();
  let ok = true;
  for (const [k, v] of Object.entries(raw)) {
    if (DANGEROUS_KEYS.has(k) || !HEADER_NAME_RE.test(k)) {
      errors.push(`${where}.headers: '${k}' is not a valid header name`);
      ok = false;
      continue;
    }
    const lower = k.toLowerCase();
    if (seenLower.has(lower)) {
      errors.push(`${where}.headers: '${k}' duplicates another header (case-insensitive)`);
      ok = false;
      continue;
    }
    seenLower.add(lower);
    if (typeof v !== "string" || v.length > MAX_STR || CONTROL_RE.test(v) || !HEADER_VALUE_RE.test(v)) {
      errors.push(`${where}.headers.${k}: must be '\${VAR}' or '<Bearer|Basic|Token> \${VAR}' (exactly one reference, no other literal — a hard-coded secret is rejected)`);
      ok = false;
      continue;
    }
    headers[k] = v;
  }
  return ok ? headers : null;
}

function validUrl(raw: unknown, where: string, errors: string[]): string | null {
  if (!isCleanStr(raw)) {
    errors.push(`${where}.url: required, a non-empty string (no control characters)`);
    return null;
  }
  if (raw.includes("${")) {
    errors.push(`${where}.url: must be a literal URL (no \${…} substitution)`);
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    errors.push(`${where}.url: must be a valid http(s) URL`);
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    errors.push(`${where}.url: must be an http(s) URL`);
    return null;
  }
  return raw;
}

function parseServer(raw: unknown, index: number, errors: string[]): McpServer | null {
  const where = `servers[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push(`${where}: must be an object`);
    return null;
  }
  const name = raw.name;
  if (typeof name !== "string" || name.length > MAX_STR || !SERVER_NAME_RE.test(name)) {
    errors.push(`${where}.name: required, lowercase kebab-case (e.g. 'db-tools')`);
    return null;
  }
  if (RESERVED_NAMES.has(name)) {
    errors.push(`${where}.name: '${name}' is reserved for the Tachyon Bridge (injected automatically); use a different name`);
    return null;
  }
  const transport = raw.transport;
  if (transport !== "stdio" && transport !== "http") {
    errors.push(`${where}.transport: must be 'stdio' or 'http'`);
    return null;
  }

  // key closure per transport (catches typos + a field from the wrong transport).
  const known = transport === "stdio" ? KNOWN_STDIO_KEYS : KNOWN_HTTP_KEYS;
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) errors.push(`${where}: unknown key '${key}' for a ${transport} server`);
  }

  if (transport === "stdio") {
    const command = validCommand(raw.command, where, errors);
    let args: string[] = [];
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.length > MAX_ARGS) {
        errors.push(`${where}.args: must be a list of at most ${MAX_ARGS} strings`);
        return null;
      }
      const out: string[] = [];
      raw.args.forEach((a, i) => {
        const v = validArg(a, `${where}.args[${i}]`, errors);
        if (v !== null) out.push(v);
      });
      if (out.length !== raw.args.length) return null;
      args = out;
    }
    let env: Record<string, string> = {};
    if (raw.env !== undefined) {
      const e = validEnv(raw.env, where, errors);
      if (e === null) return null;
      env = e;
    }
    if (command === null) return null;
    return { name, transport: "stdio", command, args, env };
  }

  // http
  const url = validUrl(raw.url, where, errors);
  let headers: Record<string, string> = {};
  if (raw.headers !== undefined) {
    const h = validHeaders(raw.headers, where, errors);
    if (h === null) return null;
    headers = h;
  }
  if (url === null) return null;
  return { name, transport: "http", url, headers };
}

/**
 * Parse + validate a plugin's `mcp.json` payload. Fail-closed and error-accumulating: collects every problem
 * and only returns a `payload` when the input is wholly valid. Never throws.
 */
export function loadMcpPayload(rawJson: string): McpParseResult {
  if (typeof rawJson !== "string" || Buffer.byteLength(rawJson, "utf8") > MAX_MCP_BYTES) {
    return { errors: [`mcp.json: input is empty or exceeds ${MAX_MCP_BYTES} bytes`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return { errors: [`mcp.json: invalid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!isPlainObject(parsed)) {
    return { errors: ["mcp.json: must be a JSON object with a 'servers' array"] };
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "servers") return { errors: [`mcp.json: unknown field '${key}' (only 'servers' is allowed)`] };
  }
  if (!Array.isArray(parsed.servers) || parsed.servers.length === 0) {
    return { errors: ["mcp.json: 'servers' must be a non-empty array"] };
  }
  if (parsed.servers.length > MAX_SERVERS) {
    return { errors: [`mcp.json: too many servers (max ${MAX_SERVERS})`] };
  }

  const errors: string[] = [];
  const servers: McpServer[] = [];
  const seen = new Set<string>();
  parsed.servers.forEach((s, i) => {
    const server = parseServer(s, i, errors);
    if (!server) return;
    if (seen.has(server.name)) {
      errors.push(`servers[${i}].name: '${server.name}' is declared more than once`);
      return;
    }
    seen.add(server.name);
    servers.push(server);
  });

  if (errors.length > 0) return { errors };

  // requiresEnv is derived from the FINAL validated servers (not a parse-time accumulator) so it provably
  // equals mcpRequiredEnv(servers) — the consent surface can never drift from what was stored.
  return {
    payload: { servers, requiresEnv: mcpRequiredEnv(servers) },
    errors: [],
  };
}

/** The env-var names a set of servers reference (stdio env + http header refs), deduped + sorted. Pure;
 *  reused by the consent surface (Step 5) so it never drifts from what was validated. */
export function mcpRequiredEnv(servers: readonly McpServer[]): string[] {
  const refs = new Set<string>();
  for (const s of servers) {
    if (s.transport === "stdio") {
      for (const v of Object.values(s.env)) refs.add(v.slice(2, -1));
    } else {
      for (const v of Object.values(s.headers)) {
        let m: RegExpExecArray | null;
        ENV_REF_TOKEN_RE.lastIndex = 0;
        while ((m = ENV_REF_TOKEN_RE.exec(v)) !== null) refs.add(m[1]);
      }
    }
  }
  return [...refs].sort();
}
