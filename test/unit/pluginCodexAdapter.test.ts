import { describe, it, expect } from "vitest";
import { parseCodexHooksBlock, CODEX_HOOK_EVENTS } from "../../src/plugins/adapters/codex.js";
import { parseClaudeHooksBlock } from "../../src/plugins/adapters/claude.js";
import { mergeHooks, removeHooks } from "../../src/plugins/adapters/hooks.js";

describe("parseCodexHooksBlock", () => {
  it("accepts a codex block with a statusMessage + codex-native matcher", () => {
    const { hooks, errors } = parseCodexHooksBlock(
      JSON.stringify({ PreToolUse: [{ matcher: "^apply_patch$", hooks: [{ type: "command", command: "x.sh", statusMessage: "checking" }] }] }),
    );
    expect(errors).toEqual([]);
    expect(hooks!.PreToolUse[0].matcher).toBe("^apply_patch$");
    expect(hooks!.PreToolUse[0].hooks[0].statusMessage).toBe("checking");
  });

  it("accepts SubagentStart/SubagentStop (verified against a live codex config)", () => {
    const { hooks, errors } = parseCodexHooksBlock(JSON.stringify({ SubagentStop: [{ hooks: [{ type: "command", command: "x" }] }] }));
    expect(errors).toEqual([]);
    expect(hooks!.SubagentStop).toHaveLength(1);
  });

  it("rejects a claude-only event (PostToolUseFailure) that codex does not expose", () => {
    const { hooks, errors } = parseCodexHooksBlock(JSON.stringify({ PostToolUseFailure: [{ hooks: [{ type: "command", command: "x" }] }] }));
    expect(hooks).toBeUndefined();
    expect(errors.some((e) => /not a known codex hook event/.test(e))).toBe(true);
  });

  it("claude REJECTS a statusMessage codex accepts (fail-closed parity, not a lossy drop)", () => {
    const withStatus = JSON.stringify({ PreToolUse: [{ hooks: [{ type: "command", command: "x", statusMessage: "y" }] }] });
    const claude = parseClaudeHooksBlock(withStatus);
    expect(claude.hooks).toBeUndefined();
    expect(claude.errors.some((e) => /statusMessage: not supported/.test(e))).toBe(true);
    const codex = parseCodexHooksBlock(withStatus);
    expect(codex.hooks!.PreToolUse[0].hooks[0].statusMessage).toBe("y"); // codex preserves it
  });

  it("CODEX_HOOK_EVENTS includes Subagent* (live-verified), excludes claude-only PostToolUseFailure", () => {
    expect(CODEX_HOOK_EVENTS.has("SubagentStart")).toBe(true);
    expect(CODEX_HOOK_EVENTS.has("SubagentStop")).toBe(true);
    expect(CODEX_HOOK_EVENTS.has("PostToolUseFailure")).toBe(false);
  });
});

describe("codex shares the hooks-map core (merge/remove round-trip with statusMessage)", () => {
  it("merges + un-merges a codex block, statusMessage surviving content-match removal", () => {
    const block = parseCodexHooksBlock(JSON.stringify({ Stop: [{ hooks: [{ type: "command", command: '"${TACHYON_PLUGIN_ROOT}"/s.sh', statusMessage: "bye" }] }] })).hooks!;
    const root = ".tachyon/plugins/p/codex";
    const { settings, owned } = mergeHooks({}, block, root);
    const grp = settings!.hooks!.Stop[0] as { hooks: Array<{ command: string; statusMessage?: string }> };
    expect(grp.hooks[0].command).toBe(`"${root}"/s.sh`);
    expect(grp.hooks[0].statusMessage).toBe("bye");
    const back = removeHooks(settings, owned!).settings;
    expect(back!.hooks).toBeUndefined(); // exact un-merge
  });
});
