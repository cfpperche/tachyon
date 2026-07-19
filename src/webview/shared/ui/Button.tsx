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
function flattenChildren(children: ComponentChildren, out: unknown[]): void {
  if (children == null || children === false || children === true || children === "") return;
  if (Array.isArray(children)) {
    for (const child of children) flattenChildren(child, out);
    return;
  }
  out.push(children);
}

function isTextRun(node: unknown): node is string | number {
  return typeof node === "string" || typeof node === "number";
}

// t-240a3b — the icon-only CSS rule (`:has(> :not(.codicon))`) only sees ELEMENT children, so a bare
// text-node label must be wrapped in an element or the button wrongly collapses to the icon-only 28px box
// (see design-system.css's icon-only rule). Wrapping *all* children together, though, nests any literal
// element child (e.g. a raw `<Icon/>` passed alongside text instead of via the `icon` prop) one level
// inside `.ds-btn-label`, which has no gap rule — losing the `.ds-btn` 6px icon<->text gap. So flatten
// children and glue only each CONTIGUOUS run of text/number nodes into one label span; element/component
// vnodes stay direct siblings of `.ds-btn`, exactly like a flex layout's own anonymous-box grouping.
function wrapLabelRuns(children: ComponentChildren): ComponentChildren[] {
  const flat: unknown[] = [];
  flattenChildren(children, flat);
  const result: ComponentChildren[] = [];
  let run: (string | number)[] = [];
  const flushRun = () => {
    if (run.length > 0) {
      result.push(<span class="ds-btn-label">{run}</span>);
      run = [];
    }
  };
  for (const node of flat) {
    if (isTextRun(node)) {
      run.push(node);
    } else {
      flushRun();
      result.push(node as ComponentChildren);
    }
  }
  flushRun();
  return result;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ variant = "default", icon, children, class: cls, ...rest }, ref) => (
  <button ref={ref} type="button" class={cx(VARIANT_CLASS[variant], cls)} {...rest}>
    {icon && <Icon name={icon} />}
    {wrapLabelRuns(children)}
  </button>
));
