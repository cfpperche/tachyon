import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

export function workspaceRoots(): string[] {
  const rootManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    workspaces?: string[] | { packages?: string[] };
  };
  const patterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages ?? [];
  return patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [path.join(repoRoot, pattern)];
    const parent = path.join(repoRoot, pattern.slice(0, -2));
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parent, entry.name));
  }).filter((candidate) => fs.existsSync(path.join(candidate, "package.json")));
}

export function productSourceRoots(): string[] {
  return [path.join(repoRoot, "src"), ...workspaceRoots().map((root) => path.join(root, "src"))]
    .filter((root) => fs.existsSync(root));
}

export function workspaceRoot(packageName: string): string {
  const candidates = workspaceRoots();
  for (const candidate of candidates) {
    const manifest = path.join(candidate, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string };
    if (parsed.name === packageName) return candidate;
  }
  throw new Error(`root package.json workspaces do not map ${packageName}`);
}

export function nonEmpty<T>(items: T[], label: string): T[] {
  if (items.length === 0) throw new Error(`${label} examined zero files`);
  return items;
}
