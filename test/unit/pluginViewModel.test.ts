import { describe, it, expect } from "vitest";
import { buildPluginsViewModel, type UpdateCheck } from "../../src/plugins/viewModel.js";
import { serializeLockfile } from "../../src/plugins/lockfile.js";
import type { Runtime } from "../../src/plugins/manifest.js";

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

  it("status maps from injected update-checks; default (no check) is unknown", () => {
    const checks: Record<string, UpdateCheck> = {
      a: { kind: "up-to-date" },
      b: { kind: "update-available", latestVersion: "2.0.0" },
      c: { kind: "drift", detail: "edited locally" },
      d: { kind: "conflict", detail: "baseline edited" },
      e: { kind: "error", detail: "remote unreachable" },
      // f intentionally omitted → unknown
    };
    const vm = buildPluginsViewModel({
      lockfileText: lockText(["a", "b", "c", "d", "e", "f"].map((name) => ({ name, version: "1.0.0", runtimes: ["claude"] as Runtime[], sourced: true }))),
      present: ws("claude"),
      updateChecks: checks,
    });
    const by = Object.fromEntries(vm.installed.map((p) => [p.name, p]));
    expect(by.a.status.kind).toBe("up-to-date");
    expect(by.b.status).toEqual({ kind: "update-available", latestVersion: "2.0.0" });
    expect(by.c.status).toEqual({ kind: "drift", detail: "edited locally" });
    expect(by.d.status).toEqual({ kind: "conflict", detail: "baseline edited" });
    expect(by.e.status).toEqual({ kind: "error", detail: "remote unreachable" });
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
});
