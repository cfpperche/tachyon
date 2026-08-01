import { describe, expect, it } from "vitest";
import {
  agentMemoryScopeSupport,
  agentMemoryScopeUnitName,
  parseAgentMemoryMax,
  posixShellQuote,
  wrapAgentMemoryScopeCommand,
} from "../../src/agents/agentMemoryScope.js";

describe("agentMemoryScope (t-0d0152)", () => {
  it("parses MemoryMax forms and treats off as unset", () => {
    expect(parseAgentMemoryMax("2G")).toBe("2G");
    expect(parseAgentMemoryMax("512m")).toBe("512M");
    expect(parseAgentMemoryMax("50%")).toBe("50%");
    expect(parseAgentMemoryMax("off")).toBeUndefined();
    expect(parseAgentMemoryMax("")).toBeUndefined();
    expect(parseAgentMemoryMax("nope")).toBeUndefined();
  });

  it("builds stable systemd unit names", () => {
    const u = agentMemoryScopeUnitName("b349073a65a4a4d4", "hermes.child", "deadbeef99");
    expect(u).toBe('tachyon-mem-b349073a-hermes-child-deadbeef.scope');
  });

  it("wraps command with systemd-run MemoryMax", () => {
    const cmd = wrapAgentMemoryScopeCommand("tachyon-mem-ws-agent-abc.scope", "2G", "echo hi && sleep 1");
    expect(cmd).toContain("systemd-run --user --scope --collect");
    expect(cmd).toContain("MemoryMax=2G");
    expect(cmd).toContain("--unit='tachyon-mem-ws-agent-abc.scope'");
    expect(cmd).toContain("/bin/sh -c 'echo hi && sleep 1'");
  });

  it("posixShellQuote escapes embedded single quotes", () => {
    expect(posixShellQuote("a")).toBe("'a'");
    expect(posixShellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("reports non-linux as unsupported", () => {
    expect(agentMemoryScopeSupport("darwin").ok).toBe(false);
    expect(agentMemoryScopeSupport("linux").ok).toBe(true);
  });
});
