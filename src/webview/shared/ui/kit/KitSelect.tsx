import { cx } from "../cx";
import {
  Select as RadixSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../vendor/select";
import { KIT_FLAGS } from "./flags";

export interface KitSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface KitSelectProps {
  id?: string;
  value?: string;
  onValueChange: (value: string) => void;
  options: KitSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  "data-testid"?: string;
  class?: string;
}

// spec 342 T4 — the common-denominator Select API: ONE prop contract, TWO internals selectable at build
// time via KIT_FLAGS.select (shared/ui/kit/flags.ts) — no call-site change either way. "radix" (default)
// is the gate-passed vendored Select; "legacy" is a plain native `<select class="ds-input">` — the SAME
// class shared/ui/Field.tsx's days-old `Select` applies (identical styling), rendered directly here rather
// than through that component, whose prop type is scoped to the generic `HTMLAttributes` and doesn't carry
// `disabled`/other element-specific attrs this wrapper needs to pass through.
export function KitSelect({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  "data-testid": testId,
  class: cls,
}: KitSelectProps) {
  if (KIT_FLAGS.select === "legacy") {
    return (
      <select
        id={id}
        class={cx("ds-input", cls)}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid || undefined}
        data-testid={testId}
        onChange={(e) => onValueChange((e.currentTarget as HTMLSelectElement).value)}
      >
        {placeholder && (
          <option value="" disabled hidden>
            {placeholder}
          </option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <RadixSelect value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} className={cls} aria-label={ariaLabel} aria-invalid={ariaInvalid} data-testid={testId}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </RadixSelect>
  );
}
