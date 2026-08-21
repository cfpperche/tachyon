import path from "node:path";

/** Resolve a relative path beneath root, or return undefined when it escapes. */
export function contained(root: string, relative: string): string | undefined {
  if (!relative || path.isAbsolute(relative)) return undefined;
  const target = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  return target.startsWith(prefix) ? target : undefined;
}
