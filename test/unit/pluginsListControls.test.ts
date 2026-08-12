import { describe, expect, it } from "vitest";
import { filterAndSortInstalledPlugins, filterInstalledPlugins, sortInstalledPlugins, type InstalledSortMode } from "../../src/webview/plugins/listControls.js";
import type { InstalledPluginVM } from "../../src/plugins/viewModel.js";

function plugin(name: string, opts: Partial<InstalledPluginVM> = {}): InstalledPluginVM {
  return {
    name,
    version: opts.version ?? "1.0.0",
    localInstall: opts.localInstall ?? false,
    sourceSpec: opts.sourceSpec ?? `github:acme/${name}@v${opts.version ?? "1.0.0"}`,
    shortCommit: opts.shortCommit ?? "abcdef0",
    runtimes: opts.runtimes ?? [{ runtime: "claude", present: true }],
    status: opts.status ?? { kind: "unknown" },
    actions: opts.actions ?? ["remove"],
    ...opts,
  };
}

describe("plugins installed-list controls", () => {
  it("filters by name, source, runtime, and status text", () => {
    const rows = [
      plugin("agent-browser", { status: { kind: "up-to-date" }, runtimes: [{ runtime: "claude", present: true }, { runtime: "codex", present: true }] }),
      plugin("local-tool", { localInstall: true, sourceSpec: undefined, status: { kind: "drift", detail: "edited locally" } }),
      plugin("video", { sourceSpec: "github:cfpperche/tachyon-plugins@v0.25.0#path=video", status: { kind: "update-available", latestVersion: "0.2.0" } }),
    ];

    expect(filterInstalledPlugins(rows, "browser").map((p) => p.name)).toEqual(["agent-browser"]);
    expect(filterInstalledPlugins(rows, "path=video").map((p) => p.name)).toEqual(["video"]);
    expect(filterInstalledPlugins(rows, "codex").map((p) => p.name)).toEqual(["agent-browser"]);
    expect(filterInstalledPlugins(rows, "update-available").map((p) => p.name)).toEqual(["video"]);
    expect(filterInstalledPlugins(rows, "edited").map((p) => p.name)).toEqual(["local-tool"]);
  });

  it("Phase C — filters by MCP server name and applied / not-applied text", () => {
    const rows = [
      plugin("mcp-pl", { mcpServers: [{ name: "db-tools", applied: false }, { name: "remote-api", applied: true }] }),
      plugin("sdd"),
    ];
    expect(filterInstalledPlugins(rows, "db-tools").map((p) => p.name)).toEqual(["mcp-pl"]);
    expect(filterInstalledPlugins(rows, "not applied").map((p) => p.name)).toEqual(["mcp-pl"]);
    expect(filterInstalledPlugins(rows, "sdd").map((p) => p.name)).toEqual(["sdd"]);
  });

  it("sorts without mutating the source list", () => {
    const rows = [plugin("zebra", { version: "0.1.0" }), plugin("alpha", { version: "3.0.0" }), plugin("mango", { version: "1.2.0" })];
    const before = rows.map((p) => p.name);

    expect(sortInstalledPlugins(rows, "name-asc").map((p) => p.name)).toEqual(["alpha", "mango", "zebra"]);
    expect(sortInstalledPlugins(rows, "name-desc").map((p) => p.name)).toEqual(["zebra", "mango", "alpha"]);
    expect(sortInstalledPlugins(rows, "version").map((p) => p.name)).toEqual(["alpha", "mango", "zebra"]);
    expect(rows.map((p) => p.name)).toEqual(before);
  });

  it("status sort puts actionable states first, then name", () => {
    const rows = [
      plugin("plain", { status: { kind: "up-to-date" } }),
      plugin("beta", { status: { kind: "update-available", latestVersion: "2.0.0" } }),
      plugin("alpha", { status: { kind: "update-available", latestVersion: "2.0.0" } }),
      plugin("broken", { status: { kind: "error", detail: "remote unreachable" } }),
      plugin("unknown", { status: { kind: "unknown" } }),
    ];

    expect(sortInstalledPlugins(rows, "status").map((p) => p.name)).toEqual(["alpha", "beta", "broken", "unknown", "plain"]);
  });

  it("combines filtering and sorting", () => {
    const rows = [
      plugin("sdd", { version: "1.4.0" }),
      plugin("secrets-guard", { version: "2.0.1" }),
      plugin("agent-browser", { version: "2.1.1" }),
    ];
    const mode: InstalledSortMode = "name-desc";
    expect(filterAndSortInstalledPlugins(rows, "s", mode).map((p) => p.name)).toEqual(["secrets-guard", "sdd", "agent-browser"]);
  });
});
