/**
 * t-f3ded3 — product ConfirmForm: in-webview form dialog for an editable field + multi-line
 * preview + meta lines + Confirm/Cancel. Not a QuickPicker (filterable list); not a second picker
 * bent to hold free text. Preact + design-system tokens; Escape / scrim cancel.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "./Button";
import { Input } from "./Field";
import { cx } from "./cx";

export interface ConfirmFormProps {
  open: boolean;
  title: string;
  /** Optional honesty / context line under the title. */
  subtitle?: string;
  fieldLabel: string;
  /** Seed when the dialog opens; the form owns the live value until confirm/cancel. */
  fieldValue: string;
  fieldPlaceholder?: string;
  /** Label above the multi-line preview. */
  previewLabel?: string;
  /** Multi-line body; read-only, scrollable. */
  preview: string;
  /** Fact lines under the preview (base branch, dirty warning, …). */
  meta?: string[];
  confirmLabel: string;
  cancelLabel: string;
  /** Receives the trimmed field value at confirm. */
  onConfirm: (value: string) => void;
  onCancel: () => void;
  "data-testid"?: string;
}

export function ConfirmForm({
  open,
  title,
  subtitle,
  fieldLabel,
  fieldValue,
  fieldPlaceholder,
  previewLabel,
  preview,
  meta,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  "data-testid": testId = "confirm-form",
}: ConfirmFormProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(fieldValue);

  // Reseed only when the dialog opens or the host seed identity changes — not on every keystroke.
  useEffect(() => {
    if (!open) return;
    setValue(fieldValue);
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fieldValue is the open-time seed
  }, [open, fieldValue]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && value.trim()) {
        e.preventDefault();
        onConfirm(value.trim());
      }
    };
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  }, [open, onCancel, onConfirm, value]);

  if (!open) return null;

  const disabled = !value.trim();

  return (
    <div
      class="ds-cf open"
      data-testid={testId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        class="ds-cf-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={`${testId}-panel`}
      >
        <div class="ds-cf-head">
          <div class="ds-cf-title">{title}</div>
          {subtitle ? <div class="ds-cf-subtitle">{subtitle}</div> : null}
        </div>
        <div class="ds-cf-body">
          <label class="ds-cf-field" data-testid={`${testId}-field`}>
            <span class="ds-cf-label">{fieldLabel}</span>
            <Input
              ref={inputRef}
              value={value}
              placeholder={fieldPlaceholder}
              aria-label={fieldLabel}
              data-testid={`${testId}-input`}
              onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            />
          </label>
          <div class="ds-cf-preview-wrap" data-testid={`${testId}-preview`}>
            {previewLabel ? <span class="ds-cf-label">{previewLabel}</span> : null}
            <pre class="ds-cf-preview" tabIndex={0}>{preview}</pre>
          </div>
          {meta && meta.length > 0 ? (
            <ul class="ds-cf-meta" data-testid={`${testId}-meta`}>
              {meta.map((line) => (
                <li key={line} class={cx("ds-cf-meta-line", line.startsWith("⚠") && "warn")}>
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div class="ds-cf-foot">
          <Button variant="default" onClick={onCancel} data-testid={`${testId}-cancel`}>
            {cancelLabel}
          </Button>
          <Button
            variant="primary"
            disabled={disabled}
            onClick={() => {
              if (!disabled) onConfirm(value.trim());
            }}
            data-testid={`${testId}-confirm`}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
