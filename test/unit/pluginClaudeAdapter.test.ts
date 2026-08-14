import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseClaudeHooksBlock,
  parseOwnedHooks,
  normalizeClaudeSettings,
  mergePluginHooks,
  removePluginHooks,
  PLUGIN_ROOT_PLACEHOLDER,
  type ClaudeSettings,
  type OwnedHooks,
} from "@tachyon/engine/plugins/adapters/claude.js";

const BLOCK = JSON.stringify({
  PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `"${PLUGIN_ROOT_PLACEHOLDER}"/gate.sh` }] }],
  SessionStart: [{ hooks: [{ type: "command", command: `node "${PLUGIN_ROOT_PLACEHOLDER}"/brief.js` }] }],
});
// spec 321 — the merge root is the plugin's ABSOLUTE materialized root (cwd-independent rendering).
const ROOT = "/ws/.tachyon/plugins/sdd/claude";
const block = () => parseClaudeHooksBlock(BLOCK).hooks!;

/** The spec-321 wrappers around a resolved command (mirrors adapters/hooks.ts wrapResolved). */
const gateWrapped = (resolved: string, root = ROOT) =>
  `if [ ! -d "${root}" ]; then echo "[tachyon] plugin hook root missing: ${root} — blocking (fail-closed gate hook)" >&2; exit 2; fi; ` +
  `${resolved}; rc=$?; ` +
  `if [ "$rc" -eq 127 ]; then echo "[tachyon] plugin hook command not found (exit 127) — blocking (fail-closed gate hook)" >&2; exit 2; fi; exit "$rc"`;
const openWrapped = (resolved: string, root = ROOT) =>
  `if [ ! -d "${root}" ]; then echo "[tachyon] plugin hook root missing: ${root} — skipping (fail-open hook)" >&2; exit 0; fi; ${resolved}`;
const GATE_CMD = gateWrapped(`"${ROOT}"/gate.sh`);

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
    expect((pre.hooks as Array<{ command: string }>)[0].command).toBe(GATE_CMD); // resolved absolute + gate wrapper
    expect(owned!.PreToolUse[0].hooks[0].command).toBe(GATE_CMD);
  });

  it("spec 321 — a gate (PreToolUse) command wraps fail-closed; an observational one wraps fail-open", () => {
    const { settings } = mergePluginHooks({}, block(), ROOT);
    const pre = (settings!.hooks!.PreToolUse[0] as { hooks: Array<{ command: string }> }).hooks[0].command;
    const start = (settings!.hooks!.SessionStart[0] as { hooks: Array<{ command: string }> }).hooks[0].command;
    expect(pre).toBe(gateWrapped(`"${ROOT}"/gate.sh`));
    expect(start).toBe(openWrapped(`node "${ROOT}"/brief.js`));
    expect(pre).not.toContain('".tachyon/'); // never a quote-leading RELATIVE path — the root is always absolute
  });

  it("spec 321 — a placeholder-free command is written verbatim (no wrapper)", () => {
    const b = parseClaudeHooksBlock(JSON.stringify({ PreToolUse: [{ hooks: [{ type: "command", command: "gitleaks detect --no-banner" }] }] })).hooks!;
    const { settings } = mergePluginHooks({}, b, ROOT);
    expect((settings!.hooks!.PreToolUse[0] as { hooks: Array<{ command: string }> }).hooks[0].command).toBe("gitleaks detect --no-banner");
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
    expect(cmds).toEqual(["A", GATE_CMD, "B"]); // plugin stays in the middle, not at the end
  });

  it("does not mutate the input settings", () => {
    const input: ClaudeSettings = { hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "u.sh" }] }] } };
    const snapshot = JSON.stringify(input);
    mergePluginHooks(input, block(), ROOT);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("fail-closes on an unsafe plugin root (relative, traversal, whitespace, metacharacters)", () => {
    expect(mergePluginHooks({}, block(), ".tachyon/plugins/sdd/claude").errors[0]).toMatch(/not a safe absolute path/); // relative no longer accepted
    expect(mergePluginHooks({}, block(), "/ws/../escape").errors[0]).toMatch(/not a safe absolute path/);
    expect(mergePluginHooks({}, block(), "/ws/has space/plugins").errors[0]).toMatch(/not a safe absolute path/);
    expect(mergePluginHooks({}, block(), '/ws/has"quote/plugins').errors[0]).toMatch(/not a safe absolute path/);
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

  it("works with a hyphenated plugin root", () => {
    const root = "/ws/.tachyon/plugins/my-plugin/claude";
    const { settings, errors } = mergePluginHooks({}, block(), root);
    expect(errors).toEqual([]);
    expect((settings!.hooks!.PreToolUse[0] as { hooks: Array<{ command: string }> }).hooks[0].command).toBe(gateWrapped(`"${root}"/gate.sh`, root));
  });
});

describe("parseOwnedHooks (lockfile removal validation)", () => {
  it("accepts a well-formed owned record", () => {
    const { owned, errors } = parseOwnedHooks({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }] });
    expect(errors).toEqual([]);
    expect(owned!.PreToolUse).toHaveLength(1);
  });
  it("fail-closes on a non-array event value (corrupt lockfile) instead of letting the adapter throw", () => {
    expect(parseOwnedHooks({ PreToolUse: {} }).errors[0]).toMatch(/must be an array/);
  });
  it("removePluginHooks does not throw on a malformed owned record (defensive guard)", () => {
    const s: ClaudeSettings = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "u" }] }] } };
    const bad = { PreToolUse: {} } as unknown as OwnedHooks; // simulate a corrupt lockfile slipping through
    expect(() => removePluginHooks(s, bad)).not.toThrow();
  });
});

describe("expected vs removed (orphan surfacing for Step 3)", () => {
  it("reports expected count and a shortfall when a group was edited away", () => {
    const { settings, owned } = mergePluginHooks({}, block(), ROOT); // 2 groups
    const edited = JSON.parse(JSON.stringify(settings)) as ClaudeSettings;
    (edited.hooks!.PreToolUse[0] as { hooks: Array<{ command: string }> }).hooks[0].command = "EDITED";
    const r = removePluginHooks(edited, owned!);
    expect(r.expected).toBe(2);
    expect(r.removed).toBe(1); // one orphaned (edited), surfaced as expected>removed
  });

  it("pre-existing identical user group: count-aware removal keeps exactly one (functionally equivalent)", () => {
    // user already has a group byte-identical to what the plugin will write
    const userGroup = { matcher: "Bash", hooks: [{ type: "command", command: GATE_CMD }] };
    const onlyPre = parseClaudeHooksBlock(JSON.stringify({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `"${PLUGIN_ROOT_PLACEHOLDER}"/gate.sh` }] }] })).hooks!;
    const start: ClaudeSettings = { hooks: { PreToolUse: [userGroup] } };
    const { settings, owned } = mergePluginHooks(start, onlyPre, ROOT);
    expect(settings!.hooks!.PreToolUse).toHaveLength(2); // user's + plugin's (identical)
    const after = removePluginHooks(settings, owned!).settings;
    expect(after!.hooks!.PreToolUse).toHaveLength(1); // exactly one identical group remains — behavior unchanged
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
    const b = mergePluginHooks(a.settings, bBlock, "/ws/.tachyon/plugins/other/claude");
    expect(b.settings!.hooks!.PreToolUse).toHaveLength(2);
    const removed = removePluginHooks(b.settings, a.owned!).settings;
    expect(removed!.hooks!.PreToolUse).toHaveLength(1);
    expect((removed!.hooks!.PreToolUse[0] as { hooks: Array<{ command: string }> }).hooks[0].command).toBe("b.sh");
  });
});

describe("spec 321 — the rendered wrapper behaves under real sh", () => {
  const run = (cmd: string, stdin = ""): { code: number; stderr: string } => {
    const r = spawnSync("sh", ["-c", cmd], { input: stdin, encoding: "utf8" });
    return { code: r.status ?? -1, stderr: r.stderr };
  };

  it("gate: missing root blocks with exit 2 and a clear stderr message", () => {
    const root = path.join(os.tmpdir(), `t321-gone-${process.pid}`); // never created
    const wrapped = renderFor(root, `"${PLUGIN_ROOT_PLACEHOLDER}"/gate.sh`, "PreToolUse");
    const r = run(wrapped);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("plugin hook root missing");
  });

  it("gate: present root + missing script (127) is remapped to a blocking 2", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t321-"));
    try {
      const wrapped = renderFor(root, `"${PLUGIN_ROOT_PLACEHOLDER}"/gate.sh`, "PreToolUse");
      const r = run(wrapped);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("not found");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("gate: the inner hook's own exit code passes through (0 pass, 2 deny)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t321-"));
    try {
      fs.writeFileSync(path.join(root, "gate.sh"), "#!/bin/sh\nexit $T321_RC\n", { mode: 0o755 });
      const wrapped = renderFor(root, `"${PLUGIN_ROOT_PLACEHOLDER}"/gate.sh`, "PreToolUse");
      const pass = spawnSync("sh", ["-c", wrapped], { encoding: "utf8", env: { ...process.env, T321_RC: "0" } });
      const deny = spawnSync("sh", ["-c", wrapped], { encoding: "utf8", env: { ...process.env, T321_RC: "2" } });
      expect(pass.status).toBe(0);
      expect(deny.status).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("observational: missing root skips with exit 0", () => {
    const root = path.join(os.tmpdir(), `t321-gone-${process.pid}`);
    const wrapped = renderFor(root, `node "${PLUGIN_ROOT_PLACEHOLDER}"/brief.js`, "SessionStart");
    const r = run(wrapped);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("skipping");
  });

  /** Render the single wrapped command mergePluginHooks writes for `cmd` under `event` at `root`. */
  function renderFor(root: string, cmd: string, event: string): string {
    const b = parseClaudeHooksBlock(JSON.stringify({ [event]: [{ hooks: [{ type: "command", command: cmd }] }] })).hooks!;
    const { settings, errors } = mergePluginHooks({}, b, root);
    expect(errors).toEqual([]);
    return (settings!.hooks![event][0] as { hooks: Array<{ command: string }> }).hooks[0].command;
  }
});
