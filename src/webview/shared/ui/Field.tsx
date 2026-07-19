import type { JSX } from "preact";
import { forwardRef } from "preact/compat";
import { cx } from "./cx";

/** spec 282 — thin token wrappers for the remaining `.ds-*` primitives (preserve all native attributes/focus). */

export const Input = forwardRef<HTMLInputElement, { class?: string } & Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "class">>(
  ({ class: cls, ...rest }, ref) => <input ref={ref} class={cx("ds-input", cls)} {...rest} />,
);

export function Textarea({ class: cls, ...rest }: { class?: string } & Omit<JSX.HTMLAttributes<HTMLTextAreaElement>, "class">) {
  return <textarea class={cx("ds-input", cls)} {...rest} />;
}

/** spec 339 round-1 (#1) — a `<select>` styled with the same `.ds-input` box as Input/Textarea. */
export const Select = forwardRef<
  HTMLSelectElement,
  { class?: string; value?: string | number; children?: import("preact").ComponentChildren } & Omit<
    JSX.HTMLAttributes<HTMLSelectElement>,
    "class" | "value"
  >
>(({ class: cls, children, value, ...rest }, ref) => (
  <select ref={ref} class={cx("ds-input", cls)} value={value} {...rest}>
    {children}
  </select>
));

/** spec 339 round-1 (#2) — one shared row rhythm for a horizontal group of form fields. */
export function FieldRow({
  class: cls,
  children,
  ...rest
}: { class?: string; children?: import("preact").ComponentChildren } & Omit<JSX.HTMLAttributes<HTMLDivElement>, "class">) {
  return (
    <div class={cx("ds-field-row", cls)} {...rest}>
      {children}
    </div>
  );
}

export type BadgeTone = "default" | "ok" | "warn" | "err" | "info";

export function Badge({
  tone = "default",
  class: cls,
  children,
  ...rest
}: { tone?: BadgeTone; class?: string; children?: import("preact").ComponentChildren } & Omit<
  JSX.HTMLAttributes<HTMLSpanElement>,
  "class"
>) {
  return (
    <span class={cx("ds-badge", tone !== "default" && tone, cls)} {...rest}>
      {children}
    </span>
  );
}
