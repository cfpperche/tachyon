import { describe, it, expect } from "vitest";
import { buildPluginsViewModel, buildExternalStatuses, buildMcpStatuses, buildContributionStatuses, type UpdateCheck } from "../../src/plugins/viewModel.js";
import type { PluginLock } from "@tachyon/engine/plugins/lockfile.js";
import { serializeLockfile } from "@tachyon/engine/plugins/lockfile.js";
import type { Runtime } from "@tachyon/engine/plugins/manifest.js";

const ws = (...rt: Runtime[]): ReadonlySet<Runtime> => new Set(rt);

/** Build a lockfile JSON with one or more plugin entries (each: name, version, runtimes, optional source). */
function lockText(plugins: Array<{ name: string; version: string; runtimes: Runtime[]; sourced?: boolean }>): string {
  const map: Record<string, unknown> = {};
  for (const p of plugins) {
    map[p.name] = {
      name: p.name,
      version: p.version,
      runtimes: p.runtimes,
      targets: p.runtimes.map((rt) => ({
        runtime: rt,
        kind: "settings-hook",
        file: rt === "claude" ? ".claude/settings.json" : ".codex/hooks.json",
        ref: "PreToolUse",
      })),
      ...(p.sourced
        ? {
            source: { type: "git", spec: `github:acme/${p.name}@v${p.version}`, remote: `https://github.com/acme/${p.name}.git`, ref: `v${p.version}`, resolvedCommit: "a1b2c3d".padEnd(40, "0") },
            integrity: { algorithm: "sha256", payload: "deadbeef" },
          }
        : {}),
    };
  }
  return serializeLockfile({ schemaVersion: 1, plugins: map } as never);
}

describe("buildPluginsViewModel", () => {
  it("cold state — no lockfile file at all", () => {
    const vm = buildPluginsViewModel({ lockfileText: undefined, present: ws("claude", "codex") });
    expect(vm.empty).toBe(true);
    expect(vm.installed).toEqual([]);
    expect(vm.parseError).toBeUndefined();
    expect(vm.present).toEqual(["claude", "codex"]); // SUPPORTED_RUNTIMES order
  });

  it("present[] is normalized to SUPPORTED_RUNTIMES order regardless of set insertion order", () => {
    const vm = buildPluginsViewModel({ lockfileText: undefined, present: new Set<Runtime>(["codex", "claude"]) });
    expect(vm.present).toEqual(["claude", "codex"]);
  });

  it("empty lockfile (file exists, zero plugins) is empty but not an error", () => {
    const vm = buildPluginsViewModel({ lockfileText: lockText([]), present: ws("claude") });
    expect(vm.empty).toBe(true);
    expect(vm.parseError).toBeUndefined();
  });

  it("corrupt lockfile yields a parseError banner and suppresses the list", () => {
    const vm = buildPluginsViewModel({ lockfileText: "{ not json", present: ws("claude") });
    expect(vm.parseError).toBeTruthy();
    expect(vm.installed).toEqual([]);
    expect(vm.empty).toBe(false); // there IS a file — it's broken, not absent
  });

  it("a non-ENOENT read failure (readError) surfaces as a banner, not a cold/empty state", () => {
    const vm = buildPluginsViewModel({ readError: ".tachyon/plugins.lock.json: EACCES: permission denied", present: ws("claude") });
    expect(vm.parseError).toBe(".tachyon/plugins.lock.json: EACCES: permission denied");
    expect(vm.installed).toEqual([]);
    expect(vm.empty).toBe(false); // a readability failure is NOT "no plugins"
  });

  it("readError takes precedence over any lockfileText", () => {
    const vm = buildPluginsViewModel({ readError: "boom", lockfileText: lockText([{ name: "p", version: "1.0.0", runtimes: ["claude"] }]), present: ws("claude") });
    expect(vm.parseError).toBe("boom");
    expect(vm.installed).toEqual([]);
  });

  it("a sourced plugin surfaces sourceSpec + short commit + git (not local) install", () => {
    const vm = buildPluginsViewModel({ lockfileText: lockText([{ name: "tdd-guard", version: "1.2.0", runtimes: ["claude", "codex"], sourced: true }]), present: ws("claude", "codex") });
    const p = vm.installed[0];
    expect(p.name).toBe("tdd-guard");
    expect(p.sourceSpec).toBe("github:acme/tdd-guard@v1.2.0");
    expect(p.shortCommit).toBe("a1b2c3d");
    expect(p.shortCommit).toHaveLength(7);
    expect(p.localInstall).toBe(false);
  });

  it("a dir-installed plugin (no source) is marked localInstall with no source fields", () => {
    const vm = buildPluginsViewModel({ lockfileText: lockText([{ name: "local-thing", version: "0.1.0", runtimes: ["claude"] }]), present: ws("claude") });
    const p = vm.installed[0];
    expect(p.localInstall).toBe(true);
    expect(p.sourceSpec).toBeUndefined();
    expect(p.shortCommit).toBeUndefined();
  });

  it("runtime pills follow SUPPORTED_RUNTIMES order and mark present vs vanished", () => {
    // installed for claude+codex, but the workspace now only has claude → codex pill is present:false (drift signal)
    const vm = buildPluginsViewModel({ lockfileText: lockText([{ name: "p", version: "1.0.0", runtimes: ["codex", "claude"], sourced: true }]), present: ws("claude") });
    expect(vm.installed[0].runtimes).toEqual([
      { runtime: "claude", present: true },
      { runtime: "codex", present: false },
    ]);
  });

  it("spec 263 — when `intact` is provided, pills reflect on-disk materialization, NOT detectRuntimes", () => {
    // a skills-only codex install lands in `.agents/skills/` and never creates `.codex/`, so detectRuntimes
    // (present = claude only) would wrongly show codex as drift. `intact` lists codex → its pill is present:true.
    const vm = buildPluginsViewModel({
      lockfileText: lockText([{ name: "sdd", version: "1.1.0", runtimes: ["claude", "codex"], sourced: true }]),
      present: ws("claude"), // .codex/ does not exist on disk
      intact: { sdd: ["claude", "codex"] }, // …but both runtimes' targets are on disk
    });
    expect(vm.installed[0].runtimes).toEqual([
      { runtime: "claude", present: true },
      { runtime: "codex", present: true },
    ]);
  });

  it("spec 263 — `intact` omitting a runtime marks it as drift (its materialized files are gone)", () => {
    const vm = buildPluginsViewModel({
      lockfileText: lockText([{ name: "sdd", version: "1.1.0", runtimes: ["claude", "codex"], sourced: true }]),
      present: ws("claude", "codex"), // both dirs exist…
      intact: { sdd: ["claude"] }, // …but codex's recorded targets were deleted → drift
    });
    expect(vm.installed[0].runtimes).toEqual([
      { runtime: "claude", present: true },
      { runtime: "codex", present: false },
    ]);
  });

  it("status maps from injected update-checks; default (no check) is unknown", () => {
    const checks: Record<string, UpdateCheck> = {
      a: { kind: "up-to-date" },
      b: { kind: "update-available", latestVersion: "2.0.0" },
      c: { kind: "drift", detail: "edited locally" },
      d: { kind: "conflict", detail: "baseline edited" },
      e: { kind: "error", detail: "remote unreachable" },
      g: { kind: "source-changed", version: "1.0.0" },
      // f intentionally omitted → unknown
    };
    const vm = buildPluginsViewModel({
      lockfileText: lockText(["a", "b", "c", "d", "e", "f", "g"].map((name) => ({ name, version: "1.0.0", runtimes: ["claude"] as Runtime[], sourced: true }))),
      present: ws("claude"),
      updateChecks: checks,
    });
    const by = Object.fromEntries(vm.installed.map((p) => [p.name, p]));
    expect(by.a.status.kind).toBe("up-to-date");
    expect(by.b.status).toEqual({ kind: "update-available", latestVersion: "2.0.0" });
    expect(by.c.status).toEqual({ kind: "drift", detail: "edited locally" });
    expect(by.d.status).toEqual({ kind: "conflict", detail: "baseline edited" });
    expect(by.e.status).toEqual({ kind: "error", detail: "remote unreachable" });
    expect(by.g.status).toEqual({ kind: "source-changed", detail: "still v1.0.0" });
    expect(by.f.status.kind).toBe("unknown");
  });

  it("actions are derived deterministically from status", () => {
    const mk = (check: UpdateCheck | undefined) =>
      buildPluginsViewModel({
        lockfileText: lockText([{ name: "p", version: "1.0.0", runtimes: ["claude"], sourced: true }]),
        present: ws("claude"),
        ...(check ? { updateChecks: { p: check } } : {}),
      }).installed[0].actions;

    expect(mk({ kind: "update-available", latestVersion: "2.0.0" })).toEqual(["update", "remove"]);
    expect(mk({ kind: "source-changed", version: "1.0.0" })).toEqual(["reapply", "remove"]);
    expect(mk({ kind: "drift" })).toEqual(["reinstall", "remove"]);
    expect(mk({ kind: "conflict" })).toEqual(["reinstall", "remove"]);
    expect(mk({ kind: "up-to-date" })).toEqual(["remove"]);
    expect(mk({ kind: "error", detail: "x" })).toEqual(["remove"]);
    expect(mk(undefined)).toEqual(["remove"]); // unknown
  });

  it("installed list is sorted by name for a stable render", () => {
    const vm = buildPluginsViewModel({
      lockfileText: lockText([
        { name: "zebra", version: "1.0.0", runtimes: ["claude"] },
        { name: "alpha", version: "1.0.0", runtimes: ["claude"] },
        { name: "mango", version: "1.0.0", runtimes: ["claude"] },
      ]),
      present: ws("claude"),
    });
    expect(vm.installed.map((p) => p.name)).toEqual(["alpha", "mango", "zebra"]);
  });

  it("spec 270 — surfaces config + docsUrl on the card VM; absent when the plugin declares neither", () => {
    const lockfileText = JSON.stringify({
      schemaVersion: 1,
      plugins: {
        ab: { name: "ab", version: "2.0.1", runtimes: ["claude"], targets: [{ runtime: "claude", kind: "settings-hook", file: ".claude/settings.json", ref: "PreToolUse" }], config: { file: ".tachyon/plugins/ab/config/agent-browser.json", schemaFile: ".tachyon/plugins/ab/config/schema.json" }, docsUrl: "https://github.com/org/plugins" },
        plain: { name: "plain", version: "1.0.0", runtimes: ["claude"], targets: [{ runtime: "claude", kind: "settings-hook", file: ".claude/settings.json", ref: "PreToolUse" }] },
      },
    });
    const vm = buildPluginsViewModel({ lockfileText, present: ws("claude") });
    const ab = vm.installed.find((p) => p.name === "ab")!;
    expect(ab.config).toEqual({ file: ".tachyon/plugins/ab/config/agent-browser.json", schemaFile: ".tachyon/plugins/ab/config/schema.json" });
    expect(ab.docsUrl).toBe("https://github.com/org/plugins");
    const plain = vm.installed.find((p) => p.name === "plain")!;
    expect(plain.config).toBeUndefined();
    expect(plain.docsUrl).toBeUndefined();
  });

  it("spec 287 — attaches injected externalStatuses to the matching card; omits the row when absent/empty", () => {
    const vm = buildPluginsViewModel({
      lockfileText: lockText([{ name: "transcribe", version: "1.0.0", runtimes: ["claude"] }, { name: "plain", version: "1.0.0", runtimes: ["claude"] }]),
      present: ws("claude"),
      externalStatuses: {
        transcribe: [
          { name: "ffmpeg", present: true, installable: true, manual: "install ffmpeg" },
          { name: "whisper-cli", present: false, installable: false, manual: "brew install whisper-cpp" },
        ],
        // an empty list must NOT produce an (empty) externalTools row.
        plain: [],
      },
    });
    const t = vm.installed.find((p) => p.name === "transcribe")!;
    expect(t.externalTools).toEqual([
      { name: "ffmpeg", present: true, installable: true, manual: "install ffmpeg" },
      { name: "whisper-cli", present: false, installable: false, manual: "brew install whisper-cpp" },
    ]);
    const plain = vm.installed.find((p) => p.name === "plain")!;
    expect(plain.externalTools).toBeUndefined();
  });

  it("Phase C — attaches injected mcpStatuses; installed-not-applied is a row, not omitted", () => {
    const vm = buildPluginsViewModel({
      lockfileText: lockText([{ name: "mcp-pl", version: "1.0.0", runtimes: ["claude"] }, { name: "plain", version: "1.0.0", runtimes: ["claude"] }]),
      present: ws("claude"),
      mcpStatuses: {
        "mcp-pl": [
          { name: "db", applied: false },
          { name: "api", applied: true },
        ],
        plain: [],
      },
    });
    expect(vm.installed.find((p) => p.name === "mcp-pl")!.mcpServers).toEqual([
      { name: "db", applied: false },
      { name: "api", applied: true },
    ]);
    expect(vm.installed.find((p) => p.name === "plain")!.mcpServers).toBeUndefined();
  });

  it("Phase C — a corrupt applied-state is a banner, not an empty plugin list", () => {
    const vm = buildPluginsViewModel({
      lockfileText: lockText([{ name: "mcp-pl", version: "1.0.0", runtimes: ["claude"] }]),
      present: ws("claude"),
      appliedError: ".tachyon/plugins-applied.json is corrupt — fix or delete it",
    });
    expect(vm.appliedError).toMatch(/corrupt/);
    expect(vm.installed).toHaveLength(1);
    expect(vm.parseError).toBeUndefined();
  });
});

describe("buildExternalStatuses (spec 287 D3 — host gather mapping)", () => {
  const mk = (name: string, reqs?: PluginLock["externalTools"]): PluginLock =>
    ({ name, version: "1.0.0", runtimes: ["claude"], targets: [], ...(reqs ? { externalTools: reqs } : {}) } as PluginLock);

  it("maps each declared external tool to present/installable/manual via the injected oracle", () => {
    const plugins = [
      mk("transcribe", [
        { name: "ffmpeg", install: { apt: ["sudo", "apt-get", "install", "-y", "ffmpeg"] }, manual: "install ffmpeg" },
        { name: "whisper-cli", install: {}, manual: "brew install whisper-cpp" }, // no PM command → not installable
      ]),
      mk("plain"), // no external tools → omitted entirely
    ];
    const out = buildExternalStatuses(plugins, (req) => req.name === "ffmpeg" ? { present: true, path: "/usr/bin/ffmpeg" } : { present: false }); // only ffmpeg present
    expect(out.transcribe).toEqual([
      { name: "ffmpeg", present: true, installable: true, manual: "install ffmpeg", resolvedPath: "/usr/bin/ffmpeg" },
      { name: "whisper-cli", present: false, installable: false, manual: "brew install whisper-cpp" },
    ]);
    expect(out.plain).toBeUndefined();
  });

  it("spec 289 — surfaces the candidate names (when >1) + the winning resolved path; honours names in the oracle", () => {
    const plugins = [mk("diagram", [
      { name: "chrome", names: ["google-chrome", "chromium"], install: {}, manual: "install a browser" },
    ])];
    const out = buildExternalStatuses(plugins, (req) => {
      // the oracle receives the full req incl. names (D7) — resolve the second candidate as present.
      expect(req.names).toEqual(["google-chrome", "chromium"]);
      return { present: true, path: "/usr/bin/chromium" };
    });
    expect(out.diagram).toEqual([
      { name: "chrome", present: true, installable: false, manual: "install a browser", names: ["google-chrome", "chromium"], resolvedPath: "/usr/bin/chromium" },
    ]);
  });

  it("does NOT surface resolvedPath for a tool that has a detect probe (card is detect-blind — codex LOW)", () => {
    const plugins = [mk("p", [{ name: "ffmpeg", detect: ["-version"], install: { apt: ["sudo", "apt-get", "install", "-y", "ffmpeg"] }, manual: "x" }])];
    const out = buildExternalStatuses(plugins, () => ({ present: true, path: "/usr/bin/ffmpeg" }));
    expect(out.p[0].present).toBe(true);
    expect(out.p[0].resolvedPath).toBeUndefined(); // present but no path claim (detect not verified on the card)
  });

  it("a plugin with an empty externalTools array is omitted (no empty row)", () => {
    expect(buildExternalStatuses([mk("x", [])], () => ({ present: true }))).toEqual({});
  });
});

describe("buildMcpStatuses — Phase C card rows", () => {
  const mcpLock = (name: string, refs: string[]): PluginLock =>
    ({
      name,
      version: "1.0.0",
      runtimes: ["claude", "codex"],
      targets: refs.flatMap((ref) => [
        { runtime: "claude", kind: "mcp-server", file: ".mcp.json", ref, removal: { command: "npx" } },
        { runtime: "codex", kind: "mcp-server", file: ".codex/config.toml", ref, removal: "[mcp_servers.x]" },
      ]),
    }) as PluginLock;

  it("dedupes a server recorded for two runtimes into one row, keyed by applied-state", () => {
    const out = buildMcpStatuses([mcpLock("mcp-pl", ["db", "api"]), { name: "plain", version: "1.0.0", runtimes: ["claude"], targets: [] } as PluginLock], (plugin, name) => plugin === "mcp-pl" && name === "db");
    expect(out["mcp-pl"]).toEqual([
      { name: "api", applied: false },
      { name: "db", applied: true },
    ]);
    expect(out.plain).toBeUndefined();
  });

  it("omits a plugin that ships no mcp-server targets", () => {
    expect(buildMcpStatuses([{ name: "sdd", version: "1.0.0", runtimes: ["claude"], targets: [] } as PluginLock], () => true)).toEqual({});
  });
});

describe("buildContributionStatuses — SDD 486 Phase A card rows", () => {
  it("dedupes skill and hook targets across runtimes and keeps installed-not-applied visible", () => {
    const lock = { name: "sdd", version: "1.0.0", runtimes: ["claude", "codex"], targets: [
      { runtime: "claude", kind: "skill-dir", file: ".claude/skills/helper" },
      { runtime: "codex", kind: "skill-dir", file: ".agents/skills/helper" },
      { runtime: "claude", kind: "settings-hook", file: ".claude/settings.json", ref: "PreToolUse", removal: [] },
      { runtime: "codex", kind: "settings-hook", file: ".codex/hooks.json", ref: "PreToolUse", removal: [] },
    ] } as PluginLock;
    expect(buildContributionStatuses([lock], "skill-dir", () => false).sdd).toEqual([{ name: "helper", applied: false }]);
    expect(buildContributionStatuses([lock], "settings-hook", (_plugin, name) => name === "PreToolUse").sdd).toEqual([{ name: "PreToolUse", applied: true }]);
  });
});

/**
 * t-fb216a — the runtime-coverage gap: this workspace RUNS a runtime, the installed plugin's manifest
 * DECLARES support for it, and the lockfile never consented to it. spec 263 makes update structurally
 * incapable of closing this (target = lock.runtimes), so the panel's only job here is to NAME it.
 */
describe("buildPluginsViewModel — uncovered runtimes (t-fb216a)", () => {
  it("names the gap: declared by the plugin + run by this workspace + absent from the lockfile", () => {
    const vm = buildPluginsViewModel({
      lockfileText: lockText([{ name: "sdd", version: "1.8.0", runtimes: ["claude", "codex"], sourced: true }]),
      present: ws("claude", "codex", "grok"),
      declared: { sdd: ["claude", "codex", "grok"] },
    });
    expect(vm.installed[0].uncoveredRuntimes).toEqual(["grok"]);
  });

  it("declared but NOT run by this workspace ⇒ no gap (never nag about a runtime nobody uses here)", () => {
    const vm = buildPluginsViewModel({
      lockfileText: lockText([{ name: "sdd", version: "1.8.0", runtimes: ["claude", "codex"], sourced: true }]),
      present: ws("claude", "codex"), // no grok in this workspace
      declared: { sdd: ["claude", "codex", "grok"] },
    });
    expect(vm.installed[0].uncoveredRuntimes).toBeUndefined();
  });

  it("run by this workspace but NOT declared ⇒ no gap (there is nothing the plugin could offer)", () => {
    const vm = buildPluginsViewModel({
      lockfileText: lockText([{ name: "tdd-guard", version: "1.2.0", runtimes: ["claude"], sourced: true }]),
      present: ws("claude", "codex", "grok"),
      declared: { "tdd-guard": ["claude"] },
    });
    expect(vm.installed[0].uncoveredRuntimes).toBeUndefined();
  });

  it("no declared set injected (payload manifest absent/corrupt) ⇒ no signal is invented", () => {
    const vm = buildPluginsViewModel({
      lockfileText: lockText([{ name: "sdd", version: "1.8.0", runtimes: ["claude", "codex"], sourced: true }]),
      present: ws("claude", "codex", "grok"),
      // declared omitted entirely
    });
    expect(vm.installed[0].uncoveredRuntimes).toBeUndefined();
  });

  it("gap is reported in SUPPORTED_RUNTIMES order, not lockfile/manifest order", () => {
    const vm = buildPluginsViewModel({
      lockfileText: lockText([{ name: "p", version: "1.0.0", runtimes: ["claude"], sourced: true }]),
      present: ws("claude", "codex", "grok"),
      declared: { p: ["grok", "codex", "claude"] },
    });
    expect(vm.installed[0].uncoveredRuntimes).toEqual(["codex", "grok"]);
  });

  it("the gap is INDEPENDENT of the update-check: it shows at rest, and coexists with 'up to date'", () => {
    // (c) — "up to date" stays true about the version at the effective spec; the gap is a separate fact,
    // computed with no network, so the silence breaks WITHOUT the user first running "Check for updates".
    const vm = buildPluginsViewModel({
      lockfileText: lockText([{ name: "sdd", version: "1.8.0", runtimes: ["claude", "codex"], sourced: true }]),
      present: ws("claude", "codex", "grok"),
      declared: { sdd: ["claude", "codex", "grok"] },
      updateChecks: { sdd: { kind: "up-to-date" } },
    });
    expect(vm.installed[0].status.kind).toBe("up-to-date");
    expect(vm.installed[0].uncoveredRuntimes).toEqual(["grok"]);
  });

  it("ACCEPTANCE SET — the 8 plugins measured in this workspace on 0.56.158 each report grok uncovered", () => {
    // measured 2026-08-02: manifest declares [claude,codex,grok], lockfile froze at [claude,codex],
    // all at @v2.3.1 (the repo's highest semver tag), all skills-only.
    const eight = ["dep-audit", "diagram", "hyperframes", "image", "sdd", "sound", "transcribe", "video"];
    const vm = buildPluginsViewModel({
      lockfileText: lockText(eight.map((name) => ({ name, version: "0.2.0", runtimes: ["claude", "codex"] as Runtime[], sourced: true }))),
      present: ws("claude", "codex", "grok"),
      declared: Object.fromEntries(eight.map((name) => [name, ["claude", "codex", "grok"] as Runtime[]])),
    });
    expect(vm.installed.map((p) => p.name).sort()).toEqual([...eight].sort());
    for (const p of vm.installed) expect(p.uncoveredRuntimes).toEqual(["grok"]);
  });
});
