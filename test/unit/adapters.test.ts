import { describe, it, expect } from "vitest";
import {
  buildClaudeMcpJson,
  buildOpencodeJson,
  codexSnippet,
  buildCodexToml,
  codexAlreadyRegistered,
  buildOffers,
  claudeAlreadyRegistered,
  opencodeAlreadyRegistered,
  setClaudeMcpServer,
  removeClaudeMcpServer,
  claudeMcpServerMatches,
  setCodexMcpServer,
  removeCodexMcpServer,
  expectedAgentClaudeEntry,
  expectedAgentOpencodeEntry,
  setOpencodeMcpServer,
  buildAgentOpencodeJson,
  AGENT_TOKEN_ENV_REF_CLAUDE,
  AGENT_TOKEN_ENV_REF_OPENCODE,
  TOKEN_ENV_REF_CLAUDE,
  TOKEN_ENV_REF_OPENCODE,
} from "../../src/registration/adapters.js";

const URL = "http://127.0.0.1:43210/mcp";

describe("buildClaudeMcpJson", () => {
  it("creates a fresh .mcp.json", () => {
    const out = JSON.parse(buildClaudeMcpJson(undefined, URL));
    expect(out.mcpServers.tachyon).toEqual({ type: "http", url: URL });
  });

  it("merges into an existing file preserving other servers", () => {
    const existing = JSON.stringify({ mcpServers: { playwright: { command: "npx" } } });
    const out = JSON.parse(buildClaudeMcpJson(existing, URL));
    expect(out.mcpServers.playwright).toEqual({ command: "npx" });
    expect(out.mcpServers.tachyon.url).toBe(URL);
  });

  it("overwrites a stale tachyon entry (port changes across restarts)", () => {
    const existing = JSON.stringify({ mcpServers: { tachyon: { type: "http", url: "http://127.0.0.1:1/mcp" } } });
    const out = JSON.parse(buildClaudeMcpJson(existing, URL));
    expect(out.mcpServers.tachyon.url).toBe(URL);
  });

  it("throws on a non-object existing file", () => {
    expect(() => buildClaudeMcpJson("[1,2]", URL)).toThrow("not a JSON object");
    expect(() => buildClaudeMcpJson("{nope", URL)).toThrow();
  });
});

describe("buildOpencodeJson", () => {
  it("creates a fresh opencode.json with $schema", () => {
    const out = JSON.parse(buildOpencodeJson(undefined, URL));
    expect(out.$schema).toContain("opencode");
    expect(out.mcp.tachyon).toEqual({ type: "remote", url: URL, enabled: true });
  });

  it("merges preserving existing mcp entries and $schema", () => {
    const existing = JSON.stringify({ $schema: "custom", mcp: { other: { type: "local" } } });
    const out = JSON.parse(buildOpencodeJson(existing, URL));
    expect(out.$schema).toBe("custom");
    expect(out.mcp.other).toEqual({ type: "local" });
    expect(out.mcp.tachyon.url).toBe(URL);
  });
});

describe("idempotent registration", () => {
  it("detects an up-to-date .mcp.json (no-op connect)", () => {
    const current = buildClaudeMcpJson(undefined, URL);
    expect(claudeAlreadyRegistered(current, URL)).toBe(true);
    expect(buildOffers(URL, { claudeMcpJson: current }).find((o) => o.runtime === "claude-code")?.upToDate).toBe(true);
  });

  it("stale port or absent entry => not up to date", () => {
    const stale = buildClaudeMcpJson(undefined, "http://127.0.0.1:1/mcp");
    expect(claudeAlreadyRegistered(stale, URL)).toBe(false);
    expect(claudeAlreadyRegistered(JSON.stringify({ mcpServers: { other: {} } }), URL)).toBe(false);
    expect(claudeAlreadyRegistered(undefined, URL)).toBe(false);
    expect(claudeAlreadyRegistered("{broken", URL)).toBe(false);
  });

  it("re-merging an already-correct file is byte-stable (idempotent)", () => {
    const pre = JSON.stringify({ mcpServers: { playwright: { command: "npx" } } });
    const once = buildClaudeMcpJson(pre, URL);
    const twice = buildClaudeMcpJson(once, URL);
    expect(twice).toBe(once);
    expect(JSON.parse(twice).mcpServers.playwright).toEqual({ command: "npx" });

    const oOnce = buildOpencodeJson(pre.replace("mcpServers", "mcp"), URL);
    const oTwice = buildOpencodeJson(oOnce, URL);
    expect(oTwice).toBe(oOnce);
    expect(opencodeAlreadyRegistered(oTwice, URL)).toBe(true);
  });
});

describe("codexSnippet / buildOffers", () => {
  it("codex snippet carries the url and the stdio fallback", () => {
    const snippet = codexSnippet(URL);
    expect(snippet).toContain(`url = "${URL}"`);
    expect(snippet).toContain("mcp-remote");
  });

  it("offers cover the 3 known runtimes + generic, with files only for workspace-scoped ones", () => {
    const offers = buildOffers(URL, {});
    expect(offers.map((o) => o.runtime)).toEqual(["claude-code", "opencode", "codex", "generic"]);
    expect(offers.find((o) => o.runtime === "claude-code")?.file).toBe(".mcp.json");
    expect(offers.find((o) => o.runtime === "opencode")?.file).toBe("opencode.json");
    expect(offers.find((o) => o.runtime === "codex")?.file).toBe(".codex/config.toml");
    expect(offers.find((o) => o.runtime === "generic")?.snippet).toBe(URL);
  });
});

describe("buildCodexToml (project-scoped .codex/config.toml merge)", () => {
  it("writes the tachyon block into an empty file (with auth)", () => {
    const out = buildCodexToml(undefined, URL, true);
    expect(out).toContain("[mcp_servers.tachyon]");
    expect(out).toContain(`url = "${URL}"`);
    expect(out).toContain('bearer_token_env_var = "TACHYON_BRIDGE_TOKEN"');
  });

  it("preserves other servers and settings; replaces only the tachyon block", () => {
    const existing = [
      "model = \"gpt-5-codex\"",
      "",
      "[mcp_servers.github]",
      "url = \"https://mcp.github.com/\"",
      "",
      "[mcp_servers.tachyon]",
      "url = \"http://127.0.0.1:1/mcp\"",
      "",
      "[other]",
      "keep = true",
    ].join("\n");
    const out = buildCodexToml(existing, URL, false);
    expect(out).toContain("model = \"gpt-5-codex\"");      // settings kept
    expect(out).toContain("[mcp_servers.github]");          // other server kept
    expect(out).toContain("[other]");                        // trailing table kept
    expect(out).toContain(`url = "${URL}"`);                 // tachyon updated
    expect(out).not.toContain("127.0.0.1:1");                // old tachyon url gone
    // exactly one tachyon block
    expect(out.match(/\[mcp_servers\.tachyon\]/g)).toHaveLength(1);
  });

  it("appends when there is no tachyon block yet", () => {
    const out = buildCodexToml("[mcp_servers.other]\nurl = \"x\"\n", URL, false);
    expect(out).toContain("[mcp_servers.other]");
    expect(out).toContain("[mcp_servers.tachyon]");
  });

  it("codexAlreadyRegistered: true only when url (and auth) match", () => {
    const reg = buildCodexToml(undefined, URL, true);
    expect(codexAlreadyRegistered(reg, URL, true)).toBe(true);
    expect(codexAlreadyRegistered(reg, "http://other/mcp", true)).toBe(false);
    expect(codexAlreadyRegistered(buildCodexToml(undefined, URL, false), URL, true)).toBe(false); // auth required but absent
    expect(codexAlreadyRegistered(undefined, URL, false)).toBe(false);
  });
});

describe("generic MCP server writer (spec 254 Step 3 — shared with the Bridge)", () => {
  const stdio = { command: "npx", args: ["-y", "@scope/db"], env: { DB_URL: "${DB_URL}" } };

  it("setClaudeMcpServer merges an arbitrary-named server, preserving others", () => {
    const existing = JSON.stringify({ mcpServers: { tachyon: { type: "http", url: URL } } });
    const out = JSON.parse(setClaudeMcpServer(existing, "db-tools", stdio));
    expect(out.mcpServers.tachyon).toEqual({ type: "http", url: URL }); // Bridge untouched
    expect(out.mcpServers["db-tools"]).toEqual(stdio);
  });

  it("claudeMcpServerMatches is exact + setClaudeMcpServer is idempotent", () => {
    const once = setClaudeMcpServer(undefined, "db-tools", stdio);
    expect(claudeMcpServerMatches(once, "db-tools", stdio)).toBe(true);
    expect(claudeMcpServerMatches(once, "db-tools", { ...stdio, command: "node" })).toBe(false);
    expect(setClaudeMcpServer(once, "db-tools", stdio)).toBe(once); // byte-stable
  });

  it("removeClaudeMcpServer removes exactly one, preserves others, byte-stable no-op when absent", () => {
    const two = setClaudeMcpServer(JSON.stringify({ mcpServers: { tachyon: { type: "http", url: URL } } }), "db-tools", stdio);
    const out = JSON.parse(removeClaudeMcpServer(two, "db-tools"));
    expect(out.mcpServers.tachyon).toEqual({ type: "http", url: URL });
    expect(out.mcpServers["db-tools"]).toBeUndefined();
    const noop = JSON.stringify({ mcpServers: { other: {} } });
    expect(removeClaudeMcpServer(noop, "db-tools")).toBe(noop); // absent → original bytes
    // removing the only server drops the mcpServers key
    expect(JSON.parse(removeClaudeMcpServer(setClaudeMcpServer(undefined, "solo", stdio), "solo")).mcpServers).toBeUndefined();
  });

  it("treats a prototype-name like 'constructor' as absent (Object.hasOwn, not `in`)", () => {
    const noop = JSON.stringify({ mcpServers: { other: {} } });
    expect(removeClaudeMcpServer(noop, "constructor")).toBe(noop); // byte-stable no-op despite Object.prototype.constructor
    // but a real own 'constructor' server is removable
    const withCtor = setClaudeMcpServer(noop, "constructor", stdio);
    expect(JSON.parse(withCtor).mcpServers.constructor).toEqual(stdio); // own 'constructor' shadows the proto
    // after removal the OWN key is gone (`.constructor` would read the inherited Object — use hasOwn).
    expect(Object.hasOwn(JSON.parse(removeClaudeMcpServer(withCtor, "constructor")).mcpServers, "constructor")).toBe(false);
  });

  it("setCodexMcpServer replace-in-place is byte-stable on repeat", () => {
    const existing = "model = \"x\"\n\n[mcp_servers.github]\nurl = \"https://g\"\n";
    const block = `[mcp_servers.db-tools]\ncommand = "npx"\n`;
    const once = setCodexMcpServer(existing, "db-tools", block);
    expect(setCodexMcpServer(once, "db-tools", block)).toBe(once); // idempotent replace
  });

  it("setCodexMcpServer inserts/replaces a hyphenated-name block, preserving other tables", () => {
    const block = `[mcp_servers.db-tools]\ncommand = "npx"\n`;
    const existing = "[mcp_servers.github]\nurl = \"https://g\"\n";
    const out = setCodexMcpServer(existing, "db-tools", block);
    expect(out).toContain("[mcp_servers.github]");
    expect(out).toContain("[mcp_servers.db-tools]");
    // replace in place (exactly one block, other table kept)
    const replaced = setCodexMcpServer(out, "db-tools", `[mcp_servers.db-tools]\ncommand = "node"\n`);
    expect(replaced.match(/\[mcp_servers\.db-tools\]/g)).toHaveLength(1);
    expect(replaced).toContain('command = "node"');
    expect(replaced).toContain("[mcp_servers.github]");
  });

  it("removeCodexMcpServer removes one block, preserves others, no-op when absent", () => {
    const existing = "[mcp_servers.github]\nurl = \"https://g\"\n\n[mcp_servers.db-tools]\ncommand = \"npx\"\n";
    const out = removeCodexMcpServer(existing, "db-tools");
    expect(out).toContain("[mcp_servers.github]");
    expect(out).not.toContain("db-tools");
    expect(removeCodexMcpServer(existing, "absent")).toBe(existing); // byte-stable no-op
  });
});

describe("expectedAgentClaudeEntry (spec 351)", () => {
  it("references the per-agent token var, distinct from the human/legacy registration ref", () => {
    const entry = expectedAgentClaudeEntry(URL, true);
    expect(entry).toEqual({ type: "http", url: URL, headers: { Authorization: AGENT_TOKEN_ENV_REF_CLAUDE } });
    expect(AGENT_TOKEN_ENV_REF_CLAUDE).not.toBe(TOKEN_ENV_REF_CLAUDE);
    expect(AGENT_TOKEN_ENV_REF_CLAUDE).toContain("TACHYON_AGENT_BRIDGE_TOKEN");
  });

  it("omits headers entirely when auth is off, same as expectedClaudeEntry", () => {
    expect(expectedAgentClaudeEntry(URL, false)).toEqual({ type: "http", url: URL });
  });
});

describe("expectedAgentOpencodeEntry (spec 236 / 351)", () => {
  it("references the per-agent token var via opencode's {env:VAR} ref, distinct from the human/legacy ref", () => {
    const entry = expectedAgentOpencodeEntry(URL, true);
    expect(entry).toEqual({ type: "remote", url: URL, enabled: true, headers: { Authorization: AGENT_TOKEN_ENV_REF_OPENCODE } });
    expect(AGENT_TOKEN_ENV_REF_OPENCODE).not.toBe(TOKEN_ENV_REF_OPENCODE);
    expect(AGENT_TOKEN_ENV_REF_OPENCODE).toBe("Bearer {env:TACHYON_AGENT_BRIDGE_TOKEN}");
  });

  it("omits headers entirely when auth is off, same as expectedOpencodeEntry", () => {
    expect(expectedAgentOpencodeEntry(URL, false)).toEqual({ type: "remote", url: URL, enabled: true });
  });
});

describe("setOpencodeMcpServer / buildAgentOpencodeJson (spec 236)", () => {
  it("creates a fresh file with $schema + the named server (no existing content)", () => {
    const out = setOpencodeMcpServer(undefined, "tachyon_bridge", expectedAgentOpencodeEntry(URL, true));
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    const mcp = parsed.mcp as Record<string, { type: string; url: string; enabled: boolean; headers: { Authorization: string } }>;
    expect(mcp.tachyon_bridge.type).toBe("remote");
    expect(mcp.tachyon_bridge.headers.Authorization).toBe("Bearer {env:TACHYON_AGENT_BRIDGE_TOKEN}");
  });

  it("buildAgentOpencodeJson folds the bridge server into an existing project opencode.json, preserving other servers", () => {
    const existing = JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { userTool: { type: "local", command: ["echo"] } } });
    const out = buildAgentOpencodeJson(existing, URL, true);
    const parsed = JSON.parse(out) as { $schema: string; mcp: Record<string, unknown> };
    expect(Object.keys(parsed.mcp).sort()).toEqual(["tachyon_bridge", "userTool"]);
    const bridge = parsed.mcp.tachyon_bridge as { headers: { Authorization: string } };
    expect(bridge.headers.Authorization).toBe("Bearer {env:TACHYON_AGENT_BRIDGE_TOKEN}");
  });

  it("throws when existing opencode.json is not a JSON object", () => {
    expect(() => setOpencodeMcpServer("[]", "tachyon_bridge", {})).toThrow(/not a JSON object/);
  });
});
