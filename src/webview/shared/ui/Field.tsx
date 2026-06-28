import type { JSX } from "preact";
import { cx } from "./cx";

/** spec 282 — thin token wrappers for the remaining `.ds-*` primitives (preserve all native attributes/focus). */

export function Input({ class: cls, ...rest }: { class?: string } & Omit<JSX.HTMLAttributes<HTMLInputElement>, "class">) {
  return <input class={cx("ds-input", cls)} {...rest} />;
}

export function Textarea({ class: cls, ...rest }: { class?: string } & Omit<JSX.HTMLAttributes<HTMLTextAreaElement>, "class">) {
  return <textarea class={cx("ds-input", cls)} {...rest} />;
}

export type BadgeTone = "default" | "ok" | "warn" | "err" | "info";

export function Badge({ tone = "default", class: cls, children, ...rest }: { tone?: BadgeTone; class?: string; children?: import("preact").ComponentChildren } & Omit<JSX.HTMLAttributes<HTMLSpanElement>, "class">) {
  return <span class={cx("ds-badge", tone !== "default" && tone, cls)} {...rest}>{children}</span>;
}
