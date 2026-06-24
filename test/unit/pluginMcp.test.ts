import { describe, it, expect } from "vitest";
import { loadMcpPayload, mcpRequiredEnv, type McpServer } from "../../src/plugins/mcp.js";

/** Build an `mcp.json` text from a list of server objects. */
function payload(...servers: unknown[]): string {
  return JSON.stringify({ servers });
}

const STDIO_NPX = { name: "db-tools", transport: "stdio", command: "npx", args: ["-y", "@scope/db-mcp"], env: { DB_URL: "${DB_URL}" } };
const STDIO_BUNDLED = { name: "local-srv", transport: "stdio", command: "${PLUGIN_ROOT}/servers/srv", args: ["--config", "${PLUGIN_ROOT}/config.json"] };
const HTTP_BEARER = { name: "remote-api", transport: "http", url: "https://mcp.example.com/v1", headers: { Authorization: "Bearer ${API_TOKEN}" } };

describe("loadMcpPayload — happy paths", () => {
  it("accepts a stdio server (npx) and derives requiresEnv from env refs", () => {
    const r = loadMcpPayload(payload(STDIO_NPX));
    expect(r.errors).toEqual([]);
    expect(r.payload?.servers).toHaveLength(1);
    expect(r.payload?.servers[0]).toMatchObject({ name: "db-tools", transport: "stdio", command: "npx", args: ["-y", "@scope/db-mcp"], env: { DB_URL: "${DB_URL}" } });
    expect(r.payload?.requiresEnv).toEqual(["DB_URL"]);
  });

  it("accepts a bundled-binary command + path args via ${PLUGIN_ROOT}", () => {
    const r = loadMcpPayload(payload(STDIO_BUNDLED));
    expect(r.errors).toEqual([]);
    expect(r.payload?.servers[0]).toMatchObject({ command: "${PLUGIN_ROOT}/servers/srv", args: ["--config", "${PLUGIN_ROOT}/config.json"] });
    expect(r.payload?.requiresEnv).toEqual([]);
  });

  it("accepts an http server with a Bearer header and derives the token var", () => {
    const r = loadMcpPayload(payload(HTTP_BEARER));
    expect(r.errors).toEqual([]);
    expect(r.payload?.servers[0]).toMatchObject({ name: "remote-api", transport: "http", url: "https://mcp.example.com/v1", headers: { Authorization: "Bearer ${API_TOKEN}" } });
    expect(r.payload?.requiresEnv).toEqual(["API_TOKEN"]);
  });

  it("dedupes + sorts requiresEnv across multiple servers", () => {
    const r = loadMcpPayload(payload(STDIO_NPX, HTTP_BEARER, { name: "b", transport: "stdio", command: "node", env: { DB_URL: "${DB_URL}", X: "${ZED}" } }));
    expect(r.errors).toEqual([]);
    expect(r.payload?.requiresEnv).toEqual(["API_TOKEN", "DB_URL", "ZED"]);
  });

  it("defaults args/env/headers to empty when omitted", () => {
    const r = loadMcpPayload(payload({ name: "bare", transport: "stdio", command: "node" }));
    expect(r.payload?.servers[0]).toEqual({ name: "bare", transport: "stdio", command: "node", args: [], env: {} });
  });
});

describe("loadMcpPayload — structural rejects (fail-closed)", () => {
  const bad = (text: string) => loadMcpPayload(text).errors.length > 0 && !loadMcpPayload(text).payload;
  it("rejects non-JSON / non-object / missing servers", () => {
    expect(bad("not json")).toBe(true);
    expect(bad(JSON.stringify([STDIO_NPX]))).toBe(true); // top-level array
    expect(bad(JSON.stringify({ servers: [] }))).toBe(true); // empty
    expect(bad(JSON.stringify({}))).toBe(true);
  });
  it("rejects unknown top-level fields", () => {
    expect(bad(JSON.stringify({ servers: [STDIO_NPX], extra: 1 }))).toBe(true);
  });
  it("rejects unknown per-server keys (incl. a field from the wrong transport)", () => {
    expect(bad(payload({ ...STDIO_NPX, url: "https://x.test" }))).toBe(true); // url on stdio
    expect(bad(payload({ name: "h", transport: "http", url: "https://x.test", command: "npx" }))).toBe(true); // command on http
  });
  it("rejects a bad / reserved / duplicate name", () => {
    expect(bad(payload({ ...STDIO_NPX, name: "Db_Tools" }))).toBe(true); // not kebab
    expect(bad(payload({ ...STDIO_NPX, name: "tachyon" }))).toBe(true); // reserved
    expect(bad(payload({ ...STDIO_NPX, name: "tachyon_bridge" }))).toBe(true);
    expect(bad(payload(STDIO_NPX, STDIO_NPX))).toBe(true); // duplicate
  });
  it("rejects an unknown transport", () => {
    expect(bad(payload({ name: "x", transport: "ws", url: "wss://x.test" }))).toBe(true);
  });
});

describe("loadMcpPayload — secret hygiene (D4)", () => {
  it("rejects a literal env value (only exact ${VAR} allowed)", () => {
    const r = loadMcpPayload(payload({ name: "x", transport: "stdio", command: "npx", env: { API_KEY: "sk-abc123" } }));
    expect(r.payload).toBeUndefined();
    expect(r.errors.join(" ")).toMatch(/exact \$\{VAR\} reference/);
  });
  it("rejects a partial-ref / embedded env value", () => {
    expect(loadMcpPayload(payload({ name: "x", transport: "stdio", command: "npx", env: { K: "prefix-${V}" } })).payload).toBeUndefined();
  });
  it("rejects a literal (no-ref) http header — a possible hard-coded secret", () => {
    expect(loadMcpPayload(payload({ name: "x", transport: "http", url: "https://x.test", headers: { Authorization: "Bearer sk-literal" } })).payload).toBeUndefined();
  });
  it("rejects a secret hidden BESIDE a valid ref (the codex bypass: 'Bearer ${T} sk-live')", () => {
    expect(loadMcpPayload(payload({ name: "x", transport: "http", url: "https://x.test", headers: { Authorization: "Bearer ${TOKEN} sk-live-secret" } })).payload).toBeUndefined();
    expect(loadMcpPayload(payload({ name: "x", transport: "http", url: "https://x.test", headers: { Authorization: "sk-live ${TOKEN}" } })).payload).toBeUndefined();
  });
  it("rejects multiple refs in one header value (v1 = exactly one)", () => {
    expect(loadMcpPayload(payload({ name: "x", transport: "http", url: "https://x.test", headers: { Auth: "${A} ${B}" } })).payload).toBeUndefined();
  });
  it("accepts bare ${VAR} and a single auth-scheme prefix (case-insensitive scheme)", () => {
    expect(loadMcpPayload(payload({ name: "x", transport: "http", url: "https://x.test", headers: { "X-Key": "${KEY}" } })).errors).toEqual([]);
    expect(loadMcpPayload(payload({ name: "x", transport: "http", url: "https://x.test", headers: { authorization: "Bearer ${TOKEN}" } })).errors).toEqual([]);
  });
});

describe("loadMcpPayload — prototype-pollution + header case (codex HIGH/MEDIUM)", () => {
  it("rejects __proto__/constructor/prototype as an env key", () => {
    for (const k of ["__proto__", "constructor", "prototype"]) {
      expect(loadMcpPayload(payload({ name: "x", transport: "stdio", command: "npx", env: { [k]: "${TOKEN}" } })).payload).toBeUndefined();
    }
  });
  it("rejects case-duplicated headers (Authorization + authorization)", () => {
    expect(loadMcpPayload(payload({ name: "x", transport: "http", url: "https://x.test", headers: { Authorization: "Bearer ${A}", authorization: "Bearer ${B}" } })).payload).toBeUndefined();
  });
  it("derived env uses own keys only — requiresEnv == mcpRequiredEnv(servers)", () => {
    const r = loadMcpPayload(payload(STDIO_NPX, HTTP_BEARER));
    expect(r.payload!.requiresEnv).toEqual(mcpRequiredEnv(r.payload!.servers));
  });
  it("mcpRequiredEnv is stable across repeated calls (no global-regex lastIndex bug)", () => {
    const servers = loadMcpPayload(payload(HTTP_BEARER, { name: "y", transport: "http", url: "https://y.test", headers: { "X-Key": "${KEY}" } })).payload!.servers;
    const first = mcpRequiredEnv(servers);
    expect(mcpRequiredEnv(servers)).toEqual(first);
    expect(first).toEqual(["API_TOKEN", "KEY"]);
  });
});

describe("loadMcpPayload — caps", () => {
  it("rejects too many args / env / headers and an over-long string", () => {
    expect(loadMcpPayload(payload({ name: "x", transport: "stdio", command: "npx", args: Array.from({ length: 65 }, () => "-x") })).payload).toBeUndefined();
    const env: Record<string, string> = {};
    for (let i = 0; i < 65; i++) env[`V${i}`] = "${X}";
    expect(loadMcpPayload(payload({ name: "x", transport: "stdio", command: "npx", env })).payload).toBeUndefined();
    const headers: Record<string, string> = {};
    for (let i = 0; i < 33; i++) headers[`H-${i}`] = "${X}";
    expect(loadMcpPayload(payload({ name: "x", transport: "http", url: "https://x.test", headers })).payload).toBeUndefined();
    expect(loadMcpPayload(payload({ name: "x", transport: "stdio", command: "x".repeat(1025) })).payload).toBeUndefined();
  });
});

describe("loadMcpPayload — ${PLUGIN_ROOT} containment (OQ4)", () => {
  it("rejects a path escape after ${PLUGIN_ROOT}/", () => {
    expect(loadMcpPayload(payload({ name: "x", transport: "stdio", command: "${PLUGIN_ROOT}/../../etc/passwd" })).payload).toBeUndefined();
    expect(loadMcpPayload(payload({ name: "x", transport: "stdio", command: "node", args: ["${PLUGIN_ROOT}/../escape"] })).payload).toBeUndefined();
  });
  it("rejects ${PLUGIN_ROOT} not used as a leading token", () => {
    expect(loadMcpPayload(payload({ name: "x", transport: "stdio", command: "node", args: ["--config=${PLUGIN_ROOT}/c.json"] })).payload).toBeUndefined();
  });
  it("rejects a ${VAR}/general substitution inside an arg (no secret smuggling into argv)", () => {
    expect(loadMcpPayload(payload({ name: "x", transport: "stdio", command: "npx", args: ["${SECRET}"] })).payload).toBeUndefined();
  });
  it("rejects an absolute or metachar command", () => {
    expect(loadMcpPayload(payload({ name: "x", transport: "stdio", command: "/usr/bin/evil" })).payload).toBeUndefined();
    expect(loadMcpPayload(payload({ name: "x", transport: "stdio", command: "a; rm -rf /" })).payload).toBeUndefined();
  });
});

describe("loadMcpPayload — url + caps", () => {
  it("rejects a non-http(s) url and a url with substitution", () => {
    expect(loadMcpPayload(payload({ name: "x", transport: "http", url: "ftp://x.test" })).payload).toBeUndefined();
    expect(loadMcpPayload(payload({ name: "x", transport: "http", url: "https://x.test/${V}" })).payload).toBeUndefined();
  });
  it("rejects too many servers", () => {
    const many = Array.from({ length: 33 }, (_, i) => ({ name: `s-${i}`, transport: "stdio", command: "node" }));
    expect(loadMcpPayload(JSON.stringify({ servers: many })).payload).toBeUndefined();
  });
});

describe("mcpRequiredEnv — matches the parsed payload's derived list", () => {
  it("recomputes the same refs from validated servers", () => {
    const servers = loadMcpPayload(payload(STDIO_NPX, HTTP_BEARER)).payload!.servers as McpServer[];
    expect(mcpRequiredEnv(servers)).toEqual(["API_TOKEN", "DB_URL"]);
  });
});
