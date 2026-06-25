import { describe, it, expect } from "vitest";
import { emptyLockfile, serializeLockfile, parseLockfile, LOCKFILE_REL_PATH } from "../../src/plugins/lockfile.js";

const VALID = {
  schemaVersion: 1,
  plugins: {
    sdd: {
      name: "sdd",
      version: "1.2.0",
      source: { type: "git", spec: "github:org/repo@v1#path=sdd", remote: "https://github.com/org/repo.git", ref: "v1", resolvedCommit: "a".repeat(40), subdir: "sdd" },
      integrity: { algorithm: "sha256", payload: "deadbeef" },
      runtimes: ["claude", "codex"],
      targets: [
        { runtime: "claude", kind: "settings-hook", file: ".claude/settings.json", ref: "PreToolUse", removal: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }] },
        { runtime: "codex", kind: "settings-hook", file: ".codex/hooks.json", ref: "apply_patch" },
      ],
    },
  },
};

describe("lockfile", () => {
  it("round-trips a valid lockfile through serialize → parse", () => {
    const text = serializeLockfile(VALID as never);
    const { lockfile, errors } = parseLockfile(text);
    expect(errors).toEqual([]);
    expect(lockfile?.plugins.sdd.version).toBe("1.2.0");
    expect(lockfile?.plugins.sdd.targets).toHaveLength(2);
    expect(lockfile?.plugins.sdd.targets[0].ref).toBe("PreToolUse");
    expect(lockfile?.plugins.sdd.targets[0].removal).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }]); // opaque, preserved
    expect(lockfile?.plugins.sdd.source).toMatchObject({ type: "git", remote: "https://github.com/org/repo.git", resolvedCommit: "a".repeat(40), subdir: "sdd" });
    expect(lockfile?.plugins.sdd.integrity).toEqual({ algorithm: "sha256", payload: "deadbeef" });
  });

  it("fail-closes on a malformed source/integrity struct", () => {
    const bad = (patch: object) => JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", runtimes: ["claude"], targets: [], ...patch } } });
    expect(parseLockfile(bad({ source: { type: "svn", spec: "x", remote: "y", ref: "z", resolvedCommit: "a".repeat(40) } })).errors.some((e) => /type: must be 'git'/.test(e))).toBe(true);
    expect(parseLockfile(bad({ source: { type: "git", spec: "x", remote: "y", ref: "z", resolvedCommit: "short" } })).errors.some((e) => /resolvedCommit: required 40-hex/.test(e))).toBe(true);
    expect(parseLockfile(bad({ integrity: { algorithm: "md5", payload: "x" } })).errors.some((e) => /algorithm: must be 'sha256'/.test(e))).toBe(true);
  });

  it("spec 263 — createdAncestors round-trips, dedupes, and is absent-tolerant", () => {
    const withCA = JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", runtimes: ["claude"], targets: [], createdAncestors: [".claude", ".claude/skills", ".claude"] } } });
    const a = parseLockfile(withCA);
    expect(a.errors).toEqual([]);
    expect(a.lockfile?.plugins.sdd.createdAncestors).toEqual([".claude", ".claude/skills"]); // deduped, order-preserving
    // an old lock without the field parses fine → undefined (uninstall removes no ancestors)
    const old = parseLockfile(JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", runtimes: ["claude"], targets: [] } } }));
    expect(old.errors).toEqual([]);
    expect(old.lockfile?.plugins.sdd.createdAncestors).toBeUndefined();
  });

  it("spec 263 — createdAncestors fails closed on a non-array or an escaping path", () => {
    const bad = (ca: unknown) => parseLockfile(JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", runtimes: ["claude"], targets: [], createdAncestors: ca } } }));
    expect(bad("not-a-list").errors.some((e) => /createdAncestors: must be a list/.test(e))).toBe(true);
    expect(bad(["../escape"]).errors.some((e) => /createdAncestors\[0\]: must be a contained/.test(e))).toBe(true);
  });

  it("emptyLockfile serializes to a parseable empty doc", () => {
    const { lockfile, errors } = parseLockfile(serializeLockfile(emptyLockfile()));
    expect(errors).toEqual([]);
    expect(lockfile?.plugins).toEqual({});
  });

  it("serialized output is pretty + newline-terminated (clean diffs)", () => {
    const text = serializeLockfile(emptyLockfile());
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"schemaVersion": 1');
  });

  it("exposes the committed lockfile path", () => {
    expect(LOCKFILE_REL_PATH).toBe(".tachyon/plugins.lock.json");
  });

  describe("fail-closed parse", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["non-JSON", "{bad", /invalid JSON/],
      ["non-object", "[]", /must be a JSON object/],
      ["wrong schemaVersion", JSON.stringify({ schemaVersion: 2, plugins: {} }), /schemaVersion: must be 1/],
      ["plugins not object", JSON.stringify({ schemaVersion: 1, plugins: [] }), /plugins: must be an object/],
      ["name ≠ key", JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "other", version: "1.0.0", runtimes: ["claude"], targets: [] } } }), /must equal the map key/],
      ["missing version", JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", runtimes: ["claude"], targets: [] } } }), /version: required/],
      ["empty runtimes", JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", runtimes: [], targets: [] } } }), /runtimes: required/],
      ["bad target kind", JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", runtimes: ["claude"], targets: [{ runtime: "claude", kind: "evil", file: "x" }] } } }), /kind: must be one of/],
      ["bad target runtime", JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", runtimes: ["claude"], targets: [{ runtime: "gemini", kind: "settings-hook", file: "x" }] } } }), /runtime: must be one of/],
      ["target file not contained", JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", runtimes: ["claude"], targets: [{ runtime: "claude", kind: "settings-hook", file: "../escape" }] } } }), /contained workspace-relative path/],
      ["target runtime not in plugin runtimes", JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", runtimes: ["claude"], targets: [{ runtime: "codex", kind: "settings-hook", file: ".codex/x" }] } } }), /not in this plugin's runtimes/],
      ["duplicate runtime", JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", runtimes: ["claude", "claude"], targets: [] } } }), /listed more than once/],
      ["malformed source (not an object)", JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", source: 7, runtimes: ["claude"], targets: [] } } }), /source: must be an object/],
    ];
    for (const [label, input, re] of cases) {
      it(label, () => {
        const { lockfile, errors } = parseLockfile(input);
        expect(lockfile).toBeUndefined();
        expect(errors.some((e) => re.test(e))).toBe(true);
      });
    }
  });
});
