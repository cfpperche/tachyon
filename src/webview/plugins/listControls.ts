import type { InstalledPluginVM, PluginStatusKind } from "../../plugins/viewModel";

export type InstalledSortMode = "name-asc" | "name-desc" | "status" | "version";

const STATUS_RANK: Record<PluginStatusKind, number> = {
  "update-available": 0,
  "source-changed": 1,
  drift: 2,
  conflict: 3,
  error: 4,
  unknown: 5,
  "up-to-date": 6,
};

function textFor(p: InstalledPluginVM): string {
  return [
    p.name,
    p.version,
    p.sourceSpec ?? "local",
    p.shortCommit ?? "",
    p.status.kind,
    p.status.latestVersion ?? "",
    p.status.detail ?? "",
    ...p.runtimes.map((r) => `${r.runtime} ${r.present ? "present installed" : "missing drift"}`),
  ].join(" ").toLowerCase();
}

function versionParts(v: string): [number, number, number, string] {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/i.exec(v.trim());
  if (!m) return [-1, -1, -1, v];
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), m[4] ?? ""];
}

function compareVersionDesc(a: InstalledPluginVM, b: InstalledPluginVM): number {
  const av = versionParts(a.version);
  const bv = versionParts(b.version);
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return (bv[i] as number) - (av[i] as number);
  }
  return a.name.localeCompare(b.name);
}

function compareByName(a: InstalledPluginVM, b: InstalledPluginVM): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

export function filterInstalledPlugins(plugins: readonly InstalledPluginVM[], query: string): InstalledPluginVM[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...plugins];
  return plugins.filter((p) => textFor(p).includes(q));
}

export function sortInstalledPlugins(plugins: readonly InstalledPluginVM[], mode: InstalledSortMode): InstalledPluginVM[] {
  const out = [...plugins];
  switch (mode) {
    case "name-desc":
      return out.sort((a, b) => compareByName(b, a));
    case "status":
      return out.sort((a, b) => STATUS_RANK[a.status.kind] - STATUS_RANK[b.status.kind] || compareByName(a, b));
    case "version":
      return out.sort(compareVersionDesc);
    case "name-asc":
      return out.sort(compareByName);
  }
}

export function filterAndSortInstalledPlugins(plugins: readonly InstalledPluginVM[], query: string, mode: InstalledSortMode): InstalledPluginVM[] {
  return sortInstalledPlugins(filterInstalledPlugins(plugins, query), mode);
}
