import type { JSX } from "preact";
import { useId } from "preact/hooks";
import { cx } from "../cx";

export interface KitLabeledInputProps
  extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "class" | "id" | "onInput"> {
  id?: string;
  label: string;
  description?: string;
  error?: string;
  onInput?: (value: string) => void;
  class?: string;
}

// spec 342 T4 — the a11y contract this wrapper exists for: label↔input association via `htmlFor`/`id`,
// description+error both feed `aria-describedby` (space-joined, so a screen reader announces both), and a
// non-empty `error` sets `aria-invalid` automatically — a caller cannot forget it. Renders a plain `<input
// class="ds-input">` directly (the SAME class shared/ui/Field.tsx's `Input` applies, so styling stays
// identical) rather than reusing that component, whose prop type is scoped to the generic
// `HTMLAttributes` and doesn't carry element-specific attrs (disabled/readOnly/type/…) this wrapper needs to
// pass through. No legacy-fallback flag: there is only one implementation, just new wiring around it.
export function KitLabeledInput({
  id,
  label,
  description,
  error,
  onInput,
  class: cls,
  ...rest
}: KitLabeledInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descId = description ? `${inputId}-description` : undefined;
  const errId = error ? `${inputId}-error` : undefined;
  const describedBy = [descId, errId].filter(Boolean).join(" ") || undefined;

  return (
    <div class="kit-labeled-input">
      <label for={inputId} class="ds-section" style={{ display: "block", marginBottom: "var(--ds-1)" }}>
        {label}
      </label>
      <input
        id={inputId}
        class={cx("ds-input", cls)}
        aria-invalid={!!error || undefined}
        aria-describedby={describedBy}
        onInput={(e) => onInput?.((e.currentTarget as HTMLInputElement).value)}
        {...rest}
      />
      {description && (
        <p id={descId} class="ds-small" style={{ color: "var(--ds-muted)", margin: "var(--ds-1) 0 0" }}>
          {description}
        </p>
      )}
      {error && (
        <p id={errId} class="ds-small" style={{ color: "var(--ds-err)", margin: "var(--ds-1) 0 0" }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
