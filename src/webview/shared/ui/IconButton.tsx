import type { JSX } from "preact";
import { forwardRef } from "preact/compat";
import { cx } from "./cx";
import { Icon } from "./Icon";

// dogfood round 1 (#1, CRITICAL) — the ONLY reason this needs `forwardRef`: Radix's `asChild` (KitDropdown's
// production usage, Plugins card actions) clones this element with a composed ref so its Popper anchor can
// measure the REAL DOM node. A plain function component silently drops a `ref` prop (React/preact never pass
// it through to the function — that's what `forwardRef` exists for), so the anchor ref stayed unattached and
// floating-ui positioned the menu content relative to nothing rather than this button — reproduced directly:
// the asChild-composed trigger's content rendered at a fixed, trigger-independent offset instead of beside
// the actual button. See notes.md's dogfood log for the full repro.
/** spec 282 — an icon-only button (square hit area via .ds-btn). `title` doubles as the accessible label. */
export const IconButton = forwardRef<HTMLButtonElement, { name: string; title: string; class?: string } & Omit<JSX.HTMLAttributes<HTMLButtonElement>, "class">>(
  ({ name, title, class: cls, ...rest }, ref) => (
    <button ref={ref} type="button" class={cx("ds-btn", cls)} title={title} aria-label={title} {...rest}>
      <Icon name={name} />
    </button>
  ),
);
