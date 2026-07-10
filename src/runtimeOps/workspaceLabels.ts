import path from "node:path";
import { createHash } from "node:crypto";

export interface RuntimeOpsWorkspaceInput {
  key: string;
  name: string;
  root: string;
}

interface ParentPath {
  rootIdentity?: string;
  segments: string[];
}

const MAX_DISCLOSED_PARENT_SEGMENTS = 2;

/**
 * Disambiguate duplicate workspace names without reconstructing full roots.
 * Labels show at most two non-root parent segments; collisions use an opaque key token.
 */
export function buildWorkspaceLabels(workspaces: RuntimeOpsWorkspaceInput[]): Map<string, string> {
  const labels = new Map<string, string>();
  const groups = new Map<string, RuntimeOpsWorkspaceInput[]>();
  for (const workspace of workspaces) {
    const group = groups.get(workspace.name) ?? [];
    group.push(workspace);
    groups.set(workspace.name, group);
  }
  for (const [name, group] of groups) {
    if (group.length === 1) {
      labels.set(group[0].key, name);
      continue;
    }
    const parents = group.map((workspace) => parentSegments(workspace.root));
    for (let index = 0; index < group.length; index += 1) {
      const suffix = boundedParentSuffix(parents[index]);
      const collides = parents.some((other, otherIndex) => otherIndex !== index && boundedParentSuffix(other) === suffix);
      const discriminator = collides ? opaqueWorkspaceId(group[index].key) : undefined;
      const disambiguator = [suffix, discriminator ? `[${discriminator}]` : undefined].filter(Boolean).join(" ");
      labels.set(group[index].key, `${name} (${disambiguator || opaqueWorkspaceId(group[index].key)})`);
    }
  }
  return labels;
}

function parentSegments(root: string): ParentPath {
  const namespace = isWindowsPath(root) ? path.win32 : path.posix;
  const normalized = namespace === path.win32 ? namespace.normalize(root) : namespace.resolve(root);
  const parent = namespace.dirname(normalized);
  const parsed = namespace.parse(parent);
  const segments = parent.slice(parsed.root.length).split(namespace.sep).filter(Boolean);

  // A drive is safe to show and distinguishes otherwise identical paths across volumes.
  // A UNC server/share is sensitive, so use only an opaque stable token for that identity.
  if (namespace === path.win32 && parsed.root.length > 1) {
    const volume = parsed.root.replaceAll("\\", "/").replace(/\/+$/, "");
    const token = isUncRoot(parsed.root) ? `unc-${opaqueToken(volume.toLowerCase())}` : volume;
    return { rootIdentity: token, segments };
  }
  return { segments };
}

function boundedParentSuffix(parent: ParentPath): string {
  return [parent.rootIdentity, ...parent.segments.slice(-MAX_DISCLOSED_PARENT_SEGMENTS)].filter(Boolean).join("/");
}

function isWindowsPath(root: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\") || /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(root) || root.includes("\\");
}

function isUncRoot(root: string): boolean {
  return root.startsWith("\\\\") || root.startsWith("//");
}

function opaqueToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function opaqueWorkspaceId(key: string): string {
  return `id-${opaqueToken(key)}`;
}
