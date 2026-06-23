import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadPlugin,
  detectRuntimes,
  previewInstall,
  applyInstall,
  previewRemove,
  applyRemove,
} from "../../src/plugins/engine.js";
import { PLUGIN_ROOT_PLACEHOLDER } from "../../src/plugins/adapters/claude.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Build a plugin fixture dir. Ships a native hooks block + a script for each declared runtime. */
function makePlugin(opts: { name?: string; runtimes?: string[]; command?: string } = {}): string {
  const name = opts.name ?? "sdd";
  const runtimes = opts.runtimes ?? ["claude"];
  const dir = tmp("tachyon-plugin-");
  fs.writeFileSync(
    path.join(dir, "tachyon-plugin.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      description: "test plugin",
      runtimes,
      blocks: Object.fromEntries(runtimes.map((r) => [r, `${r}/`])),
    }),
  );
  for (const rt of runtimes) {
    fs.mkdirSync(path.join(dir, rt), { recursive: true });
    const cmd: Record<string, unknown> = { type: "command", command: opts.command ?? `"${PLUGIN_ROOT_PLACEHOLDER}"/gate.sh` };
    if (rt === "codex") cmd.statusMessage = "running gate"; // codex-only field, exercises the codex adapter
    fs.writeFileSync(path.join(dir, rt, "hooks.json"), JSON.stringify({ PreToolUse: [{ matcher: rt === "codex" ? "^Bash$" : "Bash", hooks: [cmd] }] }));
    fs.writeFileSync(path.join(dir, rt, "gate.sh"), "#!/bin/sh\necho hi\n");
  }
  return dir;
}

/** A workspace with the given runtimes present (their config dirs). Defaults to claude. */
function makeWorkspace(runtimes: string[] = ["claude"]): string {
  const ws = tmp("tachyon-ws-");
  for (const rt of runtimes) fs.mkdirSync(path.join(ws, `.${rt}`), { recursive: true });
  return ws;
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const RESOLVED = `"${".tachyon/plugins/sdd/claude"}"/gate.sh`;
const SETTINGS = (ws: string) => path.join(ws, ".claude", "settings.json");
const LOCK = (ws: string) => path.join(ws, ".tachyon/plugins.lock.json");
const install = (pluginDir: string, ws: string) => {
  const { plugin } = loadPlugin(pluginDir);
  return applyInstall(plugin!, previewInstall(plugin!, ws, detectRuntimes(ws)), ws, detectRuntimes(ws));
};

describe("loadPlugin", () => {
  it("reads + validates a plugin's manifest and claude hooks", () => {
    const { plugin, errors } = loadPlugin(makePlugin());
    expect(errors).toEqual([]);
    expect(plugin?.manifest.name).toBe("sdd");
    expect(plugin?.blocks.claude?.PreToolUse).toHaveLength(1);
    expect(plugin?.rootRel.claude).toBe(".tachyon/plugins/sdd/claude");
  });
  it("fail-closes on a missing manifest / missing hooks", () => {
    expect(loadPlugin(tmp("empty-")).errors[0]).toMatch(/no tachyon-plugin.json/);
    const noHooks = tmp("nohooks-");
    fs.writeFileSync(path.join(noHooks, "tachyon-plugin.json"), JSON.stringify({ name: "x", version: "1.0.0", description: "d", runtimes: ["claude"], blocks: { claude: "claude/" } }));
    expect(loadPlugin(noHooks).errors[0]).toMatch(/has no hooks.json/);
  });
});

describe("detectRuntimes", () => {
  it("detects claude by its config dir; nothing in a bare workspace", () => {
    expect([...detectRuntimes(makeWorkspace())]).toEqual(["claude"]);
    expect(detectRuntimes(tmp("bare-")).size).toBe(0);
  });
});

describe("previewInstall (the security surface)", () => {
  it("surfaces the wired commands + diff + a fingerprint without writing anything", () => {
    const ws = makeWorkspace();
    const { plugin } = loadPlugin(makePlugin());
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    expect(preview.errors).toEqual([]);
    expect(preview.steps).toHaveLength(1);
    expect(preview.steps[0].wiredCommands).toEqual([RESOLVED]);
    expect(preview.steps[0].before).toEqual({});
    expect(preview.fingerprint).not.toBe("");
    expect(fs.existsSync(SETTINGS(ws))).toBe(false); // preview never writes
  });

  it("skips a declared runtime absent from the workspace", () => {
    const ws = makeWorkspace();
    const { plugin } = loadPlugin(makePlugin({ runtimes: ["claude", "codex"] }));
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    expect(preview.skipped).toContain("codex");
    expect(preview.steps).toHaveLength(1);
  });

  it("fail-closes on an invalid existing settings.json (never treats it as empty)", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(SETTINGS(ws), "{ not json");
    const { plugin } = loadPlugin(makePlugin());
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    expect(preview.errors.some((e) => /invalid JSON/.test(e))).toBe(true);
  });

  it("fail-closes on a corrupt lockfile", () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.dirname(LOCK(ws)), { recursive: true });
    fs.writeFileSync(LOCK(ws), "{ corrupt");
    const { plugin } = loadPlugin(makePlugin());
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    expect(preview.errors.some((e) => /corrupt/.test(e))).toBe(true);
  });

  it("fail-closes when the lockfile path is present-but-unreadable (EISDIR, not absent)", () => {
    const ws = makeWorkspace();
    fs.mkdirSync(LOCK(ws), { recursive: true }); // a DIRECTORY where the lockfile should be → read error, not ENOENT
    const { plugin } = loadPlugin(makePlugin());
    expect(previewInstall(plugin!, ws, detectRuntimes(ws)).errors.length).toBeGreaterThan(0);
  });

  it("rejects a payload containing a symlink", () => {
    const pluginDir = makePlugin();
    fs.symlinkSync("/etc/passwd", path.join(pluginDir, "claude", "evil-link"));
    const ws = makeWorkspace();
    const { plugin } = loadPlugin(pluginDir);
    expect(previewInstall(plugin!, ws, detectRuntimes(ws)).errors.some((e) => /symlink/.test(e))).toBe(true);
  });
});

describe("install → use → remove (end-to-end on a real temp workspace)", () => {
  it("install writes settings + copies payload + records the lockfile", () => {
    const ws = makeWorkspace();
    expect(install(makePlugin(), ws).installed).toBe(true);
    expect(readJson(SETTINGS(ws)).hooks.PreToolUse[0].hooks[0].command).toBe(RESOLVED);
    expect(fs.existsSync(path.join(ws, ".tachyon/plugins/sdd/claude/gate.sh"))).toBe(true);
    expect(readJson(LOCK(ws)).plugins.sdd.targets[0].ref).toBe("PreToolUse");
  });

  it("remove un-merges, deletes the payload, drops the lockfile entry (back to clean)", () => {
    const ws = makeWorkspace();
    install(makePlugin(), ws);
    expect(previewRemove("sdd", ws)).toMatchObject({ found: true, expectedCount: 1, removedCount: 1, orphans: 0 });
    expect(applyRemove("sdd", ws)).toMatchObject({ removed: true, orphans: 0 });
    expect(fs.existsSync(SETTINGS(ws))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".tachyon/plugins/sdd"))).toBe(false);
    expect(fs.existsSync(LOCK(ws))).toBe(false);
  });

  it("preserves a user's own hook on remove", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(SETTINGS(ws), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "user.sh" }] }] } }));
    install(makePlugin(), ws);
    applyRemove("sdd", ws);
    const settings = readJson(SETTINGS(ws));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("user.sh");
  });

  it("is idempotent — re-installing does not duplicate the hook", () => {
    const ws = makeWorkspace();
    install(makePlugin(), ws);
    install(makePlugin(), ws);
    expect(readJson(SETTINGS(ws)).hooks.PreToolUse).toHaveLength(1);
  });

  it("surfaces an orphan when the user edited the plugin's hook before removing", () => {
    const ws = makeWorkspace();
    install(makePlugin(), ws);
    const s = readJson(SETTINGS(ws));
    s.hooks.PreToolUse[0].hooks[0].command = "EDITED";
    fs.writeFileSync(SETTINGS(ws), JSON.stringify(s));
    expect(previewRemove("sdd", ws)).toMatchObject({ expectedCount: 1, removedCount: 0, orphans: 1 });
    expect(applyRemove("sdd", ws).orphans).toBe(1);
    expect(readJson(SETTINGS(ws)).hooks.PreToolUse).toHaveLength(1); // edited group left, never deleted
  });
});

describe("safety + fail-closed", () => {
  it("apply refuses a stale preview (settings changed since consent)", () => {
    const ws = makeWorkspace();
    const { plugin } = loadPlugin(makePlugin());
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    fs.writeFileSync(SETTINGS(ws), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "snuck-in" }] }] } }));
    const res = applyInstall(plugin!, preview, ws, detectRuntimes(ws));
    expect(res.installed).toBe(false);
    expect(res.errors[0]).toMatch(/changed since preview/);
  });

  it("apply refuses when there is nothing to install (no runtime present)", () => {
    const ws = tmp("bare-ws-"); // no .claude
    const { plugin } = loadPlugin(makePlugin());
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws)); // present = {}
    const res = applyInstall(plugin!, preview, ws, detectRuntimes(ws));
    expect(res.installed).toBe(false);
    expect(res.errors[0]).toMatch(/nothing to install/);
    expect(fs.existsSync(LOCK(ws))).toBe(false); // never wrote a runtimes:[] lock
  });

  it("remove fail-closes on a hand-corrupted lockfile removal", () => {
    const ws = makeWorkspace();
    install(makePlugin(), ws);
    const lock = readJson(LOCK(ws));
    lock.plugins.sdd.targets[0].removal = { PreToolUse: "not-an-array" }; // corrupt removal
    fs.writeFileSync(LOCK(ws), JSON.stringify(lock));
    // a corrupt removal makes the WHOLE lockfile invalid (parseOwnedHooks rejects) → fail-closed
    expect(previewRemove("sdd", ws).errors.length).toBeGreaterThan(0);
    expect(applyRemove("sdd", ws).removed).toBe(false);
  });

  it("remove reports not-installed for an unknown plugin", () => {
    const ws = makeWorkspace();
    expect(previewRemove("ghost", ws).found).toBe(false);
    expect(applyRemove("ghost", ws).errors[0]).toMatch(/not installed/);
  });

  it("wires the SAME plugin into BOTH claude and codex (the multi-runtime thesis)", () => {
    const ws = makeWorkspace(["claude", "codex"]);
    const res = install(makePlugin({ runtimes: ["claude", "codex"] }), ws);
    expect(res.installed).toBe(true);
    expect(res.runtimes.sort()).toEqual(["claude", "codex"]);
    // claude config wired in .claude/settings.json
    expect(readJson(path.join(ws, ".claude", "settings.json")).hooks.PreToolUse[0].hooks[0].command).toBe(RESOLVED);
    // codex config wired in .codex/hooks.json, with the codex payload root + codex-only statusMessage
    const codex = readJson(path.join(ws, ".codex", "hooks.json"));
    expect(codex.hooks.PreToolUse[0].hooks[0].command).toBe(`"${".tachyon/plugins/sdd/codex"}"/gate.sh`);
    expect(codex.hooks.PreToolUse[0].hooks[0].statusMessage).toBe("running gate");
    expect(codex.hooks.PreToolUse[0].matcher).toBe("^Bash$"); // codex-native matcher preserved
    // lockfile records targets for both runtimes
    const lock = readJson(LOCK(ws));
    expect(lock.plugins.sdd.runtimes.sort()).toEqual(["claude", "codex"]);
    // remove cleans BOTH
    expect(applyRemove("sdd", ws).removed).toBe(true);
    expect(fs.existsSync(path.join(ws, ".claude", "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".codex", "hooks.json"))).toBe(false);
  });

  it("a claude+codex plugin in a claude-only workspace wires claude, skips codex", () => {
    const ws = makeWorkspace(["claude"]);
    const res = install(makePlugin({ runtimes: ["claude", "codex"] }), ws);
    expect(res.runtimes).toEqual(["claude"]);
    expect(fs.existsSync(path.join(ws, ".codex", "hooks.json"))).toBe(false);
  });

  it("install aborts if the plugin payload gains a symlink after preview (TOCTOU)", () => {
    const ws = makeWorkspace();
    const pluginDir = makePlugin();
    const { plugin } = loadPlugin(pluginDir);
    const preview = previewInstall(plugin!, ws, detectRuntimes(ws));
    expect(preview.errors).toEqual([]);
    fs.symlinkSync("/etc/passwd", path.join(pluginDir, "claude", "evil")); // source tampered after consent
    const res = applyInstall(plugin!, preview, ws, detectRuntimes(ws));
    expect(res.installed).toBe(false);
    expect(res.errors.some((e) => /symlink|changed/.test(e))).toBe(true);
    expect(fs.existsSync(SETTINGS(ws))).toBe(false); // nothing activated
  });
});
