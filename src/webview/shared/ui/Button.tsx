import type { ComponentChildren, JSX } from "preact";
import { forwardRef } from "preact/compat";
import { cx } from "./cx";
import { Icon } from "./Icon";

export type ButtonVariant = "default" | "primary" | "danger";

/** spec 282 — the ONE button authoring API. Subsumes ds-btn / ds-btn-primary / "ds-btn primary" / ds-btn danger. */
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "ds-btn",
  primary: "ds-btn ds-btn-primary",
  danger: "ds-btn ds-btn-danger",
};

export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class" | "icon" | "type"> {
  variant?: ButtonVariant;
  /** an optional leading codicon name (the icon↔label gap is the canonical CSS rule). */
  icon?: string;
  children?: ComponentChildren;
  class?: string;
}

// dogfood round 1 (#1, CRITICAL) — `forwardRef` for the same reason as IconButton: a plain function component
// silently drops any `ref` a Radix `asChild` composition (e.g. `KitDropdownTrigger asChild`) tries to attach,
// breaking the Popper anchor measurement. Button isn't `asChild`-composed anywhere today, but it's this
// project's ONE general button component (per its own header comment) — leaving it un-forwarded would just
// reproduce the exact same silent breakage the next time someone reaches for it under a Kit trigger.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ variant = "default", icon, children, class: cls, ...rest }, ref) => (
  <button ref={ref} type="button" class={cx(VARIANT_CLASS[variant], cls)} {...rest}>
    {icon && <Icon name={icon} />}
    {children}
  </button>
));
