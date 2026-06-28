import type { ComponentChildren, JSX } from "preact";
import { cx } from "./cx";
import { Icon } from "./Icon";

export type ButtonVariant = "default" | "primary" | "danger";

/** spec 282 — the ONE button authoring API. Subsumes ds-btn / ds-btn-primary / "ds-btn primary" / ds-btn danger. */
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "ds-btn",
  primary: "ds-btn ds-btn-primary",
  danger: "ds-btn ds-btn-danger",
};

export interface ButtonProps extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, "class" | "icon" | "type"> {
  variant?: ButtonVariant;
  /** an optional leading codicon name (the icon↔label gap is the canonical CSS rule). */
  icon?: string;
  children?: ComponentChildren;
  class?: string;
}

export function Button({ variant = "default", icon, children, class: cls, ...rest }: ButtonProps) {
  return (
    <button type="button" class={cx(VARIANT_CLASS[variant], cls)} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
