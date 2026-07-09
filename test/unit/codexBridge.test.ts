import { describe, it, expect } from "vitest";
import { codexBridgeCmd, codexConfigCmd, codexFlagCmd } from "../../src/config/loadConfig";

const URL = "http://127.0.0.1:42086/mcp";
const expected = `-c 'mcp_servers.tachyon_bridge={url="${URL}", bearer_token_env_var="TACHYON_AGENT_BRIDGE_TOKEN"}'`;

describe("codexBridgeCmd (spec 232)", () => {
  it("inserts the -c override right after a bare `codex`", () => {
    expect(codexBridgeCmd("codex", URL)).toBe(`codex ${expected}`);
  });

  it("inserts after the binary, before existing codex flags", () => {
    expect(codexBridgeCmd("codex --model gpt-5.5", URL)).toBe(`codex ${expected} --model gpt-5.5`);
  });

  it("handles the `codex exec` subcommand (flag goes after the binary)", () => {
    expect(codexBridgeCmd("codex exec", URL)).toBe(`codex ${expected} exec`);
  });

  it("sees through an `env VAR=1` launcher", () => {
    expect(codexBridgeCmd("env FOO=1 codex", URL)).toBe(`env FOO=1 codex ${expected}`);
  });

  it("sees through an `npx` launcher", () => {
    expect(codexBridgeCmd("npx codex", URL)).toBe(`npx codex ${expected}`);
  });

  it("is a no-op for a non-codex command", () => {
    expect(codexBridgeCmd("claude", URL)).toBe("claude");
    expect(codexBridgeCmd("sh -c 'echo hi'", URL)).toBe("sh -c 'echo hi'");
  });

  it("never places the bearer token on the command line (only the env-var NAME)", () => {
    const out = codexBridgeCmd("codex", URL);
    expect(out).toContain('bearer_token_env_var="TACHYON_AGENT_BRIDGE_TOKEN"');
    expect(out).not.toMatch(/Bearer\s/); // no literal token material
  });

  it("uses a collision-safe server name (not `tachyon`) so a user's stdio `tachyon` is untouched", () => {
    expect(codexBridgeCmd("codex", URL)).toContain("mcp_servers.tachyon_bridge=");
  });

  it("spec 236: is idempotent — re-injecting an already-injected cmd is a no-op (no second -c)", () => {
    const once = codexBridgeCmd("codex --model gpt-5.5", URL);
    expect(codexBridgeCmd(once, URL)).toBe(once);
    // even with a different URL, the present tachyon_bridge block wins (re-spawn keeps the first)
    expect(codexBridgeCmd(once, "http://127.0.0.1:1/mcp")).toBe(once);
  });

  it("spec 236: preserves a trailing prompt positional verbatim (no whitespace/newline collapse)", () => {
    // codex gets an instructions positional, so the composed command carries a shell-quoted prompt with
    // internal double-spaces + newlines — the -c must splice WITHOUT round-tripping (corrupting) it.
    const prompt = "'line one\n\nline  two   spaced'";
    const out = codexBridgeCmd(`codex ${prompt}`, URL);
    expect(out).toBe(`codex ${expected} ${prompt}`); // prompt byte-identical after the -c block
    expect(out).toContain("line one\n\nline  two   spaced"); // newlines + double-spaces intact
  });

  it("spec 236: does not false-trigger idempotency when the PROMPT contains `-c mcp_servers.tachyon_bridge`", () => {
    // codex's round-2 repro: the prompt positional literally contains the flag-like text. Idempotency only
    // inspects the slot right after the binary (where WE splice), so injection still proceeds.
    const out = codexBridgeCmd("codex 'tell me about -c mcp_servers.tachyon_bridge'", URL);
    expect(out).toBe(`codex ${expected} 'tell me about -c mcp_servers.tachyon_bridge'`);
  });
});

describe("codexConfigCmd (spec 303)", () => {
  it("inserts a generic -c override right after the codex binary", () => {
    expect(codexConfigCmd("codex --model gpt-5.5", "hooks.SessionStart=[{hooks=[]}]")).toBe("codex -c 'hooks.SessionStart=[{hooks=[]}]' --model gpt-5.5");
  });

  it("preserves a trailing prompt positional verbatim", () => {
    const prompt = "'line one\n\nline  two'";
    expect(codexConfigCmd(`codex ${prompt}`, "hooks.SessionStart=[{hooks=[]}]")).toBe(`codex -c 'hooks.SessionStart=[{hooks=[]}]' ${prompt}`);
  });

  it("inserts multiple generic -c overrides as separate key=value args", () => {
    expect(codexConfigCmd("codex --model gpt-5.5", ["hooks.SessionStart=[{hooks=[]}]", "hooks.Stop=[{hooks=[]}]"])).toBe("codex -c 'hooks.SessionStart=[{hooks=[]}]' -c 'hooks.Stop=[{hooks=[]}]' --model gpt-5.5");
  });

  it("is a no-op for non-codex commands", () => {
    expect(codexConfigCmd("claude", "hooks.SessionStart=[{hooks=[]}]")).toBe("claude");
  });
});

describe("codexFlagCmd", () => {
  const flag = "--dangerously-bypass-hook-trust";

  it("inserts a flag right after the codex binary", () => {
    expect(codexFlagCmd("codex --model gpt-5.5", flag)).toBe("codex --dangerously-bypass-hook-trust --model gpt-5.5");
  });

  it("preserves a trailing prompt positional verbatim", () => {
    const prompt = "'line one\n\nline  two'";
    expect(codexFlagCmd(`codex ${prompt}`, flag)).toBe(`codex --dangerously-bypass-hook-trust ${prompt}`);
  });

  it("is idempotent and no-ops for non-codex commands", () => {
    expect(codexFlagCmd("codex --dangerously-bypass-hook-trust", flag)).toBe("codex --dangerously-bypass-hook-trust");
    expect(codexFlagCmd("claude", flag)).toBe("claude");
  });

  it("does not mistake flag text inside the prompt for a real argv flag", () => {
    const prompt = "'review text mentioning --dangerously-bypass-hook-trust as prose'";
    const out = codexFlagCmd(`codex ${prompt}`, flag);
    expect(out).toBe(`codex --dangerously-bypass-hook-trust ${prompt}`);
    expect(out.match(/--dangerously-bypass-hook-trust/g)).toHaveLength(2);
  });
});
