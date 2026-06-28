import type { JSX } from "preact";
import { cx } from "./cx";
import { Icon } from "./Icon";

/** spec 282 — an icon-only button (square hit area via .ds-btn). `title` doubles as the accessible label. */
export function IconButton({ name, title, class: cls, ...rest }: { name: string; title: string; class?: string } & Omit<JSX.HTMLAttributes<HTMLButtonElement>, "class">) {
  return (
    <button type="button" class={cx("ds-btn", cls)} title={title} aria-label={title} {...rest}>
      <Icon name={name} />
    </button>
  );
}
