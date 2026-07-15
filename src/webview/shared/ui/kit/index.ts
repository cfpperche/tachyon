/**
 * spec 342 — the Kit authoring API: house wrappers over vendored shadcn/Radix source (+ the pre-existing
 * legacy primitives, where a wrapper composes them instead). DISTINCT namespace from `shared/ui/index.ts`'s
 * legacy `Select`/`FieldRow` on purpose (F11) — new UI reaches for `kit/`, legacy migrates only with a
 * reason. See shared/ui/README.md's import matrix (T8).
 */
export { KitSelect, type KitSelectOption, type KitSelectProps } from "./KitSelect";
export { KitFieldRow } from "./KitFieldRow";
export { KitLabeledInput, type KitLabeledInputProps } from "./KitLabeledInput";
export {
  KitDropdown,
  KitDropdownTrigger,
  KitDropdownContent,
  KitDropdownItem,
  KitDropdownSeparator,
} from "./KitDropdown";
export {
  KitPopover,
  KitPopoverTrigger,
  KitPopoverContent,
  KitPopoverAnchor,
  KitPopoverHeader,
  KitPopoverTitle,
  KitPopoverDescription,
} from "./KitPopover";
export { KitFilePicker, type KitFilePickerProps } from "./KitFilePicker";
export { KIT_FLAGS } from "./flags";
