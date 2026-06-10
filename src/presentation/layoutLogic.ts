import type { GridShape, LayoutDef } from "../config/loadConfig.js";

/**
 * Pure layout math behind split panels (F22) — everything testable lives here;
 * Layouts.ts is a thin driver of vscode.setEditorLayout over this model.
 *
 * The shape mirrors VSCode's EditorGroupLayout (confirmed against the source:
 * `size` is PROPORTIONAL — sizes at one level must sum to 1 — and `groups`
 * nests recursively, each level orthogonal to its parent's orientation).
 */

export interface LayoutNode {
  size?: number;
  groups?: LayoutNode[];
}

export interface EditorLayout {
  /** 0 = groups side-by-side (columns), 1 = stacked (rows) */
  orientation: 0 | 1;
  groups: LayoutNode[];
}

/** Preset vocabulary. main-* carry default proportions; plain grids split equally. */
export const PRESETS: Record<GridShape, EditorLayout> = {
  "2up": { orientation: 0, groups: [{}, {}] },
  "3up": { orientation: 0, groups: [{}, {}, {}] },
  "2x2": { orientation: 0, groups: [{ groups: [{}, {}] }, { groups: [{}, {}] }] },
  "rows-2": { orientation: 1, groups: [{}, {}] },
  "rows-3": { orientation: 1, groups: [{}, {}, {}] },
  "main-left": { orientation: 0, groups: [{ size: 0.65 }, { size: 0.35, groups: [{}, {}] }] },
  "main-right": { orientation: 0, groups: [{ size: 0.35, groups: [{}, {}] }, { size: 0.65 }] },
};

/** How many editor groups (leaves) a layout produces = how many agents it can seat. */
export function leafCount(nodes: LayoutNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n += node.groups && node.groups.length > 0 ? leafCount(node.groups) : 1;
  }
  return n;
}

/** The EditorGroupLayout for a layout definition: custom capture wins, else preset (+sizes). */
export function buildLayout(def: LayoutDef): EditorLayout {
  if (def.layout) return def.layout as EditorLayout;
  const preset = PRESETS[def.grid ?? "2up"];
  const layout: EditorLayout = JSON.parse(JSON.stringify(preset));
  if (def.sizes) {
    layout.groups = layout.groups.map((g, i) => ({ ...g, size: def.sizes![i] }));
  }
  return layout;
}

/**
 * Normalizes a tree coming from vscode.getEditorLayout: sizes arrive in pixels —
 * setEditorLayout wants proportions summing to 1 per level. Rounded to 2 decimals
 * (re-normalized after rounding) so saved ymls stay human-readable.
 */
export function normalizeLayout(raw: { orientation: number; groups: unknown[] }): EditorLayout {
  return {
    orientation: raw.orientation === 1 ? 1 : 0,
    groups: normalizeNodes(raw.groups as Array<{ size?: number; groups?: unknown[] }>),
  };
}

function normalizeNodes(nodes: Array<{ size?: number; groups?: unknown[] }>): LayoutNode[] {
  const sizes = nodes.map((n) => (typeof n.size === "number" && n.size > 0 ? n.size : undefined));
  const total = sizes.every((s) => s !== undefined) ? (sizes as number[]).reduce((a, b) => a + b, 0) : undefined;
  const rounded = total !== undefined ? sizes.map((s) => Math.round(((s as number) / total) * 100) / 100) : [];
  if (total !== undefined) {
    // rounding drift goes to the last group so the level still sums to exactly 1
    const drift = Math.round((1 - rounded.reduce((a, b) => a + b, 0)) * 100) / 100;
    rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1] + drift) * 100) / 100;
  }
  return nodes.map((node, i) => {
    const out: LayoutNode = {};
    if (total !== undefined) out.size = rounded[i];
    if (Array.isArray(node.groups) && node.groups.length > 0) {
      out.groups = normalizeNodes(node.groups as Array<{ size?: number; groups?: unknown[] }>);
    }
    return out;
  });
}

/** Structural equality with size tolerance — lets apply skip a no-op setEditorLayout. */
export function layoutsEqual(a: EditorLayout, b: EditorLayout, tolerance = 0.05): boolean {
  return a.orientation === b.orientation && nodesEqual(a.groups, b.groups, tolerance);
}

function nodesEqual(a: LayoutNode[], b: LayoutNode[], tol: number): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const sa = a[i].size;
    const sb = b[i].size;
    if (sa !== undefined && sb !== undefined && Math.abs(sa - sb) > tol) return false;
    const ga = a[i].groups ?? [];
    const gb = b[i].groups ?? [];
    if ((ga.length > 0) !== (gb.length > 0)) return false;
    if (ga.length > 0 && !nodesEqual(ga, gb, tol)) return false;
  }
  return true;
}

/** Validates a custom layout tree (yml or capture path). Returns errors, [] = ok. */
export function validateLayoutTree(layout: EditorLayout, where: string): string[] {
  const errors: string[] = [];
  if (layout.orientation !== 0 && layout.orientation !== 1) {
    errors.push(`${where}.orientation: must be 0 (columns) or 1 (rows)`);
  }
  const walk = (nodes: LayoutNode[], path: string): void => {
    if (!Array.isArray(nodes) || nodes.length === 0) {
      errors.push(`${path}: must be a non-empty list of groups`);
      return;
    }
    const withSize = nodes.filter((n) => n.size !== undefined);
    if (withSize.length > 0) {
      if (withSize.length !== nodes.length) {
        errors.push(`${path}: either all sibling groups carry 'size' or none do`);
      } else {
        const sum = nodes.reduce((a, n) => a + (n.size ?? 0), 0);
        if (Math.abs(sum - 1) > 0.01) errors.push(`${path}: sizes must sum to 1 (got ${sum.toFixed(2)})`);
        if (nodes.some((n) => (n.size ?? 0) <= 0.04)) errors.push(`${path}: each size must be > 0.04`);
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].groups !== undefined) walk(nodes[i].groups as LayoutNode[], `${path}[${i}].groups`);
    }
  };
  walk(layout.groups, `${where}.groups`);
  return errors;
}

/**
 * Builds the yml layout entry from a live capture: the normalized tree plus the
 * agents found in the editor groups, in leaf (visual) order. Groups holding no
 * Tachyon terminal stay as empty seats — files keep their pane on re-apply.
 */
export function captureToEntry(
  raw: { orientation: number; groups: unknown[] },
  agentsByGroupIndex: Array<string | undefined>,
): { layout: EditorLayout; agents: string[] } | { error: "no-agents" } {
  const agents = agentsByGroupIndex.filter((a): a is string => a !== undefined);
  if (agents.length === 0) return { error: "no-agents" };
  return { layout: normalizeLayout(raw), agents };
}
