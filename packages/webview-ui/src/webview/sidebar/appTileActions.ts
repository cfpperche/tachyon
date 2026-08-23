/**
 * What a launcher tile offers on right-click — as DATA, for both kinds of tile.
 *
 * The point of this file is that adding "New Agent" to the Fleet tile later is a line in a table, not
 * a branch in a component. Two kinds of tile feed it and they stay symmetric:
 *
 *  - a **built-in** screen declares its actions here, beside the launcher metadata that already says
 *    what a tile IS (`sectionNav.ts`);
 *  - an **installed app** declares its own in `app.json`, and they arrive on the same message as the
 *    catalog. Its action means "open my page and tell it which action was chosen".
 *
 * `Uninstall` is contributed by neither: it is added here, and ONLY for an installed app. Making it
 * structural rather than a check spread across call sites is what guarantees a core tile can never
 * offer it — the id prefix is the whole rule, and the prefix exists by construction.
 *
 * Pure (no preact, no vscode) for the same reason as `studioFolders.ts`: this is the part worth
 * testing, and a unit test cannot import the `.tsx` that renders it.
 */
import type { ContextMenuItem } from "../shared/ui/contextMenuModel.js";

/** One action a tile offers, in the shape both kinds produce. */
export interface AppTileAction {
  id: string;
  label: string;
  icon: string;
}

/** The tile the menu was opened on, reduced to what the decision needs. */
export interface AppTileTarget {
  /** `app:<id>` for an installed app; a section id for a built-in. */
  id: string;
  label: string;
  /** Actions the installed app declared in `app.json` (built-ins pass none). */
  declared?: readonly AppTileAction[];
}

/**
 * Actions the built-in screens offer, keyed by section id.
 *
 * Empty for most, on purpose: the useful ones will show up through use, and a menu padded with
 * plausible-sounding entries is worse than a short one (NN/g). `mission` — the Board — starts with
 * the one that already exists behind a door of its own.
 */
export const BUILT_IN_TILE_ACTIONS: Readonly<Record<string, readonly AppTileAction[]>> = {
  mission: [{ id: "new-task", label: "New Task", icon: "add" }],
};

/** True for a tile that came from `.tachyon/apps`, which is the only kind that can be uninstalled. */
export function isInstalledApp(tileId: string): boolean {
  return tileId.startsWith("app:");
}

/**
 * The menu for one tile.
 *
 * `Open` is first and is also what a plain click does — deliberately duplicated, because the
 * references are firm that a context menu must not be the only route to a frequent action, and just
 * as firm that the menu should still name the default so the list reads complete.
 *
 * A destructive item is separated and last, which is the one placement rule everybody agrees on.
 */
export function appTileMenuItems(target: AppTileTarget): ContextMenuItem[] {
  const specific = isInstalledApp(target.id)
    ? (target.declared ?? [])
    : (BUILT_IN_TILE_ACTIONS[target.id] ?? []);
  const items: ContextMenuItem[] = [
    { id: "open", label: "Open", icon: "arrow-right" },
    ...specific.map((action) => ({ id: action.id, label: action.label, icon: action.icon })),
  ];
  if (isInstalledApp(target.id)) {
    items.push({ id: "uninstall", label: "Uninstall", icon: "trash", separatorBefore: true, destructive: true });
  }
  return items;
}
