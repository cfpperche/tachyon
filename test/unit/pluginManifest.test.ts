import { describe, it, expect } from "vitest";
import { loadManifest, resolveCompat, SUPPORTED_RUNTIMES } from "../../src/plugins/manifest.js";

/** A valid claude+codex manifest used as the happy-path baseline. */
const VALID = JSON.stringify({
  name: "sdd",
  version: "1.2.0",
  description: "Spec-driven development scaffolding",
  runtimes: ["claude", "codex"],
  dependencies: ["some-base-plugin@^1"],
  blocks: { claude: "claude/", codex: "codex/" },
});

/** Helper: load the VALID baseline with one field overridden (or removed via undefined). */
function withField(patch: Record<string, unknown>): string {
  const base = JSON.parse(VALID);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return JSON.stringify(base);
}

describe("loadManifest", () => {
  it("accepts a well-formed claude+codex manifest", () => {
    const { manifest, errors } = loadManifest(VALID);
    expect(errors).toEqual([]);
    expect(manifest).toBeDefined();
    expect(manifest?.name).toBe("sdd");
    expect(manifest?.version).toBe("1.2.0");
    expect(manifest?.runtimes).toEqual(["claude", "codex"]);
    expect(manifest?.dependencies).toEqual([{ name: "some-base-plugin", range: "^1" }]);
    expect(manifest?.blocks).toEqual({ claude: "claude/", codex: "codex/" });
  });

  it("treats dependencies as optional (empty when omitted)", () => {
    const { manifest, errors } = loadManifest(withField({ dependencies: undefined }));
    expect(errors).toEqual([]);
    expect(manifest?.dependencies).toEqual([]);
  });

  it("trims the description", () => {
    const { manifest } = loadManifest(withField({ description: "  trims me  " }));
    expect(manifest?.description).toBe("trims me");
  });

  describe("rejects bad input (fail-closed, no manifest returned)", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["non-JSON", "{not json", /invalid JSON/],
      ["non-object JSON", "42", /must be a JSON object/],
      ["bad name", withField({ name: "SDD Plugin" }), /name: required/],
      ["missing version", withField({ version: undefined }), /version: required/],
      ["non-semver version", withField({ version: "1.2" }), /version: required/],
      ["empty description", withField({ description: "   " }), /description: required/],
      ["empty runtimes orphans the declared blocks", withField({ runtimes: [] }), /is not a declared runtime/],
      ["unknown runtime", withField({ runtimes: ["claude", "claud"], blocks: { claude: "claude/", claud: "x/" } }), /not a known runtime/],
      ["deferred runtime (gemini)", withField({ runtimes: ["gemini"], blocks: { gemini: "gemini/" } }), /not supported until a later version/],
      ["duplicate runtime", withField({ runtimes: ["claude", "claude"] }), /listed more than once/],
      ["malformed dependency", withField({ dependencies: ["some-base-plugin"] }), /must be 'name@range'/],
      ["duplicate dependency", withField({ dependencies: ["some-base-plugin@^1", "some-base-plugin@^2"] }), /listed more than once/],
      ["orphan block not in runtimes", withField({ runtimes: ["claude"], blocks: { claude: "claude/", codex: "codex/" } }), /is not a declared runtime/],
      ["unknown block key (gemini)", withField({ blocks: { claude: "claude/", codex: "codex/", gemini: "g/" } }), /is not a declared runtime/],
      ["absolute block path", withField({ blocks: { claude: "/etc/x", codex: "codex/" } }), /must be relative/],
      ["block path escaping root (..)", withField({ blocks: { claude: "../evil", codex: "codex/" } }), /'\.' or '\.\.' segment/],
      ["windows drive backslash", withField({ blocks: { claude: "C:\\tmp", codex: "codex/" } }), /POSIX '\/' separators/],
      ["windows drive forward-slash", withField({ blocks: { claude: "C:/tmp", codex: "codex/" } }), /invalid path segment/],
      ["UNC path", withField({ blocks: { claude: "\\\\server\\share", codex: "codex/" } }), /POSIX '\/' separators/],
      ["null byte in path", withField({ blocks: { claude: "codex/\u0000x", codex: "codex/" } }), /control\/null/],
      ["dot segment", withField({ blocks: { claude: "./codex", codex: "codex/" } }), /'\.' or '\.\.' segment/],
      ["self-dependency", withField({ dependencies: ["sdd@^1"] }), /cannot depend on itself/],
      ["whitespace-only range", withField({ dependencies: ["some-base-plugin@   "] }), /empty or invalid version range/],
      ["unknown top-level field", withField({ wat: "x" }), /unknown field 'wat'/],
    ];
    for (const [label, input, re] of cases) {
      it(label, () => {
        const { manifest, errors } = loadManifest(input);
        expect(manifest).toBeUndefined();
        expect(errors.some((e) => re.test(e))).toBe(true);
      });
    }
  });

  it("accepts a nested-but-contained block path", () => {
    const { manifest, errors } = loadManifest(withField({ blocks: { claude: "blocks/claude/", codex: "codex" } }));
    expect(errors).toEqual([]);
    expect(manifest?.blocks.claude).toBe("blocks/claude/");
    expect(manifest?.blocks.codex).toBe("codex");
  });

  // spec 251 — blocks are OPTIONAL (skills-only / partial-hooks plugins); loadPlugin enforces "≥1 capability".
  it("accepts a manifest with NO blocks (a skills-only plugin)", () => {
    const { manifest, errors } = loadManifest(withField({ blocks: undefined }));
    expect(errors).toEqual([]);
    expect(manifest?.blocks).toEqual({});
    expect(manifest?.runtimes).toEqual(["claude", "codex"]);
  });

  it("accepts PARTIAL blocks (hooks for a subset of the declared runtimes)", () => {
    const { manifest, errors } = loadManifest(withField({ blocks: { claude: "claude/" } }));
    expect(errors).toEqual([]);
    expect(manifest?.blocks).toEqual({ claude: "claude/" });
    expect("codex" in (manifest?.blocks ?? {})).toBe(false);
  });

  it("rejects a __proto__ block key without polluting Object.prototype", () => {
    // raw JSON (JSON.stringify drops a literal __proto__ key, so build the string by hand).
    const raw = '{"name":"sdd","version":"1.0.0","description":"d","runtimes":["claude","codex"],"blocks":{"claude":"claude/","codex":"codex/","__proto__":"evil/"}}';
    const { manifest, errors } = loadManifest(raw);
    expect(manifest).toBeUndefined();
    expect(errors.some((e) => /is not a declared runtime/.test(e))).toBe(true);
    expect(({} as Record<string, unknown>).evil).toBeUndefined(); // no prototype pollution
  });

  // spec 264 — runtime-agnostic git-hooks (v1: pre-commit only; leaf is a payload script or an argv vector).
  it("defaults gitHooks to {} when omitted", () => {
    const { manifest, errors } = loadManifest(VALID);
    expect(errors).toEqual([]);
    expect(manifest?.gitHooks).toEqual({});
  });

  it("accepts a pre-commit git-hook declared as a payload script", () => {
    const { manifest, errors } = loadManifest(withField({ gitHooks: { "pre-commit": { leaf: "githooks/scan.sh" } } }));
    expect(errors).toEqual([]);
    expect(manifest?.gitHooks).toEqual({ "pre-commit": { kind: "script", path: "githooks/scan.sh" } });
  });

  it("accepts a pre-commit git-hook declared as an argv vector", () => {
    const { manifest, errors } = loadManifest(withField({ gitHooks: { "pre-commit": { argv: ["gitleaks", "protect", "--staged"] } } }));
    expect(errors).toEqual([]);
    expect(manifest?.gitHooks).toEqual({ "pre-commit": { kind: "argv", argv: ["gitleaks", "protect", "--staged"] } });
  });

  it("a git-hook-only manifest needs NO runtime — runtime-agnostic (spec 264 follow-up)", () => {
    const { manifest, errors } = loadManifest(JSON.stringify({ name: "commit-guard", version: "1.0.0", description: "a git-hook gate", gitHooks: { "pre-commit": { leaf: "githooks/guard.sh" } } }));
    expect(errors).toEqual([]);
    expect(manifest?.runtimes).toEqual([]);
    expect(manifest?.gitHooks).toEqual({ "pre-commit": { kind: "script", path: "githooks/guard.sh" } });
  });

  it("rejects bad git-hook declarations (fail-closed)", () => {
    const bad = (gh: unknown) => loadManifest(withField({ gitHooks: gh as Record<string, unknown> })).errors;
    expect(bad({ "post-commit": { leaf: "x.sh" } }).some((e) => /not a supported git hook event/.test(e))).toBe(true);
    expect(bad({ "pre-commit": { leaf: "a.sh", argv: ["b"] } }).some((e) => /exactly one of 'leaf'/.test(e))).toBe(true);
    expect(bad({ "pre-commit": {} }).some((e) => /exactly one of 'leaf'/.test(e))).toBe(true);
    expect(bad({ "pre-commit": { leaf: "../escape.sh" } }).some((e) => /'\.' or '\.\.' segment/.test(e))).toBe(true);
    expect(bad({ "pre-commit": { argv: [] } }).some((e) => /non-empty list/.test(e))).toBe(true);
    expect(bad({ "pre-commit": { argv: ["ok", 7] } }).some((e) => /control-free string/.test(e))).toBe(true);
    expect(bad("nope").some((e) => /map of git-event/.test(e))).toBe(true);
  });

  it("accepts runtime-agnostic views and defaults actions to [] (spec 349)", () => {
    const { manifest, errors } = loadManifest(JSON.stringify({
      name: "mundinho",
      version: "1.0.0",
      description: "agent world",
      views: [{ id: "agents", title: "Agents", surface: "editor", entry: "ui/index.html", fleet: "summary", actions: ["focusAgent"] }],
    }));
    expect(errors).toEqual([]);
    expect(manifest?.runtimes).toEqual([]);
    expect(manifest?.views).toEqual([{ id: "agents", title: "Agents", surface: "editor", entry: "ui/index.html", fleet: "summary", actions: ["focusAgent"] }]);
  });

  it("rejects bad views fail-closed: uncontained entry, unknown fields, and over-cap lists", () => {
    const bad = (views: unknown) => loadManifest(JSON.stringify({ name: "mundinho", version: "1.0.0", description: "agent world", views })).errors;
    expect(bad([{ id: "agents", title: "Agents", surface: "editor", entry: "../index.html", fleet: "summary" }]).some((e) => /views\[0\]\.entry.*'\.' or '\.\.' segment/.test(e))).toBe(true);
    expect(bad([{ id: "agents", title: "Agents", surface: "editor", entry: "index.html", fleet: "summary", surprise: true }]).some((e) => /unknown field 'surprise'/.test(e))).toBe(true);
    expect(bad(Array.from({ length: 65 }, (_, i) => ({ id: `v${i}`, title: "V", surface: "editor", entry: "index.html", fleet: "summary" }))).some((e) => /views: too many entries/.test(e))).toBe(true);
    expect(bad([{ id: "agents", title: "Agents", surface: "editor", entry: "index.html", fleet: "summary", actions: Array.from({ length: 65 }, (_, i) => `a${i}`) }]).some((e) => /actions: too many entries/.test(e))).toBe(true);
  });

  // spec 265 — author-pinned per-platform tool provisioning (task 1: manifest declaration only).
  const SHA = "a".repeat(64);
  const SHB = "b".repeat(64);
  const tool = (over: Record<string, unknown> = {}) => ({
    version: "8.18.4",
    platforms: { "linux-x64-glibc": { url: "https://example.com/t.tar.gz", sha256: SHA }, ...((over.platforms as object) ?? {}) },
    ...over,
  });

  it("defaults tools to {} when omitted", () => {
    const { manifest, errors } = loadManifest(VALID);
    expect(errors).toEqual([]);
    expect(manifest?.tools).toEqual({});
  });

  it("accepts a well-formed raw-binary tool pin", () => {
    const { manifest, errors } = loadManifest(withField({ tools: { gitleaks: tool() } }));
    expect(errors).toEqual([]);
    expect(manifest?.tools.gitleaks.version).toBe("8.18.4");
    expect(manifest?.tools.gitleaks.platforms["linux-x64-glibc"]).toEqual({ url: "https://example.com/t.tar.gz", sha256: SHA });
  });

  it("accepts an archive-wrapped tool pin (tar.gz + innerPath + binSha256)", () => {
    const t = tool({ platforms: { "darwin-arm64": { url: "https://example.com/t.tgz", sha256: SHA, archive: { type: "tgz", innerPath: "bin/gitleaks", binSha256: SHB } } } });
    const { manifest, errors } = loadManifest(withField({ tools: { gitleaks: t } }));
    expect(errors).toEqual([]);
    expect(manifest?.tools.gitleaks.platforms["darwin-arm64"]?.archive).toEqual({ type: "tgz", innerPath: "bin/gitleaks", binSha256: SHB });
  });

  it("accepts the optional detect-first fields (versionCommand + allowedHostSha256)", () => {
    const t = tool({ versionCommand: ["gitleaks", "version"], allowedHostSha256: SHB });
    const { manifest, errors } = loadManifest(withField({ tools: { gitleaks: t } }));
    expect(errors).toEqual([]);
    expect(manifest?.tools.gitleaks.versionCommand).toEqual(["gitleaks", "version"]);
    expect(manifest?.tools.gitleaks.allowedHostSha256).toBe(SHB);
  });

  it("rejects bad tool declarations (fail-closed)", () => {
    const bad = (t: unknown) => loadManifest(withField({ tools: { gitleaks: t } })).errors;
    expect(bad(tool({ platforms: { "linux-x64-glibc": { url: "http://example.com/t", sha256: SHA } } })).some((e) => /must use https/.test(e))).toBe(true);
    expect(bad(tool({ platforms: { "linux-x64-glibc": { url: "https://example.com/t", sha256: "nothex" } } })).some((e) => /64-char lowercase-hex sha256/.test(e))).toBe(true);
    expect(bad(tool({ platforms: { "linux-x86": { url: "https://example.com/t", sha256: SHA } } })).some((e) => /is not a known platform key/.test(e))).toBe(true);
    expect(bad(tool({ platforms: {} })).some((e) => /at least one platform/.test(e))).toBe(true);
    expect(bad({ version: "1.0", platforms: { "linux-x64-glibc": { url: "https://x.io/t", sha256: SHA, archive: { type: "zip", innerPath: "gitleaks", binSha256: SHB } } } }).some((e) => /'zip' is not supported in v1/.test(e))).toBe(true);
    expect(bad({ version: "1.0", platforms: { "linux-x64-glibc": { url: "https://x.io/t", sha256: SHA, archive: { type: "tar.gz", innerPath: "../escape", binSha256: SHB } } } }).some((e) => /'\.' or '\.\.' segment/.test(e))).toBe(true);
    expect(bad({ platforms: { "linux-x64-glibc": { url: "https://x.io/t", sha256: SHA } } }).some((e) => /version: required/.test(e))).toBe(true);
    expect(bad(tool({ versionCommand: [] })).some((e) => /non-empty list/.test(e))).toBe(true);
    expect(bad(tool({ wat: "x" })).some((e) => /unknown field 'wat'/.test(e))).toBe(true);
  });

  it("rejects a bad tool NAME and a non-map tools value", () => {
    expect(loadManifest(withField({ tools: { "Git Leaks": tool() } })).errors.some((e) => /is not a valid tool name/.test(e))).toBe(true);
    expect(loadManifest(withField({ tools: "nope" })).errors.some((e) => /a map of tool-name/.test(e))).toBe(true);
  });

  // spec 269 — launcher-enforced launch policy
  it("accepts a well-formed launchPolicy (env + args + denyArgs + force)", () => {
    const t = tool({ launchPolicy: { env: { AGENT_BROWSER_CONFIRM_ACTIONS: "click,eval" }, args: ["--safe"], denyArgs: ["--confirm-actions", "--action-policy"], mode: "force" } });
    const { manifest, errors } = loadManifest(withField({ tools: { gitleaks: t } }));
    expect(errors).toEqual([]);
    expect(manifest?.tools.gitleaks.launchPolicy).toEqual({ env: { AGENT_BROWSER_CONFIRM_ACTIONS: "click,eval" }, args: ["--safe"], denyArgs: ["--confirm-actions", "--action-policy"], mode: "force" });
  });

  it("canonicalizes launchPolicy env key order (stable fingerprint — codex #4)", () => {
    const t = tool({ launchPolicy: { env: { ZED: "1", ABLE: "2", MID: "3" }, mode: "force" } });
    const { manifest } = loadManifest(withField({ tools: { gitleaks: t } }));
    expect(Object.keys(manifest!.tools.gitleaks.launchPolicy!.env!)).toEqual(["ABLE", "MID", "ZED"]);
  });

  it("accepts a launchPolicy with only one of env/args/denyArgs", () => {
    expect(loadManifest(withField({ tools: { gitleaks: tool({ launchPolicy: { env: { FOO: "bar" }, mode: "force" } }) } })).errors).toEqual([]);
    expect(loadManifest(withField({ tools: { gitleaks: tool({ launchPolicy: { denyArgs: ["--x"], mode: "force" } }) } })).errors).toEqual([]);
  });

  it("spec 270/271 — accepts + round-trips launchPolicy configArg + scrubEnv; rejects malformed (fail-closed)", () => {
    const t = tool({ launchPolicy: { configArg: "--config", scrubEnv: ["AGENT_BROWSER_CONFIG", "AGENT_BROWSER_ACTION_POLICY"], denyArgs: ["--config"], mode: "force" } });
    const { manifest, errors } = loadManifest(withField({ tools: { gitleaks: t } }));
    expect(errors).toEqual([]);
    expect(manifest?.tools.gitleaks.launchPolicy).toEqual({ denyArgs: ["--config"], configArg: "--config", scrubEnv: ["AGENT_BROWSER_ACTION_POLICY", "AGENT_BROWSER_CONFIG"], mode: "force" });
    // configArg/scrubEnv alone satisfy the non-trivial check
    expect(loadManifest(withField({ tools: { gitleaks: tool({ launchPolicy: { configArg: "--config", mode: "force" } }) } })).errors).toEqual([]);
    expect(loadManifest(withField({ tools: { gitleaks: tool({ launchPolicy: { scrubEnv: ["FOO"], mode: "force" } }) } })).errors).toEqual([]);
    // malformed: configArg without a leading '-', invalid scrubEnv name
    const badArg = (lp: unknown) => loadManifest(withField({ tools: { gitleaks: tool({ launchPolicy: lp }) } })).errors;
    expect(badArg({ configArg: "config", mode: "force" }).some((e) => /configArg: must be a control-free flag string starting with '-'/.test(e))).toBe(true);
    expect(badArg({ scrubEnv: ["bad-key"], mode: "force" }).some((e) => /scrubEnv: 'bad-key' is not a valid env var name/.test(e))).toBe(true);
  });

  it("rejects malformed launchPolicy (fail-closed)", () => {
    const bad = (lp: unknown) => loadManifest(withField({ tools: { gitleaks: tool({ launchPolicy: lp }) } })).errors;
    expect(bad({ env: { FOO: "x" } }).some((e) => /mode: must be "force"/.test(e))).toBe(true); // missing/!force mode
    expect(bad({ mode: "warn", env: { FOO: "x" } }).some((e) => /mode: must be "force"/.test(e))).toBe(true);
    expect(bad({ mode: "force" }).some((e) => /at least one of env/.test(e))).toBe(true);
    expect(bad({ mode: "force", env: { "bad-key": "x" } }).some((e) => /is not a valid env var name/.test(e))).toBe(true);
    expect(bad({ mode: "force", env: { FOO: 5 } }).some((e) => /env\.FOO: must be a control-free string/.test(e))).toBe(true);
    expect(bad({ mode: "force", env: {} }).some((e) => /at least one of env/.test(e))).toBe(true); // codex #2: empty env → reject consistently with the lockfile
    expect(bad({ mode: "force", env: { LD_PRELOAD: "/tmp/evil.so" } }).some((e) => /is not allowed.*loader\/exec-hijacking/.test(e))).toBe(true); // codex #5
    expect(bad({ mode: "force", env: { PATH: "/evil" } }).some((e) => /PATH.*is not allowed/.test(e))).toBe(true);
    expect(bad({ mode: "force", env: { DYLD_FALLBACK_LIBRARY_PATH: "/evil" } }).some((e) => /is not allowed/.test(e))).toBe(true); // codex re-review: whole DYLD_* family
    expect(bad({ mode: "force", env: { LD_AUDIT: "/evil.so" } }).some((e) => /is not allowed/.test(e))).toBe(true);
    expect(bad({ mode: "force", args: [] }).some((e) => /args: must be a non-empty list/.test(e))).toBe(true);
    expect(bad({ mode: "force", denyArgs: ["--x", "--x"] }).some((e) => /denyArgs: must not contain duplicates/.test(e))).toBe(true);
    expect(bad({ mode: "force", env: { FOO: "x" }, wat: 1 }).some((e) => /launchPolicy: unknown field 'wat'/.test(e))).toBe(true);
    expect(bad("nope").some((e) => /launchPolicy: must be an object/.test(e))).toBe(true);
  });

  it("caps an oversized dependency list", () => {
    const many = Array.from({ length: 100 }, (_, i) => `dep${i}@^1`);
    const { errors } = loadManifest(withField({ dependencies: many }));
    expect(errors.some((e) => /too many/.test(e))).toBe(true);
  });

  it("rejects a manifest exceeding the byte cap", () => {
    const huge = withField({ description: "x".repeat(70 * 1024) });
    const { errors } = loadManifest(huge);
    expect(errors.some((e) => /exceeds .* bytes/.test(e))).toBe(true);
  });

  it("accumulates multiple errors in one pass", () => {
    const { errors } = loadManifest(JSON.stringify({ name: "BAD", version: "x", runtimes: [] }));
    expect(errors.length).toBeGreaterThanOrEqual(3); // name + version + runtimes (+ description + blocks)
  });
});

describe("resolveCompat", () => {
  const { manifest } = loadManifest(VALID);

  it("splits declared runtimes into installable vs missing-from-workspace", () => {
    const r = resolveCompat(manifest!, new Set(["claude"]));
    expect(r.installable).toEqual(["claude"]);
    expect(r.missingFromWorkspace).toEqual(["codex"]);
  });

  it("all installable when every declared runtime is present", () => {
    const r = resolveCompat(manifest!, new Set(["claude", "codex", "gemini"]));
    expect(r.installable).toEqual(["claude", "codex"]);
    expect(r.missingFromWorkspace).toEqual([]);
  });

  it("nothing installable when no declared runtime is present (no phantom success)", () => {
    const r = resolveCompat(manifest!, new Set(["gemini"]));
    expect(r.installable).toEqual([]);
    expect(r.missingFromWorkspace).toEqual(["claude", "codex"]);
  });
});

describe("SUPPORTED_RUNTIMES", () => {
  it("is claude + codex + grok for v1 (gemini deferred)", () => {
    expect([...SUPPORTED_RUNTIMES]).toEqual(["claude", "codex", "grok"]);
  });

  it("t-2f99e7 — accepts runtimes:[grok] and blocks.grok", () => {
    const { manifest, errors } = loadManifest(withField({
      runtimes: ["grok"],
      blocks: { grok: "grok/" },
    }));
    expect(errors).toEqual([]);
    expect(manifest?.runtimes).toEqual(["grok"]);
    expect(manifest?.blocks).toEqual({ grok: "grok/" });
  });
});

describe("config + docsUrl (spec 270)", () => {
  it("accepts a config (file + schemaFile) and an https docsUrl", () => {
    const { manifest, errors } = loadManifest(
      withField({ config: { file: "config/agent-browser.json", schemaFile: "config/schema.json" }, docsUrl: "https://example.com/docs" }),
    );
    expect(errors).toEqual([]);
    expect(manifest?.config).toEqual({ file: "config/agent-browser.json", schemaFile: "config/schema.json" });
    expect(manifest?.docsUrl).toBe("https://example.com/docs");
  });

  it("treats config + docsUrl as optional (absent when omitted)", () => {
    const { manifest, errors } = loadManifest(VALID);
    expect(errors).toEqual([]);
    expect(manifest?.config).toBeUndefined();
    expect(manifest?.docsUrl).toBeUndefined();
  });

  it("accepts a config with no schemaFile", () => {
    const { manifest, errors } = loadManifest(withField({ config: { file: "settings.json" } }));
    expect(errors).toEqual([]);
    expect(manifest?.config).toEqual({ file: "settings.json" });
  });

  describe("rejects bad config/docsUrl (fail-closed)", () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["config not an object", { config: "x" }, /config: when present/],
      ["config missing file", { config: { schemaFile: "s.json" } }, /config\.file: must be a non-empty relative path/],
      ["config.file is a dir", { config: { file: "config/" } }, /config\.file: must name a file/],
      ["config.file escapes payload", { config: { file: "../evil.json" } }, /must stay inside the plugin/],
      ["config.file absolute", { config: { file: "/etc/passwd" } }, /must be relative/],
      ["config unknown sub-field", { config: { file: "c.json", extra: 1 } }, /config: unknown field 'extra'/],
      ["config.schemaFile is a dir", { config: { file: "c.json", schemaFile: "s/" } }, /config\.schemaFile: must name a file/],
      ["docsUrl not https", { docsUrl: "http://example.com" }, /docsUrl: must use https/],
      ["docsUrl command: scheme", { docsUrl: "command:evil" }, /docsUrl: must use https/],
      ["docsUrl not a url", { docsUrl: "not a url" }, /docsUrl: '.*' is not a valid URL/],
    ];
    for (const [label, patch, re] of cases) {
      it(label, () => {
        const { manifest, errors } = loadManifest(withField(patch));
        expect(manifest).toBeUndefined();
        expect(errors.some((e) => re.test(e))).toBe(true);
      });
    }
  });
});
