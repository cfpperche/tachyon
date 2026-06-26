import { describe, it, expect } from "vitest";
import { emptyLockfile, serializeLockfile, parseLockfile, LOCKFILE_REL_PATH, physicalToolKey, toolReferenceCounts, type Lockfile } from "../../src/plugins/lockfile.js";

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

  it("spec 264 — gitHooks round-trip + fail-closed shape; absent-tolerant", () => {
    const gh = JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", runtimes: ["claude"], targets: [], gitHooks: [{ event: "pre-commit", managedLeafPath: ".tachyon/githooks/leaves/" + "a".repeat(64), leafContentHash: "a".repeat(64), ownershipGeneration: 2 }] } } });
    const a = parseLockfile(gh);
    expect(a.errors).toEqual([]);
    expect(a.lockfile?.plugins.sdd.gitHooks).toEqual([{ event: "pre-commit", managedLeafPath: ".tachyon/githooks/leaves/" + "a".repeat(64), leafContentHash: "a".repeat(64), ownershipGeneration: 2 }]);
    // old lock without the field → undefined
    const old = parseLockfile(JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", runtimes: ["claude"], targets: [] } } }));
    expect(old.lockfile?.plugins.sdd.gitHooks).toBeUndefined();
    // fail-closed: bad hash + escaping path + non-int generation
    const bad = (gitHooks: unknown) => parseLockfile(JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", runtimes: ["claude"], targets: [], gitHooks } } }));
    expect(bad([{ event: "pre-commit", managedLeafPath: ".tachyon/x", leafContentHash: "short", ownershipGeneration: 1 }]).errors.some((e) => /leafContentHash: required 64-hex/.test(e))).toBe(true);
    expect(bad([{ event: "pre-commit", managedLeafPath: "../escape", leafContentHash: "a".repeat(64), ownershipGeneration: 1 }]).errors.some((e) => /managedLeafPath: must be a contained/.test(e))).toBe(true);
    expect(bad([{ event: "pre-commit", managedLeafPath: ".tachyon/x", leafContentHash: "a".repeat(64), ownershipGeneration: 1.5 }]).errors.some((e) => /ownershipGeneration: required integer/.test(e))).toBe(true);
    expect(bad("nope").errors.some((e) => /gitHooks: must be a list/.test(e))).toBe(true);
  });

  it("spec 265 — fetched tool round-trips with full provenance; absent-tolerant", () => {
    const SHA = "a".repeat(64);
    const ART = "b".repeat(64);
    const t = {
      name: "gitleaks", source: "fetched", resolvedPlatform: "linux-x64-glibc", version: "8.18.4",
      binSha256: SHA, exeName: "gitleaks", installPath: `.tachyon/bin/gitleaks/${SHA}/gitleaks`,
      declaredUrl: "https://example.com/g.tar.gz", finalUrl: "https://cdn.example.com/g.tar.gz",
      artifactSha256: ART, archive: { innerPath: "bin/gitleaks" },
    };
    const lf = JSON.stringify({ schemaVersion: 1, plugins: { cg: { name: "cg", version: "1.0.0", runtimes: [], targets: [], tools: [t] } } });
    const a = parseLockfile(lf);
    expect(a.errors).toEqual([]);
    expect(a.lockfile?.plugins.cg.tools?.[0]).toEqual(t);
    // old lock without tools → undefined
    const old = parseLockfile(JSON.stringify({ schemaVersion: 1, plugins: { cg: { name: "cg", version: "1.0.0", runtimes: [], targets: [] } } }));
    expect(old.lockfile?.plugins.cg.tools).toBeUndefined();
  });

  it("spec 269 — a tool's launchPolicy round-trips; a corrupt policy fails the lock closed", () => {
    const SHA = "a".repeat(64);
    const base = {
      name: "ab", source: "fetched", resolvedPlatform: "linux-x64-glibc", version: "0.31.0",
      binSha256: SHA, exeName: "ab", installPath: `.tachyon/bin/ab/${SHA}/ab`,
      declaredUrl: "https://example.com/ab", finalUrl: "https://example.com/ab", artifactSha256: SHA,
    };
    const lp = { env: { AGENT_BROWSER_CONFIRM_ACTIONS: "click,eval" }, denyArgs: ["--confirm-actions"], mode: "force" };
    const lf = (t: unknown) => parseLockfile(JSON.stringify({ schemaVersion: 1, plugins: { cg: { name: "cg", version: "1.0.0", runtimes: [], targets: [], tools: [t] } } }));
    const a = lf({ ...base, launchPolicy: lp });
    expect(a.errors).toEqual([]);
    expect(a.lockfile?.plugins.cg.tools?.[0].launchPolicy).toEqual(lp);
    // a corrupt policy refuses the whole lock (never launch a tool unpoliced)
    expect(lf({ ...base, launchPolicy: { mode: "warn", env: { FOO: "x" } } }).errors.some((e) => /mode: must be "force"/.test(e))).toBe(true);
    expect(lf({ ...base, launchPolicy: { mode: "force" } }).errors.some((e) => /at least one of env, args, or denyArgs/.test(e))).toBe(true);
  });

  it("spec 265 — host-provided tool round-trips; fail-closed on bad provenance", () => {
    const SHA = "c".repeat(64);
    const host = {
      name: "gitleaks", source: "host-provided", resolvedPlatform: "darwin-arm64", version: "8.18.4",
      binSha256: SHA, exeName: "gitleaks", installPath: "/opt/homebrew/bin/gitleaks",
      hostDetected: { path: "/opt/homebrew/bin/gitleaks", version: "8.18.4", hash: SHA }, allowedHostSha256: SHA,
    };
    const a = parseLockfile(JSON.stringify({ schemaVersion: 1, plugins: { cg: { name: "cg", version: "1.0.0", runtimes: [], targets: [], tools: [host] } } }));
    expect(a.errors).toEqual([]);
    expect(a.lockfile?.plugins.cg.tools?.[0]).toEqual(host);

    const bad = (t: unknown) => parseLockfile(JSON.stringify({ schemaVersion: 1, plugins: { cg: { name: "cg", version: "1.0.0", runtimes: [], targets: [], tools: [t] } } })).errors;
    // fetched missing https url
    expect(bad({ name: "g", source: "fetched", resolvedPlatform: "linux-x64-glibc", version: "1", binSha256: SHA, exeName: "g", installPath: ".tachyon/bin/g/" + SHA + "/g", declaredUrl: "http://x/g", finalUrl: "https://x/g", artifactSha256: SHA }).some((e) => /declaredUrl: required https/.test(e))).toBe(true);
    // fetched installPath must be contained (not absolute)
    expect(bad({ name: "g", source: "fetched", resolvedPlatform: "linux-x64-glibc", version: "1", binSha256: SHA, exeName: "g", installPath: "/abs/g", declaredUrl: "https://x/g", finalUrl: "https://x/g", artifactSha256: SHA }).some((e) => /must be a contained workspace-relative/.test(e))).toBe(true);
    // host-provided installPath must be absolute
    expect(bad({ name: "g", source: "host-provided", resolvedPlatform: "darwin-arm64", version: "1", binSha256: SHA, exeName: "g", installPath: "rel/g", hostDetected: { path: "/usr/bin/g", version: "1", hash: SHA } }).some((e) => /must be an absolute path/.test(e))).toBe(true);
    // unknown platform key
    expect(bad({ name: "g", source: "fetched", resolvedPlatform: "linux-x86", version: "1", binSha256: SHA, exeName: "g", installPath: ".tachyon/bin/g/" + SHA + "/g", declaredUrl: "https://x/g", finalUrl: "https://x/g", artifactSha256: SHA }).some((e) => /resolvedPlatform: must be a known platform key/.test(e))).toBe(true);
  });

  it("spec 265 — refcount by PHYSICAL identity across plugins (H7)", () => {
    const SHA = "d".repeat(64);
    const ART = "e".repeat(64);
    const tool = (name: string) => ({ name, source: "fetched", resolvedPlatform: "linux-x64-glibc", version: "1", binSha256: SHA, exeName: "gitleaks", installPath: `.tachyon/bin/gitleaks/${SHA}/gitleaks`, declaredUrl: "https://x/g", finalUrl: "https://x/g", artifactSha256: ART });
    // two plugins reference the SAME physical bytes under different logical tool names
    const lf = parseLockfile(JSON.stringify({
      schemaVersion: 1,
      plugins: {
        a: { name: "a", version: "1.0.0", runtimes: [], targets: [], tools: [tool("gitleaks")] },
        b: { name: "b", version: "1.0.0", runtimes: [], targets: [], tools: [tool("secrets")] },
      },
    })).lockfile as Lockfile;
    const refs = toolReferenceCounts(lf);
    const key = physicalToolKey(lf.plugins.a.tools![0]);
    expect(refs.get(key)).toEqual(new Set(["a", "b"]));
    expect(refs.size).toBe(1); // same physical identity → one entry
  });

  it("spec 265 — workspace-level launcher record round-trips; absent-tolerant; fail-closed", () => {
    const SHA = "a".repeat(64);
    const withL = JSON.stringify({ schemaVersion: 1, plugins: {}, launcher: { nodePath: "/usr/bin/node", shimSha256: SHA, validatorSha256: SHA } });
    const a = parseLockfile(withL);
    expect(a.errors).toEqual([]);
    expect(a.lockfile?.launcher).toEqual({ nodePath: "/usr/bin/node", shimSha256: SHA, validatorSha256: SHA });
    // absent → undefined
    expect(parseLockfile(JSON.stringify({ schemaVersion: 1, plugins: {} })).lockfile?.launcher).toBeUndefined();
    // fail-closed: relative nodePath, bad hash
    expect(parseLockfile(JSON.stringify({ schemaVersion: 1, plugins: {}, launcher: { nodePath: "node", shimSha256: SHA, validatorSha256: SHA } })).errors.some((e) => /launcher:/.test(e))).toBe(true);
    expect(parseLockfile(JSON.stringify({ schemaVersion: 1, plugins: {}, launcher: { nodePath: "/usr/bin/node", shimSha256: "short", validatorSha256: SHA } })).errors.some((e) => /launcher:/.test(e))).toBe(true);
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
      ["non-array runtimes", JSON.stringify({ schemaVersion: 1, plugins: { sdd: { name: "sdd", version: "1.0.0", runtimes: "claude", targets: [] } } }), /runtimes: must be a list/],
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
