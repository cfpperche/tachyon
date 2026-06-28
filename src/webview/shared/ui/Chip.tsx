import type { ComponentChildren, JSX } from "preact";
import { cx } from "./cx";
import { Icon } from "./Icon";

/** spec 282 — the canonical chip (consolidates the per-panel chip/schip/tag-chip after the alias audit). */
export interface ChipProps extends Omit<JSX.HTMLAttributes<HTMLSpanElement>, "class" | "icon"> {
  active?: boolean;
  disabled?: boolean;
  /** an optional leading codicon name. */
  icon?: string;
  children?: ComponentChildren;
  class?: string;
}

export function Chip({ active, disabled, icon, children, class: cls, ...rest }: ChipProps) {
  return (
    <span class={cx("ds-chip", active && "active", disabled && "disabled", cls)} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}
