import fs from "node:fs";
import path from "node:path";

/** Converts the configured handoff path into one canonical, workspace-contained wire path. */
export function projectHandoffRelativePath(workspaceRoot: string, canonicalPath: string): string {
  const root = path.resolve(workspaceRoot);
  const actualRoot = fs.realpathSync(root);
  const target = path.resolve(canonicalPath);
  assertContained(root, target, "handoff path");
  assertExistingAncestorContained(actualRoot, target);
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (!isSafeHandoffRelativePath(relative)) throw new Error("handoff path is not a safe workspace-relative file");
  return relative;
}

/** Resolves a daemon-authored relative path and re-proves the actual file after ensure/open. */
export function resolveHandoffFilePath(workspaceRoot: string, relativePath: string): string {
  if (!isSafeHandoffRelativePath(relativePath)) throw new Error("handoff response contains an unsafe relative path");
  const root = path.resolve(workspaceRoot);
  const actualRoot = fs.realpathSync(root);
  const target = path.resolve(root, ...relativePath.split("/"));
  assertContained(root, target, "handoff file");
  const actual = fs.realpathSync(target);
  assertContained(actualRoot, actual, "handoff file");
  if (!fs.statSync(actual).isFile()) throw new Error("handoff path is not a regular file");
  return actual;
}

export function isSafeHandoffRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || value.includes("\\") || value.includes(":") || value.includes("\0")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function assertExistingAncestorContained(root: string, target: string): void {
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("handoff path has no existing workspace ancestor");
    ancestor = parent;
  }
  const actual = fs.realpathSync(ancestor);
  assertContained(root, actual, "handoff path ancestor", true);
}

function assertContained(root: string, candidate: string, label: string, allowRoot = false): void {
  const relative = path.relative(root, candidate);
  if ((!relative && !allowRoot) || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} escapes or aliases the workspace root`);
  }
}
