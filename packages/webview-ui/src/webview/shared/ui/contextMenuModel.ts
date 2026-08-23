/**
 * The parts of a context menu that are decisions rather than DOM.
 *
 * Kept out of the JSX module for the reason this repository has settled on twice already
 * (`studioFolders.ts`, `pathPickerModel.ts`): a unit test cannot import a `.tsx` under the gate's
 * typecheck config, and what is worth testing here is the arithmetic and the keyboard grammar, not
 * the markup.
 *
 * ## Where the grammar comes from
 *
 * The WAI-ARIA menu pattern, and it is a CLOSED list: Up/Down move and wrap, Home/End jump to the
 * ends, a printable character jumps to the next item starting with it, Escape closes and returns
 * focus to whatever opened the menu. Everything else falls through to the page — a menu that
 * swallows keys it does not implement is a trap for anyone driving by keyboard.
 */

export interface ContextMenuItem {
  id: string;
  label: string;
  /** codicon name (no `codicon-` prefix). */
  icon: string;
  /** A separator is drawn before this item. Separators are never focusable. */
  separatorBefore?: boolean;
  /** Destructive items are painted apart and, by convention here, sit last. */
  destructive?: boolean;
  /** Listed but not selectable; `reason` is what the human reads instead of guessing. */
  disabled?: boolean;
  disabledReason?: string;
}

/** Where a menu was asked for, in viewport coordinates. */
export interface ContextMenuAnchor {
  x: number;
  y: number;
}

/** The indices a keyboard can land on — a disabled item is listed but never focused. */
export function focusableIndices(items: readonly ContextMenuItem[]): number[] {
  return items.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index >= 0);
}

/**
 * The next index for a key press, or `undefined` when the key is not ours.
 *
 * `undefined` is the important half: it is how the component knows to leave the event alone instead
 * of preventing a default it never handled.
 */
export function nextIndexForKey(
  key: string,
  current: number,
  items: readonly ContextMenuItem[],
): number | undefined {
  const focusable = focusableIndices(items);
  if (focusable.length === 0) return undefined;
  const position = focusable.indexOf(current);
  if (key === "ArrowDown") return focusable[(position + 1) % focusable.length];
  if (key === "ArrowUp") return focusable[(position - 1 + focusable.length) % focusable.length];
  if (key === "Home") return focusable[0];
  if (key === "End") return focusable[focusable.length - 1];
  // Type-ahead: a single printable character jumps to the NEXT match after the cursor, wrapping —
  // so pressing the same letter twice cycles between two items that share it.
  if (key.length === 1 && key.trim().length === 1) {
    const needle = key.toLowerCase();
    for (let step = 1; step <= focusable.length; step += 1) {
      const candidate = focusable[(position + step) % focusable.length]!;
      if (items[candidate]!.label.toLowerCase().startsWith(needle)) return candidate;
    }
  }
  return undefined;
}

export interface ViewportBox {
  width: number;
  height: number;
}

export interface MenuBox {
  width: number;
  height: number;
}

/**
 * Where the panel actually goes.
 *
 * A menu opens down-and-right of the pointer, and FLIPS rather than slides when that would leave the
 * viewport: sliding keeps the menu on screen but detaches it from the thing it belongs to, and the
 * references are unanimous that a contextual menu has to read as attached to its object. A margin is
 * kept on every side so the panel never touches an edge.
 */
export function placeMenu(anchor: ContextMenuAnchor, menu: MenuBox, viewport: ViewportBox, margin = 6): { left: number; top: number } {
  const flipsLeft = anchor.x + menu.width + margin > viewport.width;
  const flipsUp = anchor.y + menu.height + margin > viewport.height;
  const left = flipsLeft ? anchor.x - menu.width : anchor.x;
  const top = flipsUp ? anchor.y - menu.height : anchor.y;
  return {
    left: Math.max(margin, Math.min(left, Math.max(margin, viewport.width - menu.width - margin))),
    top: Math.max(margin, Math.min(top, Math.max(margin, viewport.height - menu.height - margin))),
  };
}
