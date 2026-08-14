import type { JSX } from "preact";
import { cx } from "./cx";

/**
 * spec 282 — a codicon. Normalizes the codicon NAME (+ aria-hidden by default); the canonical SIZE/baseline/gap is a
 * CSS rule (`.ds-btn .codicon` / `.ds-tab .codicon` / `.ds-chip .codicon` in design-system.css), NOT here — the
 * component is the distribution mechanism, the CSS is the alignment fix.
 */
export function Icon({ name, class: cls, ...rest }: { name: string; class?: string } & Omit<JSX.HTMLAttributes<HTMLSpanElement>, "class">) {
  return <span class={cx("codicon", `codicon-${name}`, cls)} aria-hidden="true" {...rest} />;
}
