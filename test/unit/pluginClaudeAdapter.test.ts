import { describe, it, expect } from "vitest";
import {
  parseClaudeHooksBlock,
  normalizeClaudeSettings,
  mergePluginHooks,
  removePluginHooks,
  PLUGIN_ROOT_PLACEHOLDER,
  type ClaudeSettings,
} from "../../src/plugins/adapters/claude.js";

const BLOCK = JSON.stringify({
  PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `"${PLUGIN_ROOT_PLACEHOLDER}"/gate.sh` }] }],
  SessionStart: [{ hooks: [{ type: "command", command: `node "${PLUGIN_ROOT_PLACEHOLDER}"/brief.js` }] }],
});
const ROOT = ".tachyon/plugins/sdd/claude";
const block = () => parseClaudeHooksBlock(BLOCK).hooks!;

describe("parseClaudeHooksBlock", () => {
  it("accepts a well-formed inner event→groups map", () => {
    const { hooks, errors } = parseClaudeHooksBlock(BLOCK);
    expect(errors).toEqual([]);
    expect(Object.keys(hooks!)).toEqual(["PreToolUse", "SessionStart"]);
    expect(hooks!.PreToolUse[0].matcher).toBe("Bash");
  });

  it("intentionally parses the INNER map, not the full settings block (a 'hooks' key is an unknown event)", () => {
    const { hooks, errors } = parseClaudeHooksBlock(JSON.stringify({ hooks: { PreToolUse: [] } }));
    expect(hooks).toBeUndefined();
    expect(errors.some((e) => /'hooks' is not a known claude hook event/.test(e))).toBe(true);
  });

  describe("fail-closed", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["non-JSON", "{bad", /invalid JSON/],
      ["non-object", "[]", /event . groups/],
      ["unknown event", JSON.stringify({ Wat: [{ hooks: [{ type: "command", command: "x" }] }] }), /not a known claude hook event/],
      ["empty group list", JSON.stringify({ PreToolUse: [] }), /non-empty list of hook groups/],
      ["empty hooks", JSON.stringify({ PreToolUse: [{ hooks: [] }] }), /non-empty list of commands/],
      ["non-command hook type", JSON.stringify({ PreToolUse: [{ hooks: [{ type: "prompt", command: "x" }] }] }), /type: "command"/],
      ["empty command", JSON.stringify({ PreToolUse: [{ hooks: [{ type: "command", command: "  " }] }] }), /non-empty string/],
    ];
    for (const [label, input, re] of cases) {
      it(label, () => {
        const { hooks, errors } = parseClaudeHooksBlock(input);
        expect(hooks).toBeUndefined();
        expect(errors.some((e) => re.test(e))).toBe(true);
      });
    }
  });
});

describe("normalizeClaudeSettings", () => {
  it("normalizes undefined/null to an empty object", () => {
    expect(normalizeClaudeSettings(undefined).settings).toEqual({});
    expect(normalizeClaudeSettings(null).settings).toEqual({});
  });
  it("fail-closes on malformed hooks (not an object)", () => {
    expect(normalizeClaudeSettings({ hooks: 7 }).errors[0]).toMatch(/hooks: must be an object/);
  });
  it("fail-closes on a hook event whose value is not an array (the hand-edit corruption)", () => {
    expect(normalizeClaudeSettings({ hooks: { PreToolUse: {} } }).errors[0]).toMatch(/must be an array/);
  });
  it("preserves user groups verbatim, including extra fields", () => {
    const input = { model: "opus", hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "u.sh", timeout: 5 }] }] } };
    expect(normalizeClaudeSettings(input).settings).toEqual(input);
  });
});

describe("mergePluginHooks", () => {
  it("inserts PURE root-resolved groups (no marker field) into a fresh settings object", () => {
    const { settings, owned, events } = mergePluginHooks({}, block(), ROOT);
    expect(events!.sort()).toEqual(["PreToolUse", "SessionStart"]);
    const pre = settings!.hooks!.PreToolUse[0] as Record<string, unknown>;
    expect(Object.keys(pre).sort()).toEqual(["hooks", "matcher"]); // no _tachyonPlugin or any extra key
    expect((pre.hooks as Array<{ command: string }>)[0].command).toBe(`"${ROOT}"/gate.sh`); // placeholder resolved
    expect(owned!.PreToolUse[0].hooks[0].command).toBe(`"${ROOT}"/gate.sh`);
  });

  it("preserves the user's own hooks and other settings keys", () => {
    const existing: ClaudeSettings = { model: "opus", hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "user.sh" }] }] } };
    const { settings } = mergePluginHooks(existing, block(), ROOT);
    expect(settings!.model).toBe("opus");
    expect(settings!.hooks!.PreToolUse).toHaveLength(2);
    expect((settings!.hooks!.PreToolUse[0] as { hooks: Array<{ command: string }> }).hooks[0].command).toBe("user.sh");
  });

  it("is idempotent — re-applying with the prior owned groups yields an identical object", () => {
    const first = mergePluginHooks({}, block(), ROOT);
    const second = mergePluginHooks(first.settings, block(), ROOT, first.owned);
    expect(second.settings).toEqual(first.settings);
    expect(second.settings!.hooks!.PreToolUse).toHaveLength(1);
  });

  it("re-apply preserves position in place (does not shove the plugin group to the end)", () => {
    const first = mergePluginHooks({ hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "A" }] }] } }, block(), ROOT);
    // user appends their own group AFTER the plugin's
    const withUserAfter = JSON.parse(JSON.stringify(first.settings)) as ClaudeSettings;
    (withUserAfter.hooks!.PreToolUse as unknown[]).push({ matcher: "Read", hooks: [{ type: "command", command: "B" }] });
    const re = mergePluginHooks(withUserAfter, block(), ROOT, first.owned);
    const cmds = (re.settings!.hooks!.PreToolUse as Array<{ hooks: Array<{ command: string }> }>).map((g) => g.hooks[0].command);
    expect(cmds).toEqual(["A", `"${ROOT}"/gate.sh`, "B"]); // plugin stays in the middle, not at the end
  });

  it("does not mutate the input settings", () => {
    const input: ClaudeSettings = { hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "u.sh" }] }] } };
    const snapshot = JSON.stringify(input);
    mergePluginHooks(input, block(), ROOT);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("fail-closes on an unsafe plugin root", () => {
    expect(mergePluginHooks({}, block(), "../escape").errors[0]).toMatch(/not a safe contained path/);
    expect(mergePluginHooks({}, block(), "has space").errors[0]).toMatch(/not a safe contained path/);
  });

  it("fail-closes on malformed existing settings", () => {
    expect(mergePluginHooks({ hooks: { PreToolUse: {} } }, block(), ROOT).errors[0]).toMatch(/must be an array/);
  });

  it("an updated plugin that drops an event removes the old event's groups", () => {
    const first = mergePluginHooks({}, block(), ROOT); // PreToolUse + SessionStart
    const smaller = parseClaudeHooksBlock(JSON.stringify({ PreToolUse: [{ hooks: [{ type: "command", command: "only.sh" }] }] })).hooks!;
    const upd = mergePluginHooks(first.settings, smaller, ROOT, first.owned);
    expect(upd.settings!.hooks!.SessionStart).toBeUndefined(); // dropped on update
    expect(upd.settings!.hooks!.PreToolUse).toHaveLength(1);
  });
});

describe("removePluginHooks", () => {
  it("uninstall is exact + reversible — back to the original settings", () => {
    const original: ClaudeSettings = { model: "opus", hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "user.sh" }] }] } };
    const { settings, owned } = mergePluginHooks(original, block(), ROOT);
    const back = removePluginHooks(settings, owned!).settings;
    expect(back).toEqual(original);
  });

  it("never deletes a group the user has since hand-edited (no content match → conservative orphan)", () => {
    const { settings, owned } = mergePluginHooks({}, block(), ROOT);
    // user edits the plugin's PreToolUse command after install
    const edited = JSON.parse(JSON.stringify(settings)) as ClaudeSettings;
    (edited.hooks!.PreToolUse[0] as { hooks: Array<{ command: string }> }).hooks[0].command = "USER-EDITED";
    const { settings: after, removed } = removePluginHooks(edited, owned!);
    expect(after!.hooks!.PreToolUse).toHaveLength(1); // the edited group survives
    expect(removed).toBe(1); // only SessionStart (still pristine) was removed
  });

  it("removing with empty owned is a no-op", () => {
    const s: ClaudeSettings = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "user.sh" }] }] } };
    const { settings, removed } = removePluginHooks(s, {});
    expect(removed).toBe(0);
    expect(settings).toEqual(s);
  });

  it("drops the hooks map entirely when the last owned group leaves", () => {
    const onlyStop = parseClaudeHooksBlock(JSON.stringify({ Stop: [{ hooks: [{ type: "command", command: "x" }] }] })).hooks!;
    const { settings, owned } = mergePluginHooks({}, onlyStop, ROOT);
    expect(settings!.hooks).toBeDefined();
    expect(removePluginHooks(settings, owned!).settings!.hooks).toBeUndefined();
  });

  it("count-aware: a user-duplicated identical group survives one removal", () => {
    const { settings, owned } = mergePluginHooks({}, block(), ROOT);
    const dup = JSON.parse(JSON.stringify(settings)) as ClaudeSettings;
    (dup.hooks!.PreToolUse as unknown[]).push(JSON.parse(JSON.stringify(owned!.PreToolUse[0]))); // user copies the plugin group
    const after = removePluginHooks(dup, owned!).settings;
    expect(after!.hooks!.PreToolUse).toHaveLength(1); // only one of the two identical groups removed
  });
});

describe("two plugins coexist", () => {
  it("removing one leaves the other intact", () => {
    const a = mergePluginHooks({}, block(), ROOT);
    const bBlock = parseClaudeHooksBlock(JSON.stringify({ PreToolUse: [{ hooks: [{ type: "command", command: "b.sh" }] }] })).hooks!;
    const b = mergePluginHooks(a.settings, bBlock, ".tachyon/plugins/other/claude");
    expect(b.settings!.hooks!.PreToolUse).toHaveLength(2);
    const removed = removePluginHooks(b.settings, a.owned!).settings;
    expect(removed!.hooks!.PreToolUse).toHaveLength(1);
    expect((removed!.hooks!.PreToolUse[0] as { hooks: Array<{ command: string }> }).hooks[0].command).toBe("b.sh");
  });
});
