import path from "node:path";

export interface RuntimeOpsWorkspaceInput {
  key: string;
  name: string;
  root: string;
}

/** Shortest unique parent suffix for duplicate basenames; full roots never enter the returned map. */
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
      const segments = parents[index];
      let suffix = segments.at(-1) ?? group[index].key;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const unique = parents.every((other, otherIndex) => otherIndex === index || other.slice(-depth).join("/") !== candidate);
        suffix = candidate;
        if (unique) break;
      }
      labels.set(group[index].key, `${name} (${suffix})`);
    }
  }
  return labels;
}

function parentSegments(root: string): string[] {
  const parent = path.dirname(path.resolve(root));
  const parsed = path.parse(parent);
  return parent.slice(parsed.root.length).split(path.sep).filter(Boolean);
}
