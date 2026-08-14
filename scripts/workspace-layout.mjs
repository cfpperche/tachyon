import fs from "node:fs";
import path from "node:path";

function workspacePatterns(manifest) {
  return Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces?.packages ?? [];
}

export function workspaceDirectories(repositoryRoot) {
  const rootManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  const directories = [];
  for (const pattern of workspacePatterns(rootManifest)) {
    if (!pattern.endsWith("/*")) {
      directories.push(path.resolve(repositoryRoot, pattern));
      continue;
    }
    const parent = path.resolve(repositoryRoot, pattern.slice(0, -2));
    if (!fs.existsSync(parent)) continue;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(path.join(parent, entry.name));
    }
  }
  return directories.sort();
}

export function workspaceManifests(repositoryRoot) {
  return workspaceDirectories(repositoryRoot).map((directory) => ({
    directory,
    manifest: JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")),
  }));
}

export function extensionWorkspace(repositoryRoot) {
  const workspaces = workspaceManifests(repositoryRoot);
  const matches = workspaces
    .filter(({ manifest }) => typeof manifest.engines?.vscode === "string");
  // Small unit fixtures and legacy standalone consumers intentionally have no workspace children.
  // The repository itself has workspaces, so its orchestrator can never take this compatibility arm.
  if (matches.length === 0 && workspaces.length === 0) {
    return {
      directory: repositoryRoot,
      manifest: JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")),
    };
  }
  if (matches.length !== 1) {
    throw new Error(`expected exactly one VS Code extension workspace, found ${matches.length}`);
  }
  return matches[0];
}

export function productSourceRoots(repositoryRoot) {
  const roots = [path.join(repositoryRoot, "src")];
  for (const { directory } of workspaceManifests(repositoryRoot)) {
    const source = path.join(directory, "src");
    if (fs.existsSync(source)) roots.push(source);
  }
  return roots;
}
