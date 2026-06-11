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
