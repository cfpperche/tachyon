import { KitFilePicker } from "../shared/ui/kit";

interface ImageImportPickerProps {
  target: "pin" | "task";
  onFile(file: File): void | Promise<void>;
  onCancel(): void;
}

/** Shared in-webview image-import door for the Pin and Task rich-doc studios. */
export function ImageImportPicker({ target, onFile, onCancel }: ImageImportPickerProps) {
  return (
    <div class="rd-import-modal" role="dialog" aria-modal="true" aria-label={`Import image into ${target}`}>
      <KitFilePicker
        class="rd-import-picker"
        title={`Import image into ${target}`}
        description="PNG, JPEG, WebP, or GIF, up to 10 MB."
        accept="image/png,image/jpeg,image/webp,image/gif"
        idleLabel="Drop an image here"
        draggingLabel="Drop to import"
        browseLabel="or choose an image from your computer"
        onFile={onFile}
        onCancel={onCancel}
      />
    </div>
  );
}
