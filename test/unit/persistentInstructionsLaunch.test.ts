import { describe, expect, it } from "vitest";
import {
  PERSISTENT_INSTRUCTIONS_SOURCE_MAX_BYTES,
  persistentInstructionsLaunchArgs,
} from "@tachyon/engine/agents/persistentInstructionsLaunch.js";

describe("persistent profile instructions launch projection (t-d3ace4)", () => {
  it("projects Claude through the measured file form — removing Claude's branch makes this red", () => {
    expect(persistentInstructionsLaunchArgs({
      agent: "claude-owner",
      runtime: "claude",
      instructions: "OWNER_CANARY_CLAUDE",
      claudeFile: "/private/claude-owner/instructions.md",
    })).toEqual(["--append-system-prompt-file", "'/private/claude-owner/instructions.md'"]);
  });

  it("projects Grok through --rules — removing Grok's branch makes this red", () => {
    expect(persistentInstructionsLaunchArgs({
      agent: "grok-owner",
      runtime: "grok",
      instructions: "OWNER_CANARY_GROK",
    })).toEqual(["--rules", "'OWNER_CANARY_GROK'"]);
  });

  it("projects Codex through a TOML developer_instructions override — removing Codex's branch makes this red", () => {
    expect(persistentInstructionsLaunchArgs({
      agent: "codex-owner",
      runtime: "codex",
      instructions: "line 1\nowner's \"rule\"",
    })).toEqual(["-c", "'developer_instructions=\"line 1\\nowner'\\''s \\\"rule\\\"\"'"]);
  });

  it.each(["claude", "codex", "grok"])("adds no empty %s flag", (runtime) => {
    expect(persistentInstructionsLaunchArgs({ agent: "empty", runtime, instructions: "  ", claudeFile: "/unused" })).toEqual([]);
  });

  it.each(["claude", "codex", "grok"])("fails legibly without truncating oversized %s content", (runtime) => {
    const body = "x".repeat(PERSISTENT_INSTRUCTIONS_SOURCE_MAX_BYTES + 1);
    expect(() => persistentInstructionsLaunchArgs({ agent: "oversized", runtime, instructions: body, claudeFile: "/unused" }))
      .toThrow(`agent 'oversized' ${runtime} persistent instructions are 131001 UTF-8 bytes`);
  });

  it("checks Codex's encoded argument after TOML escaping", () => {
    const body = "x\n".repeat(65_000);
    expect(() => persistentInstructionsLaunchArgs({ agent: "encoded", runtime: "codex", instructions: body }))
      .toThrow("codex persistent instructions encode to 195025 argument bytes");
  });
});
