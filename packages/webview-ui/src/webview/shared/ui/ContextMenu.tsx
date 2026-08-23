/**
 * The product's context menu, measured against the benchmark patterns rather than assembled by feel.
 *
 * The Board's card menu (t-c0e711) got the shape right and is where this starts from: a transparent
 * backdrop that closes on click-outside, a fixed panel in the `.more-menu` language, Escape and arrow
 * keys on a document listener, dismissal on webview blur and on visibility loss (an editor click
 * never reaches the backdrop, because it is outside the iframe).
 *
 * What the references add on top of it, and why each one is here:
 *
 *  - **Shift+F10 and the ContextMenu key open it.** Without them the menu is mouse-only, which makes
 *    every action inside it unreachable by keyboard. This is the single biggest gap the card menu has.
 *  - **Escape returns focus to whatever opened the menu.** The WAI-ARIA pattern is explicit; a menu
 *    that closes and drops focus to the document leaves a keyboard user where they did not start.
 *  - **Home/End and first-letter type-ahead**, which are the rest of the menu grammar.
 *  - **Separators and destructive styling.** NN/g's rule for a destructive item is that it must not
 *    sit flush with the ordinary ones; here it is separated and last, and it says what it will do.
 *  - **Disabled items are listed, not hidden**, with the reason attached — a missing row is
 *    indistinguishable from an action that does not exist.
 *  - **Placement flips instead of sliding.** A menu that slides to stay on screen stops reading as
 *    attached to the object it belongs to, which is the one thing a contextual menu must do.
 *
 * What it deliberately does NOT do: replace the Board's menu today. Two surfaces adopting a shared
 * component in one change is how a regression hides in the one nobody was looking at; the Board moves
 * when someone is measuring the Board.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon";
import {
  focusableIndices,
  nextIndexForKey,
  placeMenu,
  type ContextMenuAnchor,
  type ContextMenuItem,
} from "./contextMenuModel";

export interface ContextMenuProps {
  /** Absent = closed. */
  anchor?: ContextMenuAnchor;
  items: readonly ContextMenuItem[];
  label: string;
  onRun: (id: string) => void;
  onClose: () => void;
  /** Focused again when the menu closes — the element the human opened it from. */
  returnFocusTo?: HTMLElement | null;
  "data-testid"?: string;
}

export function ContextMenu({ anchor, items, label, onRun, onClose, returnFocusTo, "data-testid": testId }: ContextMenuProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | undefined>(undefined);
  const open = anchor !== undefined && items.length > 0;

  // Measure THEN place: the panel's height depends on how many items it has and on the theme's
  // metrics, so a computed guess would be wrong on exactly the screens where placement matters.
  useLayoutEffect(() => {
    if (!open || !anchor) { setPlacement(undefined); return; }
    const panel = panelRef.current;
    if (!panel) return;
    const box = panel.getBoundingClientRect();
    setPlacement(placeMenu(anchor, { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [open, anchor?.x, anchor?.y, items.length]);

  useEffect(() => {
    if (!open) return;
    const buttons = (): HTMLButtonElement[] => Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-index]") ?? []);
    const indexOfFocused = (): number => {
      const found = buttons().findIndex((button) => button === document.activeElement);
      return found >= 0 ? Number(buttons()[found]!.dataset.menuIndex) : -1;
    };
    const focusIndex = (index: number): void => {
      buttons().find((button) => Number(button.dataset.menuIndex) === index)?.focus();
    };
    const first = focusableIndices(items)[0];
    if (first !== undefined) setTimeout(() => focusIndex(first), 0);

    const close = (): void => {
      onClose();
      // Returning focus is part of the pattern, not a nicety: without it the next Tab starts from the
      // top of the document instead of from the tile the human was on.
      setTimeout(() => returnFocusTo?.focus(), 0);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key === "Tab") { event.preventDefault(); close(); return; }
      const next = nextIndexForKey(event.key, indexOfFocused(), items);
      if (next === undefined) return; // not ours: leave the event alone
      event.preventDefault();
      focusIndex(next);
    };
    const dismiss = (): void => onClose();
    const onVisibility = (): void => { if (document.hidden) onClose(); };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", dismiss);
    // A menu is anchored to a point in the viewport; scrolling or resizing moves the object out from
    // under it, so it closes rather than pointing at the wrong thing.
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [open, items, onClose, returnFocusTo]);

  if (!open) return null;

  return (
    <div
      class="menu-backdrop"
      data-testid={testId}
      onClick={onClose}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
    >
      <div
        ref={panelRef}
        class="more-menu ctx-menu"
        role="menu"
        aria-label={label}
        // Hidden until measured, so the first paint is never at the wrong place.
        style={placement ? `left:${placement.left}px;top:${placement.top}px` : "opacity:0;pointer-events:none"}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item, index) => (
          <span key={item.id}>
            {item.separatorBefore ? <span class="ctx-sep" role="separator" /> : null}
            <button
              type="button"
              class={`more-item${item.destructive ? " is-destructive" : ""}`}
              role="menuitem"
              data-menu-index={index}
              data-testid={`ctx-item-${item.id}`}
              aria-disabled={item.disabled ? "true" : undefined}
              title={item.disabled ? item.disabledReason : undefined}
              tabIndex={-1}
              onClick={() => { if (!item.disabled) onRun(item.id); }}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
