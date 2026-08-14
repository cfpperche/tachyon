import type { ComponentChildren } from "preact";
import { useId, useRef, useState } from "preact/hooks";
import { Button } from "../Button";
import { cx } from "../cx";
import { Icon } from "../Icon";

export interface KitFilePickerProps {
  title: string;
  description?: ComponentChildren;
  accept?: string;
  disabled?: boolean;
  error?: string;
  idleLabel?: string;
  draggingLabel?: string;
  busyLabel?: string;
  browseLabel?: string;
  cancelLabel?: string;
  class?: string;
  onFile(file: File): void | Promise<void>;
  onCancel?(): void;
}

/** Tachyon's in-webview file picker: one themed drop target with a browser file-input fallback. */
export function KitFilePicker({
  title,
  description,
  accept,
  disabled = false,
  error,
  idleLabel = "Drop a file here",
  draggingLabel = "Drop to select",
  busyLabel = "Reading file…",
  browseLabel = "or choose from your computer",
  cancelLabel = "Cancel",
  class: cls,
  onFile,
  onCancel,
}: KitFilePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const generatedId = useId();
  const titleId = `${generatedId}-title`;
  const descriptionId = description ? `${generatedId}-description` : undefined;
  const errorId = error ? `${generatedId}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  const select = (file: File | undefined) => {
    if (!file || disabled) return;
    void onFile(file);
  };

  return (
    <section class={cx("kit-file-picker", cls)} aria-labelledby={titleId}>
      <div>
        <div id={titleId} class="kit-file-picker-title">{title}</div>
        {description && <div id={descriptionId} class="kit-file-picker-description">{description}</div>}
      </div>
      <button
        type="button"
        class={cx("kit-file-picker-dropzone", dragging && "is-dragging")}
        disabled={disabled}
        aria-describedby={describedBy}
        onClick={() => inputRef.current?.click()}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          select(event.dataTransfer?.files?.[0]);
        }}
      >
        <Icon name="cloud-upload" />
        <span>{disabled ? busyLabel : dragging ? draggingLabel : idleLabel}</span>
        {!disabled && <span class="kit-file-picker-browse-label">{browseLabel}</span>}
      </button>
      <input
        ref={inputRef}
        class="kit-file-picker-input"
        type="file"
        accept={accept}
        tabIndex={-1}
        onChange={(event) => {
          const input = event.currentTarget;
          select(input.files?.[0]);
          input.value = "";
        }}
      />
      {error && <div id={errorId} class="kit-file-picker-error" role="alert">{error}</div>}
      {onCancel && (
        <div class="kit-file-picker-actions">
          <Button disabled={disabled} onClick={onCancel}>{cancelLabel}</Button>
        </div>
      )}
    </section>
  );
}
