import { describe, it, expect } from "vitest";
import {
  buildClaudeMcpJson,
  buildOpencodeJson,
  codexSnippet,
  buildOffers,
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
    expect(offers.find((o) => o.runtime === "codex")?.file).toBeUndefined();
    expect(offers.find((o) => o.runtime === "generic")?.snippet).toBe(URL);
  });
});
